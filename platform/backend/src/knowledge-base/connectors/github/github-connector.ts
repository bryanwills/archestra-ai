import { Octokit } from "@octokit/rest";
import type pino from "pino";
import { resolveInstallationToken } from "@/integrations/github/app-auth";
import * as metrics from "@/observability/metrics";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  DocumentPermissions,
  DocumentPermissionsYield,
  GithubCheckpoint,
  GithubConfig,
  GroupMembershipYield,
  PermissionSyncParams,
} from "@/types";
import { GithubConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
  REQUEST_TIMEOUT_MS,
} from "../base-connector";

const BATCH_SIZE = 50;

export class GithubConnector extends BaseConnector {
  type = "github" as const;
  supportsPermissionSync = true;

  /** Per-pass cache of GitHub login → public email (or null when private). */
  private userEmailCache = new Map<string, string | null>();

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.validateConfigWithSchema({
      config,
      parser: parseGithubConfig,
      label: "GitHub",
      invalidConfigError:
        "Invalid GitHub configuration: githubUrl (string) and owner (string) are required",
      extraChecks: (parsed) => validateGithubConfig(parsed),
    });
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseGithubConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid GitHub configuration" };
    }

    return this.runConnectionTest({
      label: "GitHub",
      probe: async () => {
        const octokit = await createOctokit(
          parsed,
          params.credentials,
          this.log,
        );
        if (parsed.authMethod === "github_app") {
          await octokit.rest.apps.listReposAccessibleToInstallation({
            per_page: 1,
          });
          return;
        }
        await octokit.rest.users.getAuthenticated();
      },
    });
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseGithubConfig(params.config);
    if (!parsed) return null;

    // Repository file count cannot be estimated without fetching the full repo
    // tree, so skip estimation entirely when file syncing is enabled.
    if (parsed.includeRepositoryFiles) return null;

    this.log.debug(
      { owner: parsed.owner, repos: parsed.repos },
      "Estimating total items",
    );

    try {
      const octokit = await createOctokit(parsed, params.credentials, this.log);
      const repos = await getRepos(octokit, parsed);
      let total = 0;

      for (const repo of repos) {
        if (parsed.includeIssues !== false) {
          const result = await octokit.rest.search.issuesAndPullRequests({
            q: `repo:${repo.owner}/${repo.name} is:issue`,
            per_page: 1,
          });
          total += result.data.total_count;
        }

        if (parsed.includePullRequests !== false) {
          const result = await octokit.rest.search.issuesAndPullRequests({
            q: `repo:${repo.owner}/${repo.name} is:pr`,
            per_page: 1,
          });
          total += result.data.total_count;
        }

        await this.rateLimit();
      }

      return total;
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Failed to estimate total items",
      );
      return null;
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseGithubConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid GitHub configuration");
    }

    const checkpoint = (params.checkpoint as GithubCheckpoint | null) ?? {
      type: "github" as const,
    };
    const octokit = await createOctokit(parsed, params.credentials, this.log);
    const repos = await getRepos(octokit, parsed);

    this.log.debug(
      {
        baseUrl: parsed.githubUrl,
        owner: parsed.owner,
        repoCount: repos.length,
        includeIssues: parsed.includeIssues,
        includePullRequests: parsed.includePullRequests,
        checkpoint,
      },
      "Starting sync",
    );

    for (let repoIdx = 0; repoIdx < repos.length; repoIdx++) {
      const repo = repos[repoIdx];
      const isLastRepo = repoIdx === repos.length - 1;
      const hasRepositoryFiles = parsed.includeRepositoryFiles === true;

      if (parsed.includeIssues !== false) {
        yield* this.syncRepoItems({
          octokit,
          config: parsed,
          repo,
          checkpoint,
          kind: "issue",
          isLastGroup:
            isLastRepo &&
            parsed.includePullRequests === false &&
            !hasRepositoryFiles,
        });
      }

      if (parsed.includePullRequests !== false) {
        yield* this.syncRepoItems({
          octokit,
          config: parsed,
          repo,
          checkpoint,
          kind: "pr",
          isLastGroup: isLastRepo && !hasRepositoryFiles,
        });
      }

      if (hasRepositoryFiles) {
        yield* this.syncRepoFiles({
          octokit,
          config: parsed,
          repo,
          checkpoint,
          isLastGroup: isLastRepo,
        });
      }
    }
  }

  // ===== Private methods =====

  private async *syncRepoItems(params: {
    octokit: Octokit;
    config: GithubConfig;
    repo: GithubRepo;
    checkpoint: GithubCheckpoint;
    kind: "issue" | "pr";
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { octokit, config, repo, checkpoint, kind, isLastGroup } = params;
    let page = 1;
    let pageHasMore = true;

    this.log.debug(
      { repo: `${repo.owner}/${repo.name}`, kind },
      "Syncing repo items",
    );

    while (pageHasMore) {
      await this.rateLimit();

      let response: Awaited<ReturnType<typeof octokit.rest.issues.listForRepo>>;
      try {
        this.log.debug(
          { repo: `${repo.owner}/${repo.name}`, kind, page },
          "Fetching batch",
        );

        response = await octokit.rest.issues.listForRepo({
          owner: repo.owner,
          repo: repo.name,
          state: "all",
          per_page: BATCH_SIZE,
          page,
          sort: "updated",
          direction: "asc",
          ...(checkpoint.lastSyncedAt
            ? { since: checkpoint.lastSyncedAt }
            : {}),
        });
      } catch (err) {
        if (
          err instanceof Error &&
          "status" in err &&
          (err as Record<string, unknown>).status === 404
        ) {
          this.log.debug(
            { repo: `${repo.owner}/${repo.name}`, kind },
            "Repo not found or issues disabled, skipping",
          );
          break;
        }
        this.log.error(
          {
            repo: `${repo.owner}/${repo.name}`,
            kind,
            page,
            error: extractErrorMessage(err),
          },
          "Batch fetch failed",
        );
        throw err;
      }

      const items = response.data.filter((item) => {
        const isPr = !!item.pull_request;
        if (kind === "issue" && isPr) return false;
        if (kind === "pr" && !isPr) return false;
        return !shouldSkipItem(item, config.labelsToSkip);
      });

      const documents: ConnectorDocument[] = [];
      for (const item of items) {
        await this.rateLimit();
        const comments = await this.safeItemFetch({
          fetch: () => getItemComments(octokit, repo, item.number),
          fallback: [],
          itemId: item.number,
          resource: "comments",
        });
        documents.push(itemToDocument(item, comments, repo, kind));
      }

      pageHasMore = response.data.length >= BATCH_SIZE;
      page++;

      this.log.debug(
        {
          repo: `${repo.owner}/${repo.name}`,
          kind,
          itemCount: items.length,
          documentCount: documents.length,
          hasMore: pageHasMore || !isLastGroup,
        },
        "Batch fetched",
      );

      const lastItem = items.length > 0 ? items[items.length - 1] : null;

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: lastItem?.updated_at,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: pageHasMore || !isLastGroup,
      };
    }
  }
  private async *syncRepoFiles(params: {
    octokit: Octokit;
    config: GithubConfig;
    repo: GithubRepo;
    checkpoint: GithubCheckpoint;
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { octokit, config, repo, checkpoint, isLastGroup } = params;
    const repoFullName = `${repo.owner}/${repo.name}`;
    const indexedExtensions = getIndexedFileExtensions(config);

    this.log.info(
      { repo: repoFullName, indexedExtensions },
      "Starting repository file sync",
    );

    let treeSha: string;
    let branch: string;

    const branchCandidates = repo.defaultBranch
      ? [repo.defaultBranch]
      : FALLBACK_BRANCHES;

    const resolved = await resolveDefaultBranch(
      octokit,
      repo,
      branchCandidates,
      this.log,
    );

    if (!resolved) {
      this.log.error(
        { repo: repoFullName, triedBranches: branchCandidates },
        "Could not resolve default branch, skipping markdown sync",
      );
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    branch = resolved.branch;
    treeSha = resolved.sha;

    this.log.debug(
      { repo: repoFullName, branch, treeSha },
      "Fetching repository tree",
    );

    let treeItems: Array<{ path: string; sha: string }>;
    try {
      const treeResponse = await octokit.rest.git.getTree({
        owner: repo.owner,
        repo: repo.name,
        tree_sha: treeSha,
        recursive: "true",
      });
      const allItems = treeResponse.data.tree;
      treeItems = allItems
        .filter(
          (item) =>
            item.type === "blob" &&
            item.path &&
            isIndexedRepositoryFile(item.path, indexedExtensions) &&
            item.sha,
        )
        .map((item) => ({
          path: item.path as string,
          sha: item.sha as string,
        }));

      this.log.info(
        {
          repo: repoFullName,
          branch,
          totalTreeItems: allItems.length,
          fileCount: treeItems.length,
        },
        "Found repository files to index",
      );
    } catch (err) {
      this.log.error(
        {
          repo: repoFullName,
          branch,
          treeSha,
          error: extractErrorMessage(err),
        },
        "Failed to fetch repository tree, skipping file sync",
      );
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    if (treeItems.length === 0) {
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    for (let i = 0; i < treeItems.length; i += BATCH_SIZE) {
      const batch = treeItems.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(treeItems.length / BATCH_SIZE);
      const documents: ConnectorDocument[] = [];

      this.log.debug(
        {
          repo: repoFullName,
          branch,
          batch: batchNumber,
          totalBatches,
          batchSize: batch.length,
        },
        "Fetching repository file contents",
      );

      for (const file of batch) {
        await this.rateLimit();
        const content = await this.safeItemFetch({
          fetch: () => getFileContent(octokit, repo, file.path),
          fallback: null,
          itemId: file.path,
          resource: "file_content",
        });

        if (content !== null) {
          documents.push(
            repositoryFileToDocument(file.path, content, repo, branch),
          );
        }
      }

      const failures = this.flushFailures();
      const hasMoreFiles = i + BATCH_SIZE < treeItems.length;

      this.log.info(
        {
          repo: repoFullName,
          branch,
          batch: batchNumber,
          totalBatches,
          documentsIndexed: documents.length,
          failureCount: failures.length,
          hasMore: hasMoreFiles || !isLastGroup,
        },
        "Repository file batch completed",
      );

      yield {
        documents,
        failures,
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: hasMoreFiles || !isLastGroup,
      };
    }
  }

  // ===== Permission sync hooks =====

  /**
   * Repo-scoped audience. The ACL is resolved ONCE per repo (private/public +
   * collaborators + teams) and reused across every already-ingested document in
   * that repo (read-back form), so upstream calls are O(repos + collaborators),
   * not O(docs). Each yield's `cursor` is the repo key for crash-safe resume.
   */
  async *syncDocumentPermissions(
    params: PermissionSyncParams,
  ): AsyncGenerator<DocumentPermissionsYield> {
    const config = parseGithubConfig(params.config);
    if (!config) {
      throw new Error("Invalid GitHub configuration for permission sync");
    }
    const octokit = await createOctokit(config, params.credentials, this.log);
    const repos = await getRepos(octokit, config);
    // Stable order so the resume cursor (a repo key) is monotonic.
    const sorted = [...repos].sort((a, b) =>
      githubRepoKey(a).localeCompare(githubRepoKey(b)),
    );

    for (const repo of sorted) {
      const repoKey = githubRepoKey(repo);
      // Resume: repos strictly before the cursor are already done. The cursor
      // repo is re-processed (idempotent — same ACL) since a flush may have
      // landed mid-repo.
      if (params.cursor && repoKey < params.cursor) continue;

      const permissions = await this.resolveRepoAudience(octokit, repo);

      let afterId: string | null = null;
      for (;;) {
        const { documents, nextAfterId } = await params.readIngestedDocuments({
          metadataFilter: { repo: repoKey },
          afterId,
          limit: GITHUB_READBACK_PAGE_SIZE,
        });
        for (const doc of documents) {
          yield { sourceId: doc.sourceId, permissions, cursor: repoKey };
        }
        if (documents.length < GITHUB_READBACK_PAGE_SIZE) break;
        afterId = nextAfterId;
      }
    }
  }

  /**
   * Org teams → member emails, across every org that owns a synced repo. Group
   * ids are namespaced `<org>/<team-slug>` to match the tokens written on
   * documents (see resolveRepoAudience).
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseGithubConfig(params.config);
    if (!config) {
      throw new Error("Invalid GitHub configuration for permission sync");
    }
    const octokit = await createOctokit(config, params.credentials, this.log);
    const repos = await getRepos(octokit, config);
    const orgs = [...new Set(repos.map((repo) => repo.owner))].sort();

    for (const org of orgs) {
      for await (const team of this.paginate((page) =>
        octokit.rest.teams
          .list({ org, per_page: 100, page })
          .then((response) => response.data),
      )) {
        const memberEmails: string[] = [];
        for await (const member of this.paginate((page) =>
          octokit.rest.teams
            .listMembersInOrg({
              org,
              team_slug: team.slug,
              per_page: 100,
              page,
            })
            .then((response) => response.data),
        )) {
          const email = await this.resolveUserEmail(octokit, member.login);
          if (email) memberEmails.push(email);
        }
        yield {
          groupId: githubGroupId(org, team.slug),
          memberEmails,
          cursor: `${org}/${team.slug}`,
        };
      }
    }
  }

  private async resolveRepoAudience(
    octokit: Octokit,
    repo: GithubRepo,
  ): Promise<DocumentPermissions> {
    await this.rateLimit();
    const meta = await octokit.rest.repos.get({
      owner: repo.owner,
      repo: repo.name,
    });
    const isPublic = !meta.data.private;

    const users: string[] = [];
    let dropped = 0;
    for await (const collaborator of this.paginate((page) =>
      octokit.rest.repos
        .listCollaborators({
          owner: repo.owner,
          repo: repo.name,
          per_page: 100,
          page,
        })
        .then((response) => response.data),
    )) {
      const email = await this.resolveUserEmail(octokit, collaborator.login);
      if (email) users.push(email);
      else dropped++;
    }
    this.meterDroppedPrincipals(dropped);

    const groups: string[] = [];
    for await (const team of this.paginate((page) =>
      octokit.rest.repos
        .listTeams({
          owner: repo.owner,
          repo: repo.name,
          per_page: 100,
          page,
        })
        .then((response) => response.data),
    )) {
      groups.push(githubGroupId(repo.owner, team.slug));
    }

    return { isPublic, users, groups };
  }

  /**
   * Meter upstream principals dropped because their email could not be resolved
   * (private GitHub email). Fail-closed under-grant — surfaced so admins see the
   * coverage gap rather than silently narrowing an audience.
   */
  private meterDroppedPrincipals(count: number): void {
    if (count <= 0) return;
    this.log.debug(
      { count, connectorType: this.type },
      "Dropped GitHub principals with no resolvable email (fail-closed)",
    );
    metrics.rag.reportPermissionSyncDroppedPrincipals({
      connectorType: this.type,
      reason: "no_email",
      count,
    });
  }

  /**
   * Resolve a login to its public email (per-pass cached). GitHub only exposes
   * an email when the user has made it public — otherwise the principal can't be
   * matched and is fail-closed (documented limitation).
   */
  private async resolveUserEmail(
    octokit: Octokit,
    login: string,
  ): Promise<string | null> {
    const cached = this.userEmailCache.get(login);
    if (cached !== undefined) return cached;
    let email: string | null = null;
    try {
      await this.rateLimit();
      const response = await octokit.rest.users.getByUsername({
        username: login,
      });
      email = response.data.email ?? null;
    } catch (error) {
      this.log.debug(
        { login, error: extractErrorMessage(error) },
        "Could not resolve GitHub user email",
      );
    }
    this.userEmailCache.set(login, email);
    return email;
  }

  /** Rate-limited generic pager over a 100-per-page GitHub list endpoint. */
  private async *paginate<T>(
    fetchPage: (page: number) => Promise<T[]>,
  ): AsyncGenerator<T> {
    let page = 1;
    for (;;) {
      await this.rateLimit();
      const items = await fetchPage(page);
      for (const item of items) yield item;
      if (items.length < 100) break;
      page++;
    }
  }
}

// ===== Module-level helpers =====

const GITHUB_READBACK_PAGE_SIZE = 200;

function githubItemSourceId(repoName: string, itemNumber: number): string {
  return `${repoName}#${itemNumber}`;
}

function githubFileSourceId(repoName: string, filePath: string): string {
  return `${repoName}#file:${filePath}`;
}

function githubRepoKey(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}

/**
 * Namespace a team by its org so team slugs never collide across orgs. Written
 * on documents and stored by syncGroups identically, so the group data-contract
 * byte-matches.
 */
function githubGroupId(org: string, teamSlug: string): string {
  return `${org}/${teamSlug}`;
}

async function createOctokit(
  config: GithubConfig,
  credentials: ConnectorCredentials,
  log: pino.Logger,
): Promise<Octokit> {
  const nativeFetch = globalThis.fetch;
  const auth = await resolveGithubAuthToken(config, credentials, nativeFetch);
  return new Octokit({
    auth,
    baseUrl: resolveGithubApiUrl(config, credentials).replace(/\/+$/, ""),
    log: {
      debug: (message: string) =>
        log.debug({ sdkMessage: message }, "SDK debug"),
      info: (message: string) => log.debug({ sdkMessage: message }, "SDK info"),
      warn: (message: string) =>
        log.warn({ sdkMessage: message }, "SDK warning"),
      error: (message: string) =>
        log.error({ sdkMessage: message }, "SDK error"),
    },
    request: {
      fetch: (url: string | URL | Request, init?: RequestInit) =>
        nativeFetch(url, {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
    },
  });
}

// the App config owns the host its installation token is minted against, so
// App-auth connectors must talk to that host regardless of config.githubUrl
function resolveGithubApiUrl(
  config: GithubConfig,
  credentials: ConnectorCredentials,
): string {
  if (config.authMethod === "github_app" && credentials.githubApp) {
    return credentials.githubApp.githubUrl;
  }
  return config.githubUrl;
}

async function resolveGithubAuthToken(
  config: GithubConfig,
  credentials: ConnectorCredentials,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (config.authMethod !== "github_app") {
    return credentials.apiToken;
  }

  const app = credentials.githubApp;
  if (!app) {
    throw new Error(
      "GitHub App credentials were not resolved for this connector",
    );
  }

  return resolveInstallationToken(
    {
      githubUrl: app.githubUrl,
      appId: app.appId,
      installationId: app.installationId,
      privateKey: credentials.apiToken,
    },
    fetchImpl,
  );
}

function parseGithubConfig(
  config: Record<string, unknown>,
): GithubConfig | null {
  const result = GithubConfigSchema.safeParse({ type: "github", ...config });
  return result.success ? result.data : null;
}

function validateGithubConfig(config: GithubConfig): string | null {
  if (!/^https?:\/\/.+/.test(config.githubUrl)) {
    return "githubUrl must be a valid HTTP(S) URL";
  }

  if (config.authMethod === "github_app" && !config.githubAppConfigId) {
    return "GitHub App authentication requires githubAppConfigId";
  }

  return null;
}

type GithubRepo = {
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string | null;
};

async function getRepos(
  octokit: Octokit,
  config: GithubConfig,
): Promise<GithubRepo[]> {
  if (config.repos && config.repos.length > 0) {
    const repos: GithubRepo[] = [];
    for (const name of config.repos) {
      let defaultBranch: string | null = null;
      try {
        const response = await octokit.rest.repos.get({
          owner: config.owner,
          repo: name,
        });
        defaultBranch = response.data.default_branch;
      } catch {
        // If we can't fetch repo metadata, fall back to null (main→master fallback)
      }
      repos.push({
        owner: config.owner,
        name,
        htmlUrl: `${config.githubUrl.replace(/\/api\/v3$/, "").replace(/\/+$/, "")}/${config.owner}/${name}`,
        defaultBranch,
      });
    }
    return repos;
  }

  const repos: GithubRepo[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    if (config.authMethod === "github_app") {
      const response =
        await octokit.rest.apps.listReposAccessibleToInstallation({
          per_page: 100,
          page,
        });

      for (const repo of response.data.repositories) {
        repos.push({
          owner: repo.owner?.login ?? config.owner,
          name: repo.name,
          htmlUrl: repo.html_url,
          defaultBranch: repo.default_branch ?? null,
        });
      }

      hasMore = response.data.repositories.length >= 100;
    } else {
      const response = await octokit.rest.repos.listForOrg({
        org: config.owner,
        per_page: 100,
        page,
        type: "all",
      });

      for (const repo of response.data) {
        repos.push({
          owner: config.owner,
          name: repo.name,
          htmlUrl: repo.html_url,
          defaultBranch: repo.default_branch ?? null,
        });
      }

      hasMore = response.data.length >= 100;
    }

    page++;
  }

  return repos;
}

const FALLBACK_BRANCHES = ["main", "master", "dev", "develop"];

async function resolveDefaultBranch(
  octokit: Octokit,
  repo: { owner: string; name: string },
  candidates: string[],
  log: pino.Logger,
): Promise<{ branch: string; sha: string } | null> {
  const repoFullName = `${repo.owner}/${repo.name}`;
  for (const candidate of candidates) {
    try {
      log.debug(
        { repo: repoFullName, branch: candidate },
        "Resolving branch ref",
      );
      const refResponse = await octokit.rest.git.getRef({
        owner: repo.owner,
        repo: repo.name,
        ref: `heads/${candidate}`,
      });
      log.debug(
        {
          repo: repoFullName,
          branch: candidate,
          sha: refResponse.data.object.sha,
        },
        "Resolved branch ref",
      );
      return { branch: candidate, sha: refResponse.data.object.sha };
    } catch (err) {
      log.info(
        {
          repo: repoFullName,
          branch: candidate,
          error: extractErrorMessage(err),
        },
        "Branch not found, trying next candidate",
      );
    }
  }
  return null;
}

async function getItemComments(
  octokit: Octokit,
  repo: { owner: string; name: string },
  issueNumber: number,
): Promise<Array<{ author: string; body: string; date: string }>> {
  const response = await octokit.rest.issues.listComments({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    per_page: 100,
  });

  return response.data.map((c) => ({
    author: c.user?.login ?? "unknown",
    body: c.body ?? "",
    date: c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : "",
  }));
}

// biome-ignore lint/suspicious/noExplicitAny: GitHub API response types
function shouldSkipItem(item: any, labelsToSkip?: string[]): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  const itemLabels: string[] = (item.labels ?? []).map(
    // biome-ignore lint/suspicious/noExplicitAny: GitHub label shape
    (l: any) => (typeof l === "string" ? l : (l.name ?? "")),
  );
  return itemLabels.some((label) => labelsToSkip.includes(label));
}

const DEFAULT_REPOSITORY_FILE_EXTENSIONS = [".md", ".mdx", ".yaml", ".yml"];

function getIndexedFileExtensions(config: GithubConfig): string[] {
  const extensions =
    config.fileTypes && config.fileTypes.length > 0
      ? config.fileTypes
      : DEFAULT_REPOSITORY_FILE_EXTENSIONS;

  return extensions
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
}

function isIndexedRepositoryFile(path: string, extensions: string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

async function getFileContent(
  octokit: Octokit,
  repo: { owner: string; name: string },
  path: string,
): Promise<string> {
  const response = await octokit.rest.repos.getContent({
    owner: repo.owner,
    repo: repo.name,
    path,
  });

  const data = response.data;
  if (!("content" in data) || !data.content) {
    throw new Error(`No content returned for ${path}`);
  }

  return Buffer.from(data.content, "base64").toString("utf-8");
}

function repositoryFileToDocument(
  filePath: string,
  content: string,
  repo: { owner: string; name: string; htmlUrl: string },
  branch: string,
): ConnectorDocument {
  const fileName = filePath.split("/").pop() ?? filePath;
  return {
    id: githubFileSourceId(repo.name, filePath),
    title: `${fileName} (${repo.owner}/${repo.name})`,
    content,
    sourceUrl: `${repo.htmlUrl}/blob/${branch}/${filePath}`,
    metadata: {
      repo: `${repo.owner}/${repo.name}`,
      filePath,
      kind: "repository_file",
      fileKind: "repository_file",
    },
  };
}

function itemToDocument(
  // biome-ignore lint/suspicious/noExplicitAny: GitHub API response types
  item: any,
  comments: Array<{ author: string; body: string; date: string }>,
  repo: { owner: string; name: string; htmlUrl: string },
  kind: "issue" | "pr",
): ConnectorDocument {
  const prefix = kind === "pr" ? "Pull Request" : "Issue";
  const contentParts = [`# ${prefix}: ${item.title}`, "", item.body ?? ""];

  const nonEmptyComments = comments.filter((c) => c.body.trim());
  if (nonEmptyComments.length > 0) {
    contentParts.push("", "## Comments", "");
    for (const c of nonEmptyComments) {
      contentParts.push(`**${c.author}** (${c.date}): ${c.body}`);
    }
  }

  return {
    id: githubItemSourceId(repo.name, item.number),
    title: `${item.title} (${repo.owner}/${repo.name}#${item.number})`,
    content: contentParts.join("\n"),
    sourceUrl: item.html_url,
    metadata: {
      repo: `${repo.owner}/${repo.name}`,
      number: item.number,
      state: item.state,
      kind,
      labels: (item.labels ?? []).map(
        // biome-ignore lint/suspicious/noExplicitAny: GitHub label shape
        (l: any) => (typeof l === "string" ? l : (l.name ?? "")),
      ),
      author: item.user?.login,
    },
    updatedAt: item.updated_at ? new Date(item.updated_at) : undefined,
  };
}

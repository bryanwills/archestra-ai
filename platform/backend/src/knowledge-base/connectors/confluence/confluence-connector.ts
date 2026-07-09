import * as cheerio from "cheerio";
import { ConfluenceClient } from "confluence.js";
import type pino from "pino";
import type {
  ConfluenceCheckpoint,
  ConfluenceConfig,
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  DocumentPermissions,
  DocumentPermissionsYield,
  GroupMembershipYield,
  GroupMemberYield,
  PermissionSyncParams,
} from "@/types";

/** Read restriction subjects for one Confluence content id. */
type ConfluenceRestriction = {
  // biome-ignore lint/suspicious/noExplicitAny: SDK subject shape
  users: any[];
  // biome-ignore lint/suspicious/noExplicitAny: SDK subject shape
  groups: any[];
};

import * as metrics from "@/observability/metrics";
import { ConfluenceConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const DEFAULT_BATCH_SIZE = 50;

/**
 * Built-in Confluence groups that mean "any logged-in user" (Cloud:
 * `confluence-users` / `_licensed-confluence`; Server/DC: `users`). A read grant
 * to one of these is not a normal named group — it is "every authenticated
 * user" — so it is mapped to the synthetic all-members group below.
 */
const CONFLUENCE_ALL_LOGGED_IN_GROUP_NAMES = new Set([
  "confluence-users",
  "_licensed-confluence",
  "users",
]);

/**
 * Stable synthetic group id modelling the "any logged-in user" audience. Its
 * membership (emitted by `syncGroups`) is the union of every resolvable member
 * across the instance's real groups, so a page/space readable by all
 * authenticated users resolves to those members without depending on a built-in
 * group being separately enumerable. Namespaced by the connector type into
 * `group:confluence_confluence-any-logged-in-user` like any other group token.
 */
const CONFLUENCE_ANY_LOGGED_IN_USER_GROUP_ID = "confluence-any-logged-in-user";

export class ConfluenceConnector extends BaseConnector {
  type = "confluence" as const;
  supportsPermissionSync = true;

  // Per-pass caches so audience resolution is O(containers), not O(pages):
  // space audiences, content read-restrictions (pages + ancestors), and
  // account → email lookups are each resolved once.
  private spaceAudienceCache = new Map<string, DocumentPermissions>();
  private restrictionCache = new Map<string, ConfluenceRestriction | null>();
  private accountEmailCache = new Map<string, string | null>();

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseConfluenceConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid Confluence configuration: confluenceUrl (string) and isCloud (boolean) are required",
      };
    }

    if (!/^https?:\/\/.+/.test(parsed.confluenceUrl)) {
      return {
        valid: false,
        error: "confluenceUrl must be a valid HTTP(S) URL",
      };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Confluence configuration" };
    }

    this.log.debug(
      { baseUrl: parsed.confluenceUrl, isCloud: parsed.isCloud },
      "Testing connection",
    );

    try {
      const client = createConfluenceClient(
        parsed,
        params.credentials,
        this.log,
      );
      await client.space.getSpaces({ limit: 1 });
      this.log.debug("Connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint = (params.checkpoint as ConfluenceCheckpoint | null) ?? {
        type: "confluence" as const,
      };
      const cql = buildCql(parsed, checkpoint);

      this.log.debug({ cql }, "Estimating total items");

      const client = createConfluenceClient(
        parsed,
        params.credentials,
        this.log,
      );

      const result = await client.content.searchContentByCQL({
        cql,
        limit: 1,
      });

      // Server/DC returns totalSize in the response; Cloud does not.
      // biome-ignore lint/suspicious/noExplicitAny: SDK type missing totalSize field
      const rawResult = result as any;
      const totalSize = rawResult.totalSize as number | undefined;

      this.log.debug(
        { totalSize, size: rawResult.size, start: rawResult.start },
        "Estimate response",
      );

      return totalSize ?? null;
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
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Confluence configuration");
    }

    const checkpoint = (params.checkpoint as ConfluenceCheckpoint | null) ?? {
      type: "confluence" as const,
    };
    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const cql = buildCql(parsed, checkpoint, params.startTime);
    const client = createConfluenceClient(parsed, params.credentials, this.log);

    this.log.debug(
      {
        baseUrl: parsed.confluenceUrl,
        isCloud: parsed.isCloud,
        spaceKeys: parsed.spaceKeys,
        cql,
        checkpoint,
      },
      "Starting sync",
    );

    let cursor: string | undefined;
    let start = 0;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        this.log.debug({ batchIndex, cursor, start }, "Fetching batch");

        // biome-ignore lint/suspicious/noExplicitAny: SDK response type
        let searchResult: any;

        if (parsed.isCloud) {
          // Cloud: cursor-based pagination via SDK
          searchResult = await client.content.searchContentByCQL({
            cql,
            cursor,
            limit: batchSize,
            expand: ["body.storage", "version", "space", "metadata.labels"],
          });
        } else {
          // Server/DC: offset-based pagination — the SDK's searchContentByCQL
          // doesn't accept a 'start' param, so use sendRequest directly.
          searchResult = await client.sendRequest(
            {
              url: "/api/content/search",
              method: "GET",
              params: {
                cql,
                start,
                limit: batchSize,
                expand: ["body.storage", "version", "space", "metadata.labels"],
              },
            },
            // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
            undefined as any,
          );
        }

        const results = searchResult.results ?? [];
        const documents: ConnectorDocument[] = [];

        for (const page of results) {
          if (shouldSkipPage(page, parsed.labelsToSkip)) {
            continue;
          }

          documents.push(
            pageToDocument(page, parsed.confluenceUrl, parsed.isCloud),
          );
        }

        const nextUrl: string | undefined = searchResult._links?.next;

        if (parsed.isCloud) {
          // Cloud: extract cursor from _links.next
          if (nextUrl) {
            const cursorMatch = nextUrl.match(/cursor=([^&]+)/);
            cursor = cursorMatch
              ? decodeURIComponent(cursorMatch[1])
              : undefined;
          } else {
            cursor = undefined;
          }
          hasMore = results.length >= batchSize && !!cursor;
        } else {
          // Server/DC: increment offset by actual results count.
          // Confluence may return fewer results than requested due to server
          // limits, so we rely on _links.next presence rather than count.
          start += results.length;
          hasMore = results.length > 0 && !!nextUrl;
        }

        const lastPage = results[results.length - 1];
        const rawModifiedAt: string | undefined = lastPage?.version?.when;

        this.log.debug(
          {
            batchIndex,
            pageCount: results.length,
            documentCount: documents.length,
            hasMore,
          },
          "Batch fetched",
        );

        batchIndex++;
        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "confluence",
            itemUpdatedAt: rawModifiedAt,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: {
              lastPageId: lastPage?.id ?? checkpoint.lastPageId,
              lastRawModifiedAt: rawModifiedAt ?? checkpoint.lastRawModifiedAt,
            },
          }),
          hasMore,
        };
      } catch (error) {
        this.log.error(
          { batchIndex, error: extractErrorMessage(error) },
          "Batch fetch failed",
        );
        throw error;
      }
    }
  }

  // ===== Permission sync hooks =====

  /**
   * Per-page audience: page read-restrictions closest-first (the page, then its
   * ancestors), falling back to the space's read permissions. A restricted page
   * is visible only to its restriction's users/groups; an unrestricted page
   * inherits the space audience. Restriction/space/email lookups are cached, so
   * upstream calls are ~1 per page plus O(spaces) + O(distinct principals).
   */
  async *syncDocumentPermissions(
    params: PermissionSyncParams,
  ): AsyncGenerator<DocumentPermissionsYield> {
    const config = parseConfluenceConfig(params.config);
    if (!config) {
      throw new Error("Invalid Confluence configuration for permission sync");
    }
    const client = createConfluenceClient(config, params.credentials, this.log);
    const cql = buildCql(config, {
      type: "confluence",
      lastSyncedAt: undefined,
    });

    let cursor: string | undefined =
      params.cursor === null ? undefined : params.cursor;
    let start = 0;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();
      // biome-ignore lint/suspicious/noExplicitAny: SDK response type
      let searchResult: any;
      if (config.isCloud) {
        searchResult = await client.content.searchContentByCQL({
          cql,
          cursor,
          limit: DEFAULT_BATCH_SIZE,
          expand: ["space", "ancestors"],
        });
      } else {
        searchResult = await client.sendRequest(
          {
            url: "/api/content/search",
            method: "GET",
            params: {
              cql,
              start,
              limit: DEFAULT_BATCH_SIZE,
              expand: ["space", "ancestors"],
            },
          },
          // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
          undefined as any,
        );
      }

      // biome-ignore lint/suspicious/noExplicitAny: SDK page shape
      const results: any[] = searchResult.results ?? [];
      for (const page of results) {
        const permissions = await this.resolvePageAudience(client, page);
        yield { sourceId: String(page.id), permissions, cursor };
      }

      const nextUrl: string | undefined = searchResult._links?.next;
      if (config.isCloud) {
        const match = nextUrl?.match(/cursor=([^&]+)/);
        cursor = match ? decodeURIComponent(match[1]) : undefined;
        hasMore = results.length >= DEFAULT_BATCH_SIZE && !!cursor;
      } else {
        start += results.length;
        hasMore = results.length > 0 && !!nextUrl;
      }
    }
  }

  /**
   * Confluence groups → members. Group ids are the group name, matching
   * the `group.name` written on documents from read-restrictions.
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseConfluenceConfig(params.config);
    if (!config) {
      throw new Error("Invalid Confluence configuration for permission sync");
    }
    const client = createConfluenceClient(config, params.credentials, this.log);

    // Accumulate every member across all real groups so the synthetic
    // "any logged-in user" group (emitted last) can grant a doc readable by all
    // authenticated users. Built-in all-users groups are folded into the
    // synthetic id rather than stored under their raw name.
    const allMembers = new Map<string, GroupMemberYield>();

    for await (const group of this.paginate(client, "/api/group")) {
      const members: GroupMemberYield[] = [];
      for await (const member of this.paginate(
        client,
        `/api/group/member?name=${encodeURIComponent(group.name)}`,
      )) {
        // Every member is recorded; a hidden email yields `email: null`
        // (fail-closed at resolution, visible to admins as unresolvable).
        const accountId =
          member?.accountId ?? member?.username ?? member?.userKey;
        if (!accountId) continue; // no stable identity at all — nothing to record
        const email = await this.resolveConfluenceEmail(client, member);
        const entry: GroupMemberYield = {
          accountId: String(accountId),
          displayName: member?.displayName ?? member?.publicName ?? null,
          email,
        };
        members.push(entry);
        allMembers.set(entry.accountId, entry);
      }
      const groupId = this.mapConfluenceGroupName(group.name);
      yield { groupId, members, cursor: group.name };
    }

    // Synthetic all-members group: models "any logged-in user". Fail-closed —
    // only members whose email actually resolved are granted access; the rest
    // are recorded as unresolvable.
    yield {
      groupId: CONFLUENCE_ANY_LOGGED_IN_USER_GROUP_ID,
      members: [...allMembers.values()],
      cursor: CONFLUENCE_ANY_LOGGED_IN_USER_GROUP_ID,
    };
  }

  /**
   * Fold Confluence's built-in "any logged-in user" groups into the stable
   * synthetic group id so the audience resolves to every member; ordinary named
   * groups pass through unchanged.
   */
  private mapConfluenceGroupName(name: string): string {
    return CONFLUENCE_ALL_LOGGED_IN_GROUP_NAMES.has(name)
      ? CONFLUENCE_ANY_LOGGED_IN_USER_GROUP_ID
      : name;
  }

  private async resolvePageAudience(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    // biome-ignore lint/suspicious/noExplicitAny: SDK page shape
    page: any,
  ): Promise<DocumentPermissions> {
    // 1. The page's own read restrictions.
    const own = await this.getReadRestrictions(client, String(page.id));
    if (own) return this.restrictionToAudience(client, own);

    // 2. Ancestors, closest-first (the array is root→parent, so reverse).
    // biome-ignore lint/suspicious/noExplicitAny: SDK ancestor shape
    const ancestors: any[] = [...(page.ancestors ?? [])].reverse();
    for (const ancestor of ancestors) {
      const restriction = await this.getReadRestrictions(
        client,
        String(ancestor.id),
      );
      if (restriction) return this.restrictionToAudience(client, restriction);
    }

    // 3. Space read permissions (cached per space).
    return this.resolveSpaceAudience(client, page.space?.key);
  }

  private async restrictionToAudience(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    restriction: ConfluenceRestriction,
  ): Promise<DocumentPermissions> {
    const users: string[] = [];
    let dropped = 0;
    for (const user of restriction.users) {
      const email = await this.resolveConfluenceEmail(client, user);
      if (email) users.push(email);
      else dropped++;
    }
    this.meterDroppedPrincipals(dropped);
    const groups = restriction.groups
      .map((group) => group.name as string)
      .filter(Boolean)
      .map((name) => this.mapConfluenceGroupName(name));
    return { isPublic: false, users, groups };
  }

  /**
   * Meter upstream principals dropped because their email could not be resolved
   * (Cloud email privacy). Fail-closed under-grant — surfaced so admins see the
   * coverage gap rather than silently narrowing an audience.
   */
  private meterDroppedPrincipals(count: number): void {
    if (count <= 0) return;
    this.log.debug(
      { count, connectorType: this.type },
      "Dropped Confluence principals with no resolvable email (fail-closed)",
    );
    metrics.rag.reportPermissionSyncDroppedPrincipals({
      connectorType: this.type,
      reason: "no_email",
      count,
    });
  }

  private async getReadRestrictions(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    contentId: string,
  ): Promise<ConfluenceRestriction | null> {
    const cached = this.restrictionCache.get(contentId);
    if (cached !== undefined) return cached;

    let restriction: ConfluenceRestriction | null = null;
    try {
      await this.rateLimit();
      const response = await client.sendRequest(
        {
          url: `/api/content/${contentId}/restriction/byOperation/read`,
          method: "GET",
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
        undefined as any,
      );
      const users = response?.restrictions?.user?.results ?? [];
      const groups = response?.restrictions?.group?.results ?? [];
      restriction =
        users.length > 0 || groups.length > 0 ? { users, groups } : null;
    } catch (error) {
      this.log.debug(
        { contentId, error: extractErrorMessage(error) },
        "Could not read content restrictions",
      );
    }
    this.restrictionCache.set(contentId, restriction);
    return restriction;
  }

  private async resolveSpaceAudience(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    spaceKey: string | undefined,
  ): Promise<DocumentPermissions> {
    if (!spaceKey) return {}; // no space → fail-closed
    const cached = this.spaceAudienceCache.get(spaceKey);
    if (cached) return cached;

    // Reading space read-permission subjects requires space-admin scope; when it
    // is unavailable the page is fail-closed (documented limitation).
    let audience: DocumentPermissions = {};
    try {
      await this.rateLimit();
      const space = await client.sendRequest(
        {
          url: `/api/space/${spaceKey}`,
          method: "GET",
          params: { expand: "permissions" },
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
        undefined as any,
      );
      // biome-ignore lint/suspicious/noExplicitAny: SDK permission shape
      const permissions: any[] = space?.permissions ?? [];
      const users: string[] = [];
      const groups: string[] = [];
      let isPublic = false;
      let dropped = 0;
      for (const permission of permissions) {
        const operation =
          permission?.operation?.operation ?? permission?.operationKey;
        if (operation !== "read" && operation !== "use") continue;
        if (permission?.anonymousAccess) isPublic = true;
        for (const user of permission?.subjects?.user?.results ?? []) {
          const email = await this.resolveConfluenceEmail(client, user);
          if (email) users.push(email);
          else dropped++;
        }
        for (const group of permission?.subjects?.group?.results ?? []) {
          if (group?.name) groups.push(this.mapConfluenceGroupName(group.name));
        }
      }
      this.meterDroppedPrincipals(dropped);
      audience = { isPublic, users, groups };
    } catch (error) {
      this.log.debug(
        { spaceKey, error: extractErrorMessage(error) },
        "Could not read space permissions; page is fail-closed",
      );
    }
    this.spaceAudienceCache.set(spaceKey, audience);
    return audience;
  }

  /**
   * Resolve a Confluence principal to an email. Cloud largely hides emails
   * (privacy) — an unresolved principal is fail-closed (documented limitation).
   */
  private async resolveConfluenceEmail(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    // biome-ignore lint/suspicious/noExplicitAny: SDK subject shape
    user: any,
  ): Promise<string | null> {
    const direct = user?.email ?? user?.emailAddress ?? null;
    if (direct) return direct;
    const key = user?.accountId ?? user?.username ?? user?.userKey;
    if (!key) return null;
    if (this.accountEmailCache.has(key)) {
      return this.accountEmailCache.get(key) ?? null;
    }
    let email: string | null = null;
    try {
      await this.rateLimit();
      const params = user?.accountId
        ? { accountId: user.accountId }
        : { username: key };
      const response = await client.sendRequest(
        { url: "/api/user", method: "GET", params },
        // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
        undefined as any,
      );
      email = response?.email ?? response?.emailAddress ?? null;
    } catch (error) {
      this.log.debug(
        { key, error: extractErrorMessage(error) },
        "Could not resolve Confluence user email",
      );
    }
    this.accountEmailCache.set(key, email);
    return email;
  }

  /** Rate-limited pager over a Confluence `results`-shaped list endpoint. */
  private async *paginate(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    path: string,
    // biome-ignore lint/suspicious/noExplicitAny: SDK result shape
  ): AsyncGenerator<any> {
    let start = 0;
    const limit = 200;
    const separator = path.includes("?") ? "&" : "?";
    for (;;) {
      await this.rateLimit();
      const response = await client.sendRequest(
        {
          url: `${path}${separator}limit=${limit}&start=${start}`,
          method: "GET",
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
        undefined as any,
      );
      // biome-ignore lint/suspicious/noExplicitAny: SDK result shape
      const results: any[] = response?.results ?? [];
      for (const item of results) yield item;
      if (results.length < limit) break;
      start += results.length;
    }
  }
}

// ===== Module-level helpers =====

function createConfluenceClient(
  config: ConfluenceConfig,
  credentials: ConnectorCredentials,
  log: pino.Logger,
) {
  const host = config.confluenceUrl.replace(/\/+$/, "");
  return new ConfluenceClient({
    host,
    noCheckAtlassianToken: true,
    authentication: credentials.email
      ? { basic: { email: credentials.email, apiToken: credentials.apiToken } }
      : { oauth2: { accessToken: credentials.apiToken } },
    apiPrefix: config.isCloud ? "/wiki/rest/" : "/rest/",
    middlewares: {
      onError: (error: unknown) => {
        // biome-ignore lint/suspicious/noExplicitAny: Axios error shape
        const err = error as any;
        log.debug(
          {
            status: err?.response?.status,
            method: err?.config?.method?.toUpperCase(),
            url: err?.config?.url,
            error: err?.message ?? String(error),
          },
          "HTTP error",
        );
      },
      onResponse: (response: unknown) => {
        // biome-ignore lint/suspicious/noExplicitAny: Axios response shape
        const res = response as any;
        log.debug(
          {
            status: res?.status,
            method: res?.config?.method?.toUpperCase(),
            url: res?.config?.url,
          },
          "HTTP response",
        );
      },
    },
  });
}

function parseConfluenceConfig(
  config: Record<string, unknown>,
): ConfluenceConfig | null {
  const result = ConfluenceConfigSchema.safeParse({
    type: "confluence",
    ...config,
  });
  return result.success ? result.data : null;
}

function buildCql(
  config: ConfluenceConfig,
  checkpoint: ConfluenceCheckpoint,
  startTime?: Date,
): string {
  const clauses: string[] = ["type = page"];

  if (config.spaceKeys && config.spaceKeys.length > 0) {
    const spaceList = config.spaceKeys.map((k) => `"${k}"`).join(", ");
    clauses.push(`space IN (${spaceList})`);
  }

  if (config.pageIds && config.pageIds.length > 0) {
    const idList = config.pageIds.map((id) => `"${id}"`).join(", ");
    clauses.push(`content = (${idList})`);
  }

  if (config.cqlQuery) {
    clauses.push(`(${config.cqlQuery})`);
  }

  // Prefer the raw Confluence timestamp (includes timezone offset) so the CQL date
  // is formatted in the user's local timezone.  Fall back to UTC lastSyncedAt for
  // backward compatibility with old checkpoints — subtract 1 day as safety buffer
  // to account for unknown timezone offsets (CQL uses day-level precision).
  const rawTimestamp = checkpoint.lastRawModifiedAt;
  if (rawTimestamp) {
    const cqlDate = formatCqlLocalDate(rawTimestamp);
    clauses.push(`lastModified >= "${cqlDate}"`);
  } else {
    const syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
    if (syncFrom) {
      const cqlDate = formatCqlDateWithSafetyBuffer(syncFrom);
      clauses.push(`lastModified >= "${cqlDate}"`);
    }
  }

  return `${clauses.join(" AND ")} ORDER BY lastModified ASC`;
}

/**
 * Extract the LOCAL date from an ISO 8601 timestamp with timezone offset.
 * CQL interprets date literals in the authenticating user's timezone.
 * @public — exported for testability
 */
export function formatCqlLocalDate(rawTimestamp: string): string {
  const match = rawTimestamp.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const d = new Date(rawTimestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Format a UTC ISO timestamp for CQL, subtracting 1 day to account for
 * timezone offsets. CQL uses day precision so 1 day buffer is sufficient.
 * Used only for old checkpoints that lack `lastRawModifiedAt`.
 */
function formatCqlDateWithSafetyBuffer(isoDate: string): string {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() - 1);
  return formatCqlDate(d.toISOString());
}

function formatCqlDate(isoDate: string): string {
  const d = new Date(isoDate);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// biome-ignore lint/suspicious/noExplicitAny: SDK content types
function shouldSkipPage(page: any, labelsToSkip?: string[]): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  const pageLabels: string[] =
    page.metadata?.labels?.results?.map((l: { name: string }) => l.name) ?? [];
  return pageLabels.some((label) => labelsToSkip.includes(label));
}

function pageToDocument(
  // biome-ignore lint/suspicious/noExplicitAny: SDK content types
  page: any,
  baseUrl: string,
  isCloud: boolean,
): ConnectorDocument {
  const htmlContent: string = page.body?.storage?.value ?? "";
  const plainText = stripHtmlTags(htmlContent);

  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const basePath = isCloud ? "/wiki" : "";
  const webUiPath: string = page._links?.webui ?? "";
  const sourceUrl = webUiPath
    ? `${normalizedBase}${basePath}${webUiPath}`
    : undefined;

  return {
    id: page.id,
    title: page.title,
    content: `# ${page.title}\n\n${plainText}`,
    sourceUrl,
    metadata: {
      pageId: page.id,
      spaceKey: page.space?.key,
      spaceName: page.space?.name,
      status: page.status,
      labels:
        page.metadata?.labels?.results?.map((l: { name: string }) => l.name) ??
        [],
    },
    updatedAt: page.version?.when ? new Date(page.version.when) : undefined,
  };
}

/**
 * Strip HTML tags from Confluence storage format to produce clean plain text.
 *
 * Uses cheerio (DOM parser) instead of regex to correctly handle:
 *  - Confluence structured macros (status lozenges, panels, etc.)
 *  - Decorative parameters (colour, icon) that should not appear in text
 *  - Table structure (cells separated by tabs, rows by newlines)
 *  - Proper spacing between adjacent inline elements
 * @public — exported for testability
 */
export function stripHtmlTags(html: string): string {
  if (!html) return "";

  const $ = cheerio.load(html, { xml: true });

  // Remove decorative ac:parameter elements so values like "Red" from
  // status lozenges don't leak into indexed text
  $(
    'ac\\:parameter[ac\\:name="colour"], ac\\:parameter[ac\\:name="color"], ac\\:parameter[ac\\:name="subtle"], ac\\:parameter[ac\\:name="icon"], ac\\:parameter[ac\\:name="style"], ac\\:parameter[ac\\:name="class"]',
  ).remove();

  // Process tables: add structural separators before extracting text
  $("td, th").each((_i, el) => {
    $(el).prepend("\t");
  });
  $("tr").each((_i, el) => {
    $(el).append("\n");
  });

  // Block elements → newlines
  $("p, div, h1, h2, h3, h4, h5, h6, li, br").each((_i, el) => {
    $(el).after("\n");
  });

  let text = $.text();

  // Decode HTML entities that cheerio's XML mode doesn't handle
  text = text.replace(/&nbsp;/g, " ");

  // Collapse whitespace
  text = text.replace(/ {2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

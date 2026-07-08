// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
//
// Correctness tests for the connector-agnostic permission-sync pass
// (permissionSyncService.executePass), driven against a REAL database with a
// FAKE connector impl injected via the connector registry so the pass's
// generation/epoch/resume/group machinery can be exercised precisely without a
// specific upstream. (The GitHub end-to-end path is covered separately in
// permission-sync.integration.test.ts.)
import { vi } from "vitest";
import type { DocumentPermissions } from "@/types";

const { getConnector } = vi.hoisted(() => ({ getConnector: vi.fn() }));
vi.mock("@/knowledge-base/connectors/registry", () => ({ getConnector }));
vi.mock("@/knowledge-base/connector-credentials", () => ({
  resolveConnectorCredentials: vi.fn().mockResolvedValue({}),
}));

import { and, desc, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { permissionSyncService } from "@/knowledge-base/permission-sync";
import { ConnectorRunModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";

type FakeDoc = {
  sourceId: string;
  permissions: DocumentPermissions | undefined;
};

/**
 * A programmable connector impl. `syncDocumentPermissions` honors the resume
 * cursor (yields only sourceIds strictly greater than it, like a real ordered
 * cursor) so the resume test can assert tail-only processing.
 */
function makeFakeConnector(opts: {
  documents?: FakeDoc[];
  groups?: { groupId: string; memberEmails: string[] }[];
  hasSyncGroups?: boolean;
  syncGroupsThrows?: boolean;
  throwAfterDocs?: number;
  onStart?: () => Promise<void>;
}) {
  // biome-ignore lint/suspicious/noExplicitAny: test double
  const impl: any = {
    supportsPermissionSync: true,
    async *syncDocumentPermissions(params: { cursor: string | null }) {
      if (opts.onStart) await opts.onStart();
      let i = 0;
      for (const doc of opts.documents ?? []) {
        if (params.cursor !== null && doc.sourceId <= params.cursor) continue;
        if (opts.throwAfterDocs !== undefined && i >= opts.throwAfterDocs) {
          throw new Error("simulated crash");
        }
        yield {
          sourceId: doc.sourceId,
          permissions: doc.permissions,
          cursor: doc.sourceId,
        };
        i++;
      }
    },
  };
  if (opts.hasSyncGroups || opts.groups || opts.syncGroupsThrows) {
    impl.syncGroups = async function* () {
      if (opts.syncGroupsThrows) throw new Error("group crash");
      for (const group of opts.groups ?? []) {
        yield { groupId: group.groupId, memberEmails: group.memberEmails };
      }
    };
  }
  return impl;
}

describe("permission-sync pass (generation / epoch / resume / groups)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // One doc per flush so per-batch behavior (checkpoint, partial) is exact.
    config.kb.permissionSyncBatchSize = 1;
  });

  async function seedConnector(organizationId: string) {
    const [kb] = await db
      .insert(schema.knowledgeBasesTable)
      .values({ organizationId, name: "KB" })
      .returning();
    const [connector] = await db
      .insert(schema.knowledgeBaseConnectorsTable)
      .values({
        organizationId,
        name: "auto-sync",
        connectorType: "github",
        visibility: "auto-sync-permissions",
        config: {
          type: "github",
          githubUrl: "https://api.github.com",
          owner: "o",
          repos: ["r"],
        },
      })
      .returning();
    await db.insert(schema.knowledgeBaseConnectorAssignmentsTable).values({
      connectorId: connector.id,
      knowledgeBaseId: kb.id,
    });
    return connector;
  }

  async function seedDoc(params: {
    organizationId: string;
    connectorId: string;
    sourceId: string;
    acl: string[];
    generation?: number | null;
  }) {
    const [doc] = await db
      .insert(schema.kbDocumentsTable)
      .values({
        organizationId: params.organizationId,
        connectorId: params.connectorId,
        sourceId: params.sourceId,
        title: params.sourceId,
        content: "body",
        contentHash: `hash-${params.sourceId}`,
        acl: params.acl,
        aclSyncGeneration: params.generation ?? null,
        embeddingStatus: "completed",
      })
      .returning();
    await db.insert(schema.kbChunksTable).values({
      documentId: doc.id,
      content: "body",
      chunkIndex: 0,
      acl: params.acl,
    });
    return doc;
  }

  const docRow = async (id: string) =>
    (
      await db
        .select()
        .from(schema.kbDocumentsTable)
        .where(eq(schema.kbDocumentsTable.id, id))
    )[0];

  const docAcl = async (id: string) => (await docRow(id))?.acl;

  const chunkAcl = async (documentId: string) =>
    (
      await db
        .select({ acl: schema.kbChunksTable.acl })
        .from(schema.kbChunksTable)
        .where(eq(schema.kbChunksTable.documentId, documentId))
    )[0]?.acl;

  const runCheckpoint = async (runId: string) =>
    (
      await db
        .select({ checkpoint: schema.connectorRunsTable.checkpoint })
        .from(schema.connectorRunsTable)
        .where(eq(schema.connectorRunsTable.id, runId))
    )[0]?.checkpoint as { generation: number } | null | undefined;

  test("persists family-relevant run stats (scanned/changed/fail-closed/groups) on the run row", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    // B exists but is no longer enumerated upstream → swept fail-closed.
    await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "b",
      acl: ["user_email:old@example.com"],
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        documents: [
          { sourceId: "a", permissions: { users: ["alice@example.com"] } },
        ],
        groups: [
          {
            groupId: "g1",
            memberEmails: ["alice@example.com", "bob@example.com"],
          },
        ],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");
    expect(await docAcl(a.id)).toEqual(["user_email:alice@example.com"]);

    const [run] = await db
      .select({ stats: schema.connectorRunsTable.stats })
      .from(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.id, result.runId));
    expect(run?.stats).toEqual({
      totalDocs: 2,
      docsScanned: 1,
      aclsChanged: 1,
      chunksRewritten: 1,
      failClosed: 1,
      groupsSynced: 1,
      membershipsUpserted: 2,
      contentSyncActiveDuringRun: false,
    });
  });

  test("stats flag contentSyncActiveDuringRun when a content run overlaps the pass", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    // Simulate a live content backfill: a `content` run holding its lease.
    const claim = await ConnectorRunModel.claim({
      connectorId: connector.id,
      owner: "content-worker",
      leaseTtlSeconds: 300,
      runType: "content",
    });
    expect(claim.outcome).toBe("claimed");

    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        documents: [
          { sourceId: "a", permissions: { users: ["alice@example.com"] } },
        ],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const [run] = await db
      .select({ stats: schema.connectorRunsTable.stats })
      .from(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.id, result.runId));
    // The badge signal: this success only covered what was ingested so far.
    expect(run?.stats?.contentSyncActiveDuringRun).toBe(true);
  });

  test("applies an access-shrink diff without re-embedding, and stamps unchanged docs", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    // A shrinks from {alice,bob} → {alice}; B is already correct (unchanged).
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: ["user_email:alice@example.com", "user_email:bob@example.com"],
    });
    const b = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "b",
      acl: ["user_email:carol@example.com"],
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        documents: [
          { sourceId: "a", permissions: { users: ["alice@example.com"] } },
          { sourceId: "b", permissions: { users: ["carol@example.com"] } },
        ],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    // Shrink applied to doc AND its chunks.
    expect(await docAcl(a.id)).toEqual(["user_email:alice@example.com"]);
    expect(await chunkAcl(a.id)).toEqual(["user_email:alice@example.com"]);
    // Unchanged doc keeps its ACL but is stamped with the generation (scanned,
    // not rewritten).
    expect(await docAcl(b.id)).toEqual(["user_email:carol@example.com"]);
    const bRow = await docRow(b.id);
    expect(bRow?.aclSyncGeneration).not.toBeNull();
    // The pass never re-embeds.
    expect(bRow?.embeddingStatus).toBe("completed");
    const aRow = await docRow(a.id);
    expect(aRow?.embeddingStatus).toBe("completed");
  });

  test("generation-gated reconcile fail-closes a doc no longer visible upstream", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: ["user_email:alice@example.com"],
    });
    // B was previously tagged but is no longer enumerated upstream (removed).
    const b = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "b",
      acl: ["user_email:alice@example.com"],
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        documents: [
          { sourceId: "a", permissions: { users: ["alice@example.com"] } },
        ],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    // A stays; B (unreached by this generation) fail-closes, chunks too.
    expect(await docAcl(a.id)).toEqual(["user_email:alice@example.com"]);
    expect(await docAcl(b.id)).toEqual([]);
    expect(await chunkAcl(b.id)).toEqual([]);
  });

  test("a partial/failed generation never fail-closes unreached docs", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: ["user_email:alice@example.com"],
    });
    const b = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "b",
      acl: ["user_email:alice@example.com"],
    });
    // Enumerate A then crash before reaching B — the generation never completes.
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        documents: [
          { sourceId: "a", permissions: { users: ["alice@example.com"] } },
          { sourceId: "b", permissions: { users: ["alice@example.com"] } },
        ],
        throwAfterDocs: 1,
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("partial");

    // B must NOT be swept — an interrupted generation never fail-closes docs it
    // never reached.
    expect(await docAcl(b.id)).toEqual(["user_email:alice@example.com"]);
    expect(await docAcl(a.id)).toEqual(["user_email:alice@example.com"]);
  });

  test("a re-enqueued run resumes the SAME generation from the checkpoint cursor (tail only)", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    const b = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "b",
      acl: [],
    });
    const c = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "c",
      acl: [],
    });

    // Run 1: tag A, then crash before B → partial with checkpoint cursor "a".
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        documents: [
          { sourceId: "a", permissions: { users: ["alice@example.com"] } },
          { sourceId: "b", permissions: { users: ["bob@example.com"] } },
          { sourceId: "c", permissions: { users: ["carol@example.com"] } },
        ],
        throwAfterDocs: 1,
      }),
    );
    const r1 = await permissionSyncService.executePass(connector.id);
    expect(r1.status).toBe("partial");
    const gen1 = (await runCheckpoint(r1.runId))?.generation;
    expect(gen1).toBeDefined();
    expect(await docAcl(a.id)).toEqual(["user_email:alice@example.com"]);

    // Run 2: honors the cursor (yields only B, C — never re-enumerates A).
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        documents: [
          { sourceId: "b", permissions: { users: ["bob@example.com"] } },
          { sourceId: "c", permissions: { users: ["carol@example.com"] } },
        ],
      }),
    );
    const r2 = await permissionSyncService.executePass(connector.id);
    expect(r2.status).toBe("success");

    // Same generation resumed (not a fresh restart).
    expect((await runCheckpoint(r2.runId))?.generation).toBe(gen1);
    // Tail processed...
    expect(await docAcl(b.id)).toEqual(["user_email:bob@example.com"]);
    expect(await docAcl(c.id)).toEqual(["user_email:carol@example.com"]);
    // ...and A — stamped by run 1 under the SAME generation — is neither
    // re-enumerated nor swept.
    expect(await docAcl(a.id)).toEqual(["user_email:alice@example.com"]);
  });

  test("every ACL write is epoch-fenced: a config change mid-pass no-ops the writes", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    // The pass captures the epoch at start; bump it as enumeration begins so the
    // epoch the writes carry is already stale — every fenced write must no-op.
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        documents: [
          { sourceId: "a", permissions: { users: ["alice@example.com"] } },
        ],
        onStart: async () => {
          await db
            .update(schema.knowledgeBaseConnectorsTable)
            .set({ aclConfigEpoch: 5 })
            .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));
        },
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    // The write was computed against the now-stale epoch, so it no-ops: the doc
    // stays fail-closed rather than being tagged under an outdated config.
    expect(await docAcl(a.id)).toEqual([]);
    expect(await chunkAcl(a.id)).toEqual([]);
  });

  test("groups step: completion-gated stale sweep removes revoked memberships", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    // Pre-existing snapshot: g1/alice (still a member) and gone/bob (revoked).
    await db.insert(schema.kbExternalUserGroupTable).values([
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "g1",
        memberEmail: "alice@example.com",
        stale: false,
      },
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "gone",
        memberEmail: "bob@example.com",
        stale: false,
      },
    ]);
    // No documents (pass fast-exits phase 2); only the group step runs.
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        groups: [{ groupId: "g1", memberEmails: ["alice@example.com"] }],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const rows = await db
      .select({ groupId: schema.kbExternalUserGroupTable.groupId })
      .from(schema.kbExternalUserGroupTable)
      .where(eq(schema.kbExternalUserGroupTable.connectorId, connector.id));
    // g1 survives (re-observed); the revoked "gone" group is swept.
    expect(rows.map((r) => r.groupId).sort()).toEqual(["g1"]);
  });

  test("groups step failure is isolated: the document reconcile still runs and the prior snapshot survives", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    // A prior group snapshot that must NOT be swept when the group step fails.
    await db.insert(schema.kbExternalUserGroupTable).values({
      organizationId: org.id,
      connectorId: connector.id,
      connectorType: "github",
      groupId: "g1",
      memberEmail: "alice@example.com",
      stale: false,
    });
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        syncGroupsThrows: true,
        documents: [
          { sourceId: "a", permissions: { users: ["alice@example.com"] } },
        ],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    // The group failure is caught — the pass still succeeds and reconciles docs.
    expect(result.status).toBe("success");
    expect(await docAcl(a.id)).toEqual(["user_email:alice@example.com"]);
    // The prior group snapshot is left intact (not swept) since the group
    // enumeration never completed.
    const rows = await db
      .select({ groupId: schema.kbExternalUserGroupTable.groupId })
      .from(schema.kbExternalUserGroupTable)
      .where(eq(schema.kbExternalUserGroupTable.connectorId, connector.id));
    expect(rows.map((r) => r.groupId)).toEqual(["g1"]);
  });

  test("fast-exits and records a permission run for a connector with no documents", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    vi.mocked(getConnector).mockReturnValue(makeFakeConnector({}));

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    // A `permission` run was recorded (runType-filterable) and finalized.
    const [run] = await db
      .select()
      .from(schema.connectorRunsTable)
      .where(
        and(
          eq(schema.connectorRunsTable.connectorId, connector.id),
          eq(schema.connectorRunsTable.runType, "permission"),
        ),
      )
      .orderBy(desc(schema.connectorRunsTable.startedAt))
      .limit(1);
    expect(run?.status).toBe("success");
  });
});

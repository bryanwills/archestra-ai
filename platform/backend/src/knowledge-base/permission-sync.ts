// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import { hostname } from "node:os";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type pino from "pino";
import config from "@/config";
import defaultLogger from "@/logging";
import {
  ConnectorRunModel,
  KbChunkModel,
  KbDocumentModel,
  KbExternalUserGroupModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import * as metrics from "@/observability/metrics";
import type {
  Connector,
  InsertKbExternalUserGroup,
  KnowledgeBaseConnector,
  PermissionSyncRunStats,
  ReadIngestedDocuments,
} from "@/types";
import { resolveConnectorCredentials } from "./connector-credentials";
import {
  BaseConnector,
  extractErrorMessage,
} from "./connectors/base-connector";
import { getConnector } from "./connectors/registry";
import { invalidateGroupTokenCache } from "./group-token-cache";
import { buildDocumentAccessControlList } from "./source-access-control";

const WORKER_ID = `${hostname()}#${process.pid}`;

// Batch size for the pass's ACL writes and its generation-gated fail-close
// sweep. Bounds per-transaction work so mass-change bursts stay in short
// transactions (bounded WAL/lock). Fixed like EMBEDDING_BATCH_SIZE — not an
// operator knob.
const PERMISSION_SYNC_BATCH_SIZE = 200;

type PermissionSyncPhase = "groups" | "documents";

/**
 * Resumable checkpoint for a permission-sync run. A fresh run stamps a new
 * `generation`; a resumed run reuses it so its generation-gated fail-close sweep
 * only fires once the SAME generation enumerates end-to-end.
 */
type PermissionSyncCheckpoint = {
  phase: PermissionSyncPhase;
  cursor: string | null;
  generation: number;
};

/**
 * The single, connector-agnostic permission-sync pass for
 * `auto-sync-permissions` connectors. Runs in the runtime-isolated `permission`
 * job family (its own connector-run lease and queue lane). Each run does a full,
 * generation-gated reconcile: it snapshots upstream group membership, recomputes
 * every document's ACL, writes only what changed (O(changed) wide writes), and
 * fail-closes anything no longer visible upstream — never re-embedding.
 */
class PermissionSyncService {
  /**
   * ACL-write / fail-close-sweep batch size. Fixed in production
   * (PERMISSION_SYNC_BATCH_SIZE); tests shrink it to pin per-batch
   * checkpoint/partial behavior.
   */
  batchSize = PERMISSION_SYNC_BATCH_SIZE;

  async executePass(
    connectorId: string,
    options?: { logger?: pino.Logger; getLogOutput?: () => string },
  ): Promise<{ runId: string; status: string }> {
    const log = options?.logger ?? defaultLogger;

    const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
    if (!connector) {
      throw new Error(`Connector not found: ${connectorId}`);
    }

    if (connector.visibility !== "auto-sync-permissions") {
      log.debug(
        { connectorId, visibility: connector.visibility },
        "Connector is not auto-sync-permissions; skipping permission pass",
      );
      return { runId: "", status: "skipped" };
    }

    const connectorImpl = getConnector(connector.connectorType);
    if (
      !connectorImpl.supportsPermissionSync ||
      !connectorImpl.syncDocumentPermissions
    ) {
      log.warn(
        { connectorId, connectorType: connector.connectorType },
        "Connector does not implement permission sync; skipping",
      );
      return { runId: "", status: "skipped" };
    }

    // Single-flight within the `permission` family (independent of content).
    const leaseTtlSeconds = config.kb.connectorRunLeaseTtlSeconds;
    const claim = await ConnectorRunModel.claim({
      connectorId,
      owner: WORKER_ID,
      leaseTtlSeconds,
      runType: "permission",
    });
    if (claim.outcome === "busy") {
      log.info(
        { connectorId },
        "A permission sync is already running for this connector; skipping",
      );
      return { runId: "", status: "skipped" };
    }

    const run = claim.run;
    const epoch = run.leaseEpoch;
    // `claim` always inserts a fresh run (no checkpoint). If the previous
    // terminal run of this family was interrupted (reaper-marked `partial`),
    // adopt its checkpoint so this run resumes the SAME generation from its
    // cursor rather than restarting the reconcile.
    const priorCheckpoint =
      (run.checkpoint as PermissionSyncCheckpoint | null) ??
      ((await ConnectorRunModel.findResumableCheckpoint({
        connectorId,
        runType: "permission",
        excludeRunId: run.id,
      })) as PermissionSyncCheckpoint | null);
    const runLog = log.child({
      runId: run.id,
      connectorId,
      connectorType: connector.connectorType,
    });
    if (connectorImpl instanceof BaseConnector) {
      connectorImpl.setLogger(runLog);
    }

    const beat = () => {
      ConnectorRunModel.renewLease({
        runId: run.id,
        owner: WORKER_ID,
        epoch,
        leaseTtlSeconds,
      })
        .then((held) => {
          if (!held) runLog.warn("Permission run lease lost during heartbeat");
        })
        .catch((error) => {
          runLog.warn(
            { error: extractErrorMessage(error) },
            "Permission run heartbeat failed",
          );
        });
    };
    beat();
    const heartbeat = setInterval(
      beat,
      config.kb.connectorRunHeartbeatIntervalSeconds * 1000,
    );
    heartbeat.unref();

    try {
      const result = await this.runClaimedPass({
        connector,
        connectorImpl,
        runId: run.id,
        epoch,
        startedAt: run.startedAt,
        priorCheckpoint,
        runLog,
        getLogOutput: options?.getLogOutput,
      });
      // This pass is the only writer of group memberships, so drop the
      // per-user group-token cache whenever one finishes — including a
      // `partial` run, whose group phase may have completed before the
      // interruption. Freshly synced access is then visible on the next
      // query instead of after the cache TTL.
      await invalidateGroupTokenCache();
      return result;
    } finally {
      clearInterval(heartbeat);
    }
  }

  // ===== Private methods =====

  private async runClaimedPass(params: {
    connector: KnowledgeBaseConnector;
    connectorImpl: Connector;
    runId: string;
    epoch: number;
    startedAt: Date;
    priorCheckpoint: PermissionSyncCheckpoint | null;
    runLog: pino.Logger;
    getLogOutput?: () => string;
  }): Promise<{ runId: string; status: string }> {
    const {
      connector,
      connectorImpl,
      runId,
      epoch,
      startedAt,
      priorCheckpoint,
      runLog,
      getLogOutput,
    } = params;
    const connectorId = connector.id;
    // Epoch read alongside the visibility config; every ACL write is fenced on
    // it so a write computed against a now-stale config no-ops.
    const aclConfigEpoch = connector.aclConfigEpoch;

    await KnowledgeBaseConnectorModel.update(connectorId, {
      lastPermissionSyncStatus: "running",
      lastPermissionSyncAt: startedAt,
    });

    // Resume the same generation, or stamp a fresh one on a first run.
    const generation = priorCheckpoint?.generation ?? Date.now();

    try {
      const credentials = await resolveConnectorCredentials(connector);
      // Read-back of already-ingested docs, injected into the hooks so
      // container-scoped connectors (GitHub) can tag a container's documents
      // without re-enumerating upstream. Keyset-paginated, O(page) memory.
      const readIngestedDocuments: ReadIngestedDocuments = async (args) => {
        const rows = await KbDocumentModel.findIngestedForReadback({
          connectorId,
          metadataFilter: args.metadataFilter,
          afterId: args.afterId,
          limit: args.limit,
        });
        return {
          documents: rows
            .filter((row): row is typeof row & { sourceId: string } =>
              Boolean(row.sourceId),
            )
            .map((row) => ({ sourceId: row.sourceId, metadata: row.metadata })),
          nextAfterId: rows.length > 0 ? rows[rows.length - 1].id : null,
        };
      };
      // Family-relevant run stats, persisted on the run row alongside each
      // checkpoint (live progress) and finalized on completion. The
      // content-sync counters stay 0 for permission runs; these are what the
      // Permission Sync Runs UI renders.
      const stats: PermissionSyncRunStats = {
        totalDocs: 0,
        docsScanned: 0,
        aclsChanged: 0,
        chunksRewritten: 0,
        failClosed: 0,
        groupsSynced: 0,
        membershipsUpserted: 0,
        // A pass overlapping a content backfill only covers what was ingested
        // when it enumerated; later-ingested docs stay fail-closed until the
        // next pass. Surfaced so a "success" during a backfill is legible.
        contentSyncActiveDuringRun: await ConnectorRunModel.hasRunningRun({
          connectorId,
          runType: "content",
        }),
      };

      // ---- Phase 1: groups (completion-gated stale sweep). Not resumed
      // mid-way — small and dedupable; a restart re-marks and re-observes.
      //
      // Per-step failure isolation: the group step and the document reconcile
      // (Phase 2) are two independent steps of the one pass. A group-enumeration
      // failure is logged + metered but MUST NOT abort Phase 2 — documents still
      // reconcile against the previous group snapshot. On failure we skip the
      // completion-gated `deleteStaleByConnector`, so the prior snapshot's rows
      // (now flagged stale, but `findGroupTokensForUser` ignores the flag) stay
      // resolvable until a later pass enumerates cleanly. ----
      if (connectorImpl.syncGroups) {
        try {
          await KbExternalUserGroupModel.markStaleByConnector(connectorId);
          let pending: InsertKbExternalUserGroup[] = [];
          for await (const group of connectorImpl.syncGroups({
            config: connector.config as Record<string, unknown>,
            credentials,
            cursor: null,
            readIngestedDocuments,
          })) {
            stats.groupsSynced += 1;
            stats.membershipsUpserted += group.members.length;
            for (const member of group.members) {
              // Every member is persisted — a hidden upstream email is stored
              // as NULL (fail-closed at resolution, visible to admins) rather
              // than dropping the principal.
              pending.push({
                organizationId: connector.organizationId,
                connectorId,
                connectorType: connector.connectorType,
                groupId: group.groupId,
                externalAccountId: member.accountId,
                displayName: member.displayName,
                memberEmail: member.email,
              });
            }
            if (pending.length >= this.batchSize) {
              await KbExternalUserGroupModel.upsertMany(pending);
              pending = [];
              await yieldToEventLoop();
            }
          }
          if (pending.length > 0) {
            await KbExternalUserGroupModel.upsertMany(pending);
          }
          // Sweep only after enumeration finished (completion-gated).
          await KbExternalUserGroupModel.deleteStaleByConnector(connectorId);
        } catch (error) {
          runLog.warn(
            { error: extractErrorMessage(error) },
            "Permission sync group step failed; continuing to document reconcile with the previous group snapshot",
          );
          metrics.rag.reportPermissionSyncGroupFailure(connector.connectorType);
        }
      }

      await this.checkpoint(
        runId,
        epoch,
        { phase: "documents", cursor: null, generation },
        stats,
      );

      // ---- Phase 2: documents (generation-gated full reconcile) ----
      const totalDocs = await KbDocumentModel.countByConnector(connectorId);
      stats.totalDocs = totalDocs;
      if (totalDocs === 0) {
        // Fast-exit: nothing ingested yet. New content is fail-closed until a
        // later pass (content-sync creates auto-sync docs with acl=[]).
        runLog.info("No documents yet; permission pass fast-exits");
        await this.finalize({ connectorId, runId, epoch, startedAt, stats });
        metrics.rag.reportPermissionSync({
          connectorType: connector.connectorType,
          status: "success",
        });
        return { runId, status: "success" };
      }

      // Resume from a documents-phase cursor if present.
      const resumeCursor =
        priorCheckpoint?.phase === "documents" ? priorCheckpoint.cursor : null;

      let batch: { sourceId: string; permissions: unknown }[] = [];
      let latestCursor: string | null = resumeCursor;
      const generatorParams = {
        config: connector.config as Record<string, unknown>,
        credentials,
        cursor: resumeCursor,
        readIngestedDocuments,
      };

      const flush = async () => {
        if (batch.length === 0) return;
        const { changed, chunksRewritten } = await this.flushDocumentBatch({
          connector,
          batch,
          generation,
          aclConfigEpoch,
        });
        stats.docsScanned += batch.length;
        stats.aclsChanged += changed;
        stats.chunksRewritten += chunksRewritten;
        batch = [];
        await this.checkpoint(
          runId,
          epoch,
          { phase: "documents", cursor: latestCursor, generation },
          stats,
        );
        await yieldToEventLoop();
      };

      const generator =
        connectorImpl.syncDocumentPermissions?.(generatorParams);
      if (generator) {
        for await (const item of generator) {
          batch.push({
            sourceId: item.sourceId,
            permissions: item.permissions,
          });
          if (item.cursor !== undefined) latestCursor = item.cursor;
          if (batch.length >= this.batchSize) {
            await flush();
          }
        }
      }
      await flush();

      // ---- Generation-gated fail-close sweep (only after full enumeration) ----
      for (;;) {
        const swept = await KbDocumentModel.failCloseStaleDocuments({
          connectorId,
          generation,
          aclConfigEpoch,
          batchSize: this.batchSize,
        });
        stats.failClosed += swept;
        if (swept === 0) break;
        await yieldToEventLoop();
      }

      runLog.info({ ...stats, generation }, "Permission sync pass complete");

      await this.finalize({
        connectorId,
        runId,
        epoch,
        startedAt,
        stats,
        getLogOutput,
      });
      metrics.rag.reportPermissionSync({
        connectorType: connector.connectorType,
        status: "success",
      });
      return { runId, status: "success" };
    } catch (error) {
      const message = extractErrorMessage(error);
      runLog.error({ error: message }, "Permission sync pass failed");
      // Mark the run partial (checkpoint preserved) so a re-enqueue resumes the
      // SAME generation — a partial generation never sweeps.
      await ConnectorRunModel.updateIfOwned({
        runId,
        epoch,
        data: {
          status: "partial",
          error: message,
          completedAt: new Date(),
          ...(getLogOutput ? { logs: getLogOutput() } : {}),
        },
      });
      // `stats` is scoped to the try block (it captures the content-run check);
      // the partial row keeps whatever the last checkpoint persisted.
      await KnowledgeBaseConnectorModel.update(connectorId, {
        lastPermissionSyncStatus: "partial",
      });
      metrics.rag.reportPermissionSync({
        connectorType: connector.connectorType,
        status: "partial",
      });
      return { runId, status: "partial" };
    }
  }

  private async flushDocumentBatch(params: {
    connector: KnowledgeBaseConnector;
    batch: { sourceId: string; permissions: unknown }[];
    generation: number;
    aclConfigEpoch: number;
  }): Promise<{ changed: number; chunksRewritten: number }> {
    const { connector, batch, generation, aclConfigEpoch } = params;
    const sourceIds = batch.map((item) => item.sourceId);
    const current = await KbDocumentModel.findAclStateBySourceIds({
      connectorId: connector.id,
      sourceIds,
    });
    const bySourceId = new Map(current.map((doc) => [doc.sourceId, doc]));

    let changed = 0;
    let chunksRewritten = 0;
    const unchangedIds: string[] = [];

    for (const item of batch) {
      const doc = bySourceId.get(item.sourceId);
      if (!doc) continue; // not yet ingested by content-sync; skip

      const nextAcl = buildDocumentAccessControlList({
        visibility: "auto-sync-permissions",
        teamIds: connector.teamIds,
        connectorType: connector.connectorType,
        permissions: item.permissions as
          | { users?: string[]; groups?: string[]; isPublic?: boolean }
          | undefined,
      });

      if (aclEquals(doc.acl, nextAcl)) {
        unchangedIds.push(doc.id);
        continue;
      }

      // Crash-safe ordering: chunk ACLs first, then the doc row (acl +
      // generation stamp) last. Both epoch-fenced.
      chunksRewritten += await KbChunkModel.updateAclByDocument({
        documentId: doc.id,
        acl: nextAcl,
        connectorId: connector.id,
        aclConfigEpoch,
      });
      const wrote = await KbDocumentModel.updateAclAndGeneration({
        documentId: doc.id,
        connectorId: connector.id,
        acl: nextAcl,
        generation,
        aclConfigEpoch,
      });
      if (wrote) changed += 1;
    }

    // Narrow, HOT-friendly generation stamp for unchanged docs.
    await KbDocumentModel.stampGeneration({
      documentIds: unchangedIds,
      connectorId: connector.id,
      generation,
      aclConfigEpoch,
    });

    return { changed, chunksRewritten };
  }

  private async checkpoint(
    runId: string,
    epoch: number,
    checkpoint: PermissionSyncCheckpoint,
    stats?: PermissionSyncRunStats,
  ): Promise<void> {
    await ConnectorRunModel.updateIfOwned({
      runId,
      epoch,
      // Stats ride along with every checkpoint so a running pass shows live
      // progress (they are cheap — same fenced UPDATE).
      data: { checkpoint, ...(stats ? { stats: { ...stats } } : {}) },
    });
  }

  private async finalize(params: {
    connectorId: string;
    runId: string;
    epoch: number;
    startedAt: Date;
    stats?: PermissionSyncRunStats;
    getLogOutput?: () => string;
  }): Promise<void> {
    const owned = await ConnectorRunModel.updateIfOwned({
      runId: params.runId,
      epoch: params.epoch,
      data: {
        status: "success",
        completedAt: new Date(),
        ...(params.stats ? { stats: { ...params.stats } } : {}),
        ...(params.getLogOutput ? { logs: params.getLogOutput() } : {}),
      },
    });
    // Only mirror the status if we still owned the run (not reclaimed).
    if (owned) {
      await KnowledgeBaseConnectorModel.update(params.connectorId, {
        lastPermissionSyncStatus: "success",
      });
    }
  }
}

export const permissionSyncService = new PermissionSyncService();

// ===== Internal helpers =====

function aclEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((entry, index) => entry === sortedB[index]);
}

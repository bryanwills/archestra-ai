// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import logger from "@/logging";
import { TaskModel } from "@/models";
import { taskQueueService } from "@/task-queue";
import type { KnowledgeBaseConnector } from "@/types";
import { getConnector } from "./connectors/registry";

/**
 * Content-ingest trigger for the permission-sync pass. When a content-sync run
 * for an `auto-sync-permissions` connector ingests ≥1 document, enqueue a
 * `permission_sync` for that connector so newly-ingested content is tagged
 * promptly instead of waiting for the next scheduled tick (new auto-sync docs
 * are created fail-closed, so they stay invisible until the pass runs).
 *
 * Runtime-isolation invariants still hold: the enqueued task runs in the
 * `permission` lane under its own `permission` runType lease, so it can neither
 * block nor be blocked by content sync (Guarantees 2–3).
 *
 * The enqueue is de-duplicated — a single pass fully reconciles every pending
 * new document, so if a `permission_sync` is already pending/processing for the
 * connector we skip (one pass covers all of them). A 0-document run, or a
 * non-auto-sync connector, never enqueues.
 */
export async function enqueuePermissionSyncForIngestedContent(params: {
  connector: Pick<
    KnowledgeBaseConnector,
    "id" | "visibility" | "connectorType"
  >;
  documentsIngested: number;
}): Promise<void> {
  const { connector, documentsIngested } = params;

  if (connector.visibility !== "auto-sync-permissions") return;
  if (documentsIngested <= 0) return;
  // Defensive: a connector type without permission-sync support has no pass to
  // run (the route also forbids auto-sync for such types).
  if (!getConnector(connector.connectorType).supportsPermissionSync) return;

  const alreadyQueued = await TaskModel.hasPendingOrProcessing(
    "permission_sync",
    connector.id,
  );
  if (alreadyQueued) return;

  await taskQueueService.enqueue({
    taskType: "permission_sync",
    payload: { connectorId: connector.id },
  });
  logger.info(
    { connectorId: connector.id, documentsIngested },
    "Enqueued permission sync after content ingest (auto-sync-permissions connector ingested new documents)",
  );
}

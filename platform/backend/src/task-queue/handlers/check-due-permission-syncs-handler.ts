import { Cron } from "croner";
import config from "@/config";
import { getConnector } from "@/knowledge-base/connectors/registry";
import logger from "@/logging";
import {
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  OrganizationModel,
  TaskModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";
import { withinResumeBudget } from "./connector-resume-budget";

/**
 * Runtime-isolated sibling of `check_due_connectors` for the permission-sync
 * family. Enqueues due `permission_sync` tasks per the GLOBAL permission-sync
 * schedule (org override, else the env default) — independent of each
 * connector's content `schedule` — and reaps expired permission runs. Kept
 * separate so content-run recovery is never overloaded with permission work.
 */
export async function handleCheckDuePermissionSyncs(): Promise<void> {
  const connectors = await KnowledgeBaseConnectorModel.findAllEnabled();
  const autoSyncConnectors = connectors.filter(
    (connector) =>
      connector.visibility === "auto-sync-permissions" &&
      connectorSupportsPermissionSync(connector.connectorType),
  );
  if (autoSyncConnectors.length > 0) {
    const activeConnectorIds = await TaskModel.findActivePayloadValues(
      "permission_sync",
      "connectorId",
    );
    const scheduleByOrg = await resolveSchedulesByOrg(
      autoSyncConnectors.map((connector) => connector.organizationId),
    );

    for (const connector of autoSyncConnectors) {
      const schedule = scheduleByOrg.get(connector.organizationId);
      if (!schedule) continue;

      try {
        const cron = new Cron(schedule);
        const nextRun = cron.nextRun(
          connector.lastPermissionSyncAt ?? new Date(0),
        );
        if (
          nextRun &&
          nextRun <= new Date() &&
          !activeConnectorIds.has(connector.id)
        ) {
          await taskQueueService.enqueue({
            taskType: "permission_sync",
            payload: { connectorId: connector.id },
          });
          logger.info(
            {
              connectorId: connector.id,
              connectorType: connector.connectorType,
            },
            "Enqueued scheduled permission sync",
          );
        }
      } catch (error) {
        logger.warn(
          {
            connectorId: connector.id,
            schedule,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to evaluate permission-sync schedule",
        );
      }
    }
  }

  await reapExpiredPermissionRuns();
}

// ===== Internal helpers =====

function connectorSupportsPermissionSync(connectorType: string): boolean {
  try {
    return getConnector(connectorType).supportsPermissionSync;
  } catch {
    return false;
  }
}

/**
 * Resolve each org's effective permission-sync cron once:
 * `organization.permissionSyncSchedule ?? env default`.
 */
async function resolveSchedulesByOrg(
  organizationIds: string[],
): Promise<Map<string, string>> {
  const distinctOrgIds = [...new Set(organizationIds)];
  const entries = await Promise.all(
    distinctOrgIds.map(async (organizationId) => {
      const org = await OrganizationModel.getById(organizationId);
      const schedule =
        org?.permissionSyncSchedule ?? config.kb.permissionSyncScheduleDefault;
      return [organizationId, schedule] as const;
    }),
  );
  return new Map(entries);
}

async function reapExpiredPermissionRuns(): Promise<void> {
  const expired = await ConnectorRunModel.reapExpiredRuns("permission");
  for (const run of expired) {
    logger.warn(
      { runId: run.id, connectorId: run.connectorId },
      "Reclaimed permission run with an expired lease; resuming from checkpoint",
    );
    await KnowledgeBaseConnectorModel.update(run.connectorId, {
      lastPermissionSyncStatus: "partial",
    });

    if (
      !(await withinResumeBudget({
        connectorId: run.connectorId,
        runType: "permission",
      }))
    ) {
      // Runaway: stop auto-resuming. The checkpoint is preserved, so the next
      // scheduled pass resumes the same generation from its cursor.
      logger.error(
        { connectorId: run.connectorId },
        "Permission sync is repeatedly interrupted; not auto-resuming — needs investigation",
      );
      continue;
    }

    await taskQueueService.enqueue({
      taskType: "permission_sync",
      payload: { connectorId: run.connectorId },
    });
  }
}

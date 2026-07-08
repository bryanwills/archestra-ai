import { createCapturingLogger } from "@/entrypoints/_shared/log-capture";
import { permissionSyncService } from "@/knowledge-base";
import logger from "@/logging";
import { KnowledgeBaseConnectorModel } from "@/models";
import { taskQueueService } from "@/task-queue";

export async function handlePermissionSync(
  payload: Record<string, unknown>,
): Promise<void> {
  const connectorId = payload.connectorId as string;
  if (!connectorId) {
    throw new Error("Missing connectorId in permission_sync payload");
  }

  const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
  const { logger: capturingLogger, getLogOutput } = createCapturingLogger();

  const result = await permissionSyncService.executePass(connectorId, {
    logger: capturingLogger,
    getLogOutput,
  });

  // A partial run was interrupted mid-generation; re-enqueue so a fresh run
  // resumes the same generation from its checkpoint cursor. The claim()
  // single-flight makes a redundant enqueue harmless.
  if (result.status === "partial") {
    await taskQueueService.enqueue({
      taskType: "permission_sync",
      payload: { connectorId },
    });
    logger.info(
      {
        connectorId,
        connectorName: connector?.name,
        connectorType: connector?.connectorType,
        runId: result.runId,
      },
      "Enqueued permission-sync continuation",
    );
  }
}

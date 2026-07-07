// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import { and, count, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { enqueuePermissionSyncForIngestedContent } from "@/knowledge-base";
import { TaskModel } from "@/models";
import { describe, expect, test } from "@/test";

async function permissionSyncTaskCount(connectorId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.tasksTable)
    .where(
      and(
        eq(schema.tasksTable.taskType, "permission_sync"),
        sql`${schema.tasksTable.payload}->>'connectorId' = ${connectorId}`,
      ),
    );
  return row?.value ?? 0;
}

describe("enqueuePermissionSyncForIngestedContent (content-ingest trigger)", () => {
  test("enqueues a permission_sync when an auto-sync connector ingested >=1 doc", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });

    await enqueuePermissionSyncForIngestedContent({
      connector,
      documentsIngested: 3,
    });

    expect(
      await TaskModel.hasPendingOrProcessing("permission_sync", connector.id),
    ).toBe(true);
  });

  test("de-duplicates when a permission_sync is already pending for the connector", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });

    await enqueuePermissionSyncForIngestedContent({
      connector,
      documentsIngested: 1,
    });
    await enqueuePermissionSyncForIngestedContent({
      connector,
      documentsIngested: 5,
    });

    // One pass fully reconciles all pending new docs, so the second call is a
    // no-op — never a second queued task.
    expect(await permissionSyncTaskCount(connector.id)).toBe(1);
  });

  test("does not enqueue when the run ingested 0 documents", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });

    await enqueuePermissionSyncForIngestedContent({
      connector,
      documentsIngested: 0,
    });

    expect(await permissionSyncTaskCount(connector.id)).toBe(0);
  });

  test("does not enqueue for a non-auto-sync connector", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "org-wide",
      connectorType: "github",
    });

    await enqueuePermissionSyncForIngestedContent({
      connector,
      documentsIngested: 4,
    });

    expect(await permissionSyncTaskCount(connector.id)).toBe(0);
  });
});

import { sql } from "drizzle-orm";
import config from "@/config";
import db from "@/database";
import {
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  OrganizationModel,
  TaskModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { handleCheckDuePermissionSyncs } from "./check-due-permission-syncs-handler";

const PAST = () => new Date(Date.now() - 120_000);

// A cron whose next occurrence after "now" is always far in the future, so a
// connector with a recent lastPermissionSyncAt is NOT due under it.
const NEVER_SOON = "0 0 1 1 *"; // once a year, midnight Jan 1

/** Count permission_sync tasks (any status) enqueued for a connector. */
async function countPermissionSyncTasks(connectorId: string): Promise<number> {
  const { rows } = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM tasks
    WHERE task_type = 'permission_sync'
      AND payload->>'connectorId' = ${connectorId}
  `);
  return rows[0]?.count ?? 0;
}

describe("handleCheckDuePermissionSyncs", () => {
  beforeEach(() => {
    // Keep the env default from making unrelated connectors "due" by accident.
    config.kb.permissionSyncScheduleDefault = NEVER_SOON;
  });

  test("enqueues a permission_sync for a due auto-sync connector per the GLOBAL org schedule", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    // GLOBAL permission-sync schedule that is always due.
    await OrganizationModel.patch(org.id, {
      permissionSyncSchedule: "* * * * *",
    });
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastPermissionSyncAt: PAST(),
    });

    await handleCheckDuePermissionSyncs();

    const active = await TaskModel.findActivePayloadValues(
      "permission_sync",
      "connectorId",
    );
    expect(active.has(connector.id)).toBe(true);
    expect(await countPermissionSyncTasks(connector.id)).toBe(1);
  });

  test("falls back to config.kb.permissionSyncScheduleDefault when the org has no override", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    // No OrganizationModel.patch → org.permissionSyncSchedule stays null, so the
    // handler must use the env default. Make that default always due.
    expect(org.permissionSyncSchedule).toBeNull();
    config.kb.permissionSyncScheduleDefault = "* * * * *";
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
      enabled: true,
    });
    // lastPermissionSyncAt left null → treated as epoch → due.

    await handleCheckDuePermissionSyncs();

    const active = await TaskModel.findActivePayloadValues(
      "permission_sync",
      "connectorId",
    );
    expect(active.has(connector.id)).toBe(true);
  });

  describe("independence from the content schedule", () => {
    test("enqueues permission_sync even when the content schedule is NOT due", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      await OrganizationModel.patch(org.id, {
        permissionSyncSchedule: "* * * * *", // permission cadence: always due
      });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        visibility: "auto-sync-permissions",
        connectorType: "github",
        enabled: true,
        schedule: NEVER_SOON, // content cadence: not due
      });
      await KnowledgeBaseConnectorModel.update(connector.id, {
        // Content sync just ran; permission sync is stale.
        lastSyncAt: new Date(),
        lastPermissionSyncAt: PAST(),
      });

      await handleCheckDuePermissionSyncs();

      const active = await TaskModel.findActivePayloadValues(
        "permission_sync",
        "connectorId",
      );
      expect(active.has(connector.id)).toBe(true);
    });

    test("does NOT enqueue permission_sync when the permission schedule is NOT due, even if the content schedule IS due", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      await OrganizationModel.patch(org.id, {
        permissionSyncSchedule: NEVER_SOON, // permission cadence: not due
      });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        visibility: "auto-sync-permissions",
        connectorType: "github",
        enabled: true,
        schedule: "* * * * *", // content cadence: always due
      });
      await KnowledgeBaseConnectorModel.update(connector.id, {
        // Recent permission sync → NEVER_SOON's next run is far in the future.
        lastPermissionSyncAt: new Date(),
      });

      await handleCheckDuePermissionSyncs();

      expect(await countPermissionSyncTasks(connector.id)).toBe(0);
    });
  });

  test("does NOT enqueue for a non-auto-sync connector (org-wide/team-scoped)", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      permissionSyncSchedule: "* * * * *", // always due, so only visibility gates it
    });
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "org-wide", // not auto-sync-permissions
      connectorType: "github",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastPermissionSyncAt: PAST(),
    });

    await handleCheckDuePermissionSyncs();

    expect(await countPermissionSyncTasks(connector.id)).toBe(0);
  });

  test("de-duplicates: does not enqueue a second permission_sync when one is already pending", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      permissionSyncSchedule: "* * * * *",
    });
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastPermissionSyncAt: PAST(),
    });
    // A permission_sync is already in flight for this connector.
    await TaskModel.create({
      taskType: "permission_sync",
      payload: { connectorId: connector.id },
      status: "pending",
    });

    await handleCheckDuePermissionSyncs();

    // Still exactly one — the handler de-duped against the active task.
    expect(await countPermissionSyncTasks(connector.id)).toBe(1);
  });

  describe("lease-based reaping", () => {
    const EXPIRED_LEASE = () => new Date(Date.now() - 60_000);

    test("reaps an expired-lease permission run and enqueues a resume within budget", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        visibility: "auto-sync-permissions",
        connectorType: "github",
        enabled: true,
      });
      // Recent last pass + NEVER_SOON schedule: the schedule branch stays
      // quiet, so any enqueue can only come from the reaper.
      await KnowledgeBaseConnectorModel.update(connector.id, {
        lastPermissionSyncAt: PAST(),
      });
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        runType: "permission",
        status: "running",
        startedAt: PAST(),
        leaseExpiresAt: EXPIRED_LEASE(),
      });

      await handleCheckDuePermissionSyncs();

      const reaped = await ConnectorRunModel.findById(run.id);
      expect(reaped?.status).toBe("partial");
      const updated = await KnowledgeBaseConnectorModel.findById(connector.id);
      expect(updated?.lastPermissionSyncStatus).toBe("partial");
      expect(await countPermissionSyncTasks(connector.id)).toBe(1);
    });

    test("does not auto-resume a repeatedly interrupted permission run over its budget", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        visibility: "auto-sync-permissions",
        connectorType: "github",
        enabled: true,
      });
      await KnowledgeBaseConnectorModel.update(connector.id, {
        lastPermissionSyncAt: PAST(),
      });
      // Burn the whole resume window budget with recent permission runs (a
      // crash loop). Far above any threshold maxRunsPerResumeWindow derives.
      for (let i = 0; i < 60; i++) {
        await makeConnectorRun(connector.id, {
          startedAt: new Date(),
          runType: "permission",
        });
      }
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        runType: "permission",
        status: "running",
        startedAt: PAST(),
        leaseExpiresAt: EXPIRED_LEASE(),
      });

      await handleCheckDuePermissionSyncs();

      // Reaped (checkpoint preserved for the next scheduled pass)…
      const reaped = await ConnectorRunModel.findById(run.id);
      expect(reaped?.status).toBe("partial");
      // …but NOT auto-resumed: the runaway breaker held the enqueue back.
      expect(await countPermissionSyncTasks(connector.id)).toBe(0);
    });
  });
});

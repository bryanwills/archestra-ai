import { describe, expect, test } from "@/test";
import { nextPermissionSyncDueAt } from "./permission-sync-schedule";

describe("nextPermissionSyncDueAt", () => {
  test("anchors the cron's interval at the last pass, not the next wall-clock slot", () => {
    // A manual pass at :48 under a 30-minute cadence is next due at :18 —
    // NOT at the :00 boundary 12 minutes later.
    const dueAt = nextPermissionSyncDueAt({
      schedule: "*/30 * * * *",
      lastPermissionSyncAt: new Date("2026-07-08T15:48:00.000Z"),
    });
    expect(dueAt?.toISOString()).toBe("2026-07-08T16:18:00.000Z");
  });

  test("derives an hourly cadence from an hourly cron", () => {
    const dueAt = nextPermissionSyncDueAt({
      schedule: "0 * * * *",
      lastPermissionSyncAt: new Date("2026-07-08T15:48:00.000Z"),
    });
    expect(dueAt?.toISOString()).toBe("2026-07-08T16:48:00.000Z");
  });

  test("a never-synced connector is due immediately", () => {
    const dueAt = nextPermissionSyncDueAt({
      schedule: "*/30 * * * *",
      lastPermissionSyncAt: null,
    });
    expect(dueAt).not.toBeNull();
    expect(dueAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("returns null for an unparsable schedule", () => {
    expect(
      nextPermissionSyncDueAt({
        schedule: "not a cron",
        lastPermissionSyncAt: new Date(),
      }),
    ).toBeNull();
  });
});

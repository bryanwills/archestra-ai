// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { Cron } from "croner";

/**
 * When the next scheduled permission pass is due for a connector.
 *
 * The schedule expresses a CADENCE, not wall-clock slots: the cron's
 * fire-to-fire gap is taken as the interval and anchored at the last pass, so
 * a manual pass pushes the next scheduled one a full interval out instead of
 * double-running at the next wall-clock boundary (a manual run at :48 under a
 * 30-minute cron is next due at :18, not :00). A connector that has never had
 * a pass is due immediately. Returns null for an unparsable schedule.
 */
export function nextPermissionSyncDueAt(params: {
  schedule: string;
  lastPermissionSyncAt: Date | null;
}): Date | null {
  try {
    const cron = new Cron(params.schedule);
    const last = params.lastPermissionSyncAt;
    if (!last) {
      return new Date();
    }
    // The interval that FOLLOWS the last pass, so irregular crons (e.g.
    // weekday-only) still yield a locally-correct gap.
    const firstFire = cron.nextRun(last);
    const secondFire = firstFire ? cron.nextRun(firstFire) : null;
    if (!firstFire || !secondFire) {
      return null;
    }
    return new Date(
      last.getTime() + (secondFire.getTime() - firstFire.getTime()),
    );
  } catch {
    return null;
  }
}
// SPDX-SnippetEnd

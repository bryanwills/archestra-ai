// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import { buildGroupToken, normalizeEmail } from "@/knowledge-base/acl-tokens";
import type { AclEntry, InsertKbExternalUserGroup } from "@/types";

/**
 * Snapshot of upstream group memberships for `auto-sync-permissions` connectors.
 * The permission-sync pass owns writes here via the mark-stale → upsert →
 * delete-stale cycle; the query path reads it (local join, no upstream call) to
 * resolve a user's `group:` tokens.
 */
class KbExternalUserGroupModel {
  /**
   * Mark every membership row for a connector stale, ahead of a fresh
   * `syncGroups()` enumeration. Live memberships clear the flag on re-upsert;
   * whatever stays stale after enumeration finishes is a revoked membership.
   */
  static async markStaleByConnector(connectorId: string): Promise<number> {
    const result = await db
      .update(schema.kbExternalUserGroupTable)
      .set({ stale: true })
      .where(eq(schema.kbExternalUserGroupTable.connectorId, connectorId));
    return result.rowCount ?? 0;
  }

  /**
   * Upsert a batch of memberships, clearing `stale` on conflict so re-observed
   * memberships survive the completion-gated sweep.
   */
  static async upsertMany(rows: InsertKbExternalUserGroup[]): Promise<void> {
    if (rows.length === 0) return;

    await db
      .insert(schema.kbExternalUserGroupTable)
      .values(
        rows.map((row) => ({
          ...row,
          memberEmail: normalizeEmail(row.memberEmail),
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.kbExternalUserGroupTable.connectorId,
          schema.kbExternalUserGroupTable.groupId,
          schema.kbExternalUserGroupTable.memberEmail,
        ],
        set: { stale: false, updatedAt: new Date() },
      });
  }

  /**
   * Delete the memberships still stale after a completed `syncGroups()`
   * enumeration — the revoked memberships. Called only once enumeration finishes
   * (completion-gated), so an interrupted run never wrongly drops a membership.
   */
  static async deleteStaleByConnector(connectorId: string): Promise<number> {
    const result = await db
      .delete(schema.kbExternalUserGroupTable)
      .where(
        and(
          eq(schema.kbExternalUserGroupTable.connectorId, connectorId),
          eq(schema.kbExternalUserGroupTable.stale, true),
        ),
      );
    return result.rowCount ?? 0;
  }

  /**
   * Resolve the namespaced `group:` tokens a user is entitled to, across the
   * given auto-sync connectors, via a local join on member email (no upstream
   * call on the query hot path). The email is normalized to match the stored
   * `memberEmail`.
   */
  static async findGroupTokensForUser(params: {
    memberEmail: string;
    connectorIds: string[];
  }): Promise<AclEntry[]> {
    if (params.connectorIds.length === 0) return [];

    const rows = await db
      .selectDistinct({
        connectorType: schema.kbExternalUserGroupTable.connectorType,
        groupId: schema.kbExternalUserGroupTable.groupId,
      })
      .from(schema.kbExternalUserGroupTable)
      .where(
        and(
          eq(
            schema.kbExternalUserGroupTable.memberEmail,
            normalizeEmail(params.memberEmail),
          ),
          inArray(
            schema.kbExternalUserGroupTable.connectorId,
            params.connectorIds,
          ),
        ),
      );

    return rows.map((row) =>
      buildGroupToken({
        connectorType: row.connectorType,
        groupId: row.groupId,
      }),
    );
  }

  static async deleteByConnector(connectorId: string): Promise<number> {
    const result = await db
      .delete(schema.kbExternalUserGroupTable)
      .where(eq(schema.kbExternalUserGroupTable.connectorId, connectorId));
    return result.rowCount ?? 0;
  }
}

export default KbExternalUserGroupModel;

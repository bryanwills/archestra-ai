// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import { and, eq, inArray, sql } from "drizzle-orm";
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
   * memberships survive the completion-gated sweep. A re-upsert also refreshes
   * the email/display name, so a member whose email BECOMES visible upstream
   * starts resolving on the next pass.
   */
  static async upsertMany(rows: InsertKbExternalUserGroup[]): Promise<void> {
    if (rows.length === 0) return;

    await db
      .insert(schema.kbExternalUserGroupTable)
      .values(
        rows.map((row) => ({
          ...row,
          memberEmail: row.memberEmail ? normalizeEmail(row.memberEmail) : null,
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.kbExternalUserGroupTable.connectorId,
          schema.kbExternalUserGroupTable.groupId,
          schema.kbExternalUserGroupTable.externalAccountId,
        ],
        set: {
          stale: false,
          memberEmail: sql`excluded.member_email`,
          displayName: sql`excluded.display_name`,
          accountType: sql`excluded.account_type`,
          updatedAt: new Date(),
        },
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

  /**
   * The full membership snapshot for a connector, each row annotated with the
   * Archestra org member it resolves to at query time. Resolution is the same
   * normalized-email join `findGroupTokensForUser` enforces with, so what this
   * reports is exactly what access control does: `user` is null when no org
   * member carries that email — or when the upstream hides the email entirely
   * (`memberEmail` null) — and the grant currently resolves to nobody.
   */
  static async findMembershipsWithUsersByConnector(params: {
    connectorId: string;
    organizationId: string;
  }): Promise<
    {
      groupId: string;
      externalAccountId: string;
      displayName: string | null;
      memberEmail: string | null;
      accountType: string | null;
      updatedAt: Date;
      user: { id: string; name: string } | null;
    }[]
  > {
    const t = schema.kbExternalUserGroupTable;
    const rows = await db
      .select({
        groupId: t.groupId,
        externalAccountId: t.externalAccountId,
        displayName: t.displayName,
        memberEmail: t.memberEmail,
        accountType: t.accountType,
        updatedAt: t.updatedAt,
        userId: schema.usersTable.id,
        userName: schema.usersTable.name,
        memberId: schema.membersTable.id,
      })
      .from(t)
      .leftJoin(
        schema.usersTable,
        sql`lower(${schema.usersTable.email}) = ${t.memberEmail}`,
      )
      .leftJoin(
        schema.membersTable,
        and(
          eq(schema.membersTable.userId, schema.usersTable.id),
          eq(schema.membersTable.organizationId, params.organizationId),
        ),
      )
      .where(eq(t.connectorId, params.connectorId))
      .orderBy(t.groupId, t.memberEmail, t.externalAccountId);

    return rows.map((row) => ({
      groupId: row.groupId,
      externalAccountId: row.externalAccountId,
      displayName: row.displayName,
      memberEmail: row.memberEmail,
      accountType: row.accountType,
      updatedAt: row.updatedAt,
      // A matching user account only counts if it is a member of this org.
      user:
        row.memberId && row.userId && row.userName !== null
          ? { id: row.userId, name: row.userName }
          : null,
    }));
  }

  static async deleteByConnector(connectorId: string): Promise<number> {
    const result = await db
      .delete(schema.kbExternalUserGroupTable)
      .where(eq(schema.kbExternalUserGroupTable.connectorId, connectorId));
    return result.rowCount ?? 0;
  }
}

export default KbExternalUserGroupModel;

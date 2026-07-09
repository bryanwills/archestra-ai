// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ConnectorType } from "@/types";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

/**
 * Snapshot of upstream group memberships for `auto-sync-permissions` connectors.
 *
 * The permission-sync pass expands each upstream group to its members and
 * upserts one row per `(connectorId, groupId, externalAccountId)` — EVERY
 * member is recorded, including those whose email the upstream hides (their
 * `memberEmail` is NULL). Documents carry the compact
 * `group:<connectorType>_<groupId>` token; at query time a user's email
 * resolves their group ids via a local join here (no upstream call on the hot
 * path). A NULL-email row never matches that join, so a hidden-email member is
 * fail-closed — but visible to admins in the User Groups tab instead of
 * silently dropped, and recoverable by a later pass once the email becomes
 * visible.
 *
 * `stale` implements the completion-gated sweep: a run marks every row stale,
 * re-upserts live memberships (clearing `stale`), then deletes the rows still
 * stale after enumeration finishes — so revoked memberships disappear.
 */
const kbExternalUserGroupTable = pgTable(
  "kb_external_user_group",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    connectorType: text("connector_type").$type<ConnectorType>().notNull(),
    groupId: text("group_id").notNull(),
    /**
     * Stable upstream principal id (Jira/Confluence accountId, GitHub login).
     * The upsert key, so a member is one row whether or not their email is
     * visible.
     */
    externalAccountId: text("external_account_id").notNull(),
    /** Upstream display name, for admin visibility of unresolvable members. */
    displayName: text("display_name"),
    /** NULL when the upstream hides the member's email (fail-closed). */
    memberEmail: text("member_email"),
    stale: boolean("stale").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One row per membership; ON CONFLICT clears `stale` on re-upsert.
    uniqueIndex("kb_external_user_group_unique_idx").on(
      table.connectorId,
      table.groupId,
      table.externalAccountId,
    ),
    // Query-time resolution: a user's email → their group tokens.
    index("kb_external_user_group_member_email_idx").on(table.memberEmail),
    index("kb_external_user_group_connector_id_idx").on(table.connectorId),
  ],
);

export default kbExternalUserGroupTable;

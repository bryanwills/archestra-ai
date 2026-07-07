// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import type { AclEntry, ConnectorType } from "@/types";

/**
 * Pure ACL token helpers shared by the document-side builder
 * (`source-access-control.ts`) and the query-side group resolver
 * (`models/kb-external-user-group.ts`). Kept dependency-free (no model imports)
 * so both sides can import it without an import cycle.
 */

/**
 * Case-fold + trim normalizer shared by every email that crosses the ACL
 * boundary: `user_email:<email>` on documents, `memberEmail` in the group
 * snapshot, and the querying `user.email`. All three MUST normalize identically
 * or matching silently fails (the email normalization data-contract).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Namespace an upstream group id by connector type so group ids never collide
 * across connectors: `group:<connectorType>_<groupId>`. The token written on a
 * document and the token resolved for a user at query time both go through this
 * function, guaranteeing the groupId data-contract byte-matches.
 */
export function buildGroupToken(params: {
  connectorType: ConnectorType;
  groupId: string;
}): AclEntry {
  return `group:${params.connectorType}_${params.groupId}`;
}

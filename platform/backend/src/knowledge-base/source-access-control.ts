// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import { userHasPermission } from "@/auth/utils";
import {
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
  TeamModel,
} from "@/models";
import type {
  AclEntry,
  ConnectorType,
  DocumentPermissions,
  KnowledgeBase,
  KnowledgeBaseConnector,
  KnowledgeSourceVisibility,
} from "@/types";

import { buildGroupToken, normalizeEmail } from "./acl-tokens";

/**
 * Upper bound on ACL entries per document. `kb_chunks.acl` is GIN-indexed and
 * every entry widens that index; a pathologically large explicit audience is
 * capped and over-approximated to `org:*` rather than materialize thousands of
 * `user_email:` / `group:` tokens per chunk. See `buildDocumentAccessControlList`.
 */
const MAX_DOCUMENT_ACL_ENTRIES = 1000;

type VisibilityScopedKnowledgeSource = {
  visibility: KnowledgeSourceVisibility;
  teamIds: string[];
};

type VisibilityScopedKnowledgeSourceUpdates = Partial<{
  visibility: KnowledgeSourceVisibility;
  teamIds: string[];
}>;

interface KnowledgeSourceAccessControlContext {
  canReadAll: boolean;
  teamIds: string[];
}

/**
 * @public — core ACL primitive of the permission-sync feature. Consumed by the
 * permission-sync pass and unit tests (outside knip's production view); exported
 * so both the pass and tests build a document's ACL through one authority.
 */
export function buildDocumentAccessControlList(params: {
  visibility: KnowledgeSourceVisibility;
  teamIds: string[];
  connectorType?: ConnectorType;
  permissions?: DocumentPermissions;
}): AclEntry[] {
  switch (params.visibility) {
    case "org-wide":
      return ["org:*"];
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    case "team-scoped":
      return params.teamIds.map((id): AclEntry => `team:${id}`);
    case "auto-sync-permissions":
      return buildAutoSyncDocumentAccessControlList({
        connectorType: params.connectorType,
        permissions: params.permissions,
      });
    // SPDX-SnippetEnd
  }
}

export function buildUserAccessControlList(params: {
  userEmail: string;
  teamIds: string[];
  /**
   * Namespaced `group:` tokens for the user's upstream group memberships,
   * resolved (local SQL, no upstream call) only when an in-scope connector is
   * `auto-sync-permissions`. See `KbExternalUserGroupModel.findGroupTokensForUser`.
   */
  groupTokens?: AclEntry[];
}): AclEntry[] {
  const acl: AclEntry[] = [
    "org:*",
    `user_email:${normalizeEmail(params.userEmail)}`,
  ];

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  for (const teamId of params.teamIds) {
    acl.push(`team:${teamId}`);
  }

  for (const token of params.groupTokens ?? []) {
    acl.push(token);
  }
  // SPDX-SnippetEnd

  return acl;
}

export function didKnowledgeSourceAclInputsChange(params: {
  current: VisibilityScopedKnowledgeSource;
  updates: VisibilityScopedKnowledgeSourceUpdates;
}): boolean {
  const nextVisibility = params.updates.visibility ?? params.current.visibility;
  const nextTeamIds = params.updates.teamIds ?? params.current.teamIds;

  return (
    nextVisibility !== params.current.visibility ||
    !haveSameTeamIds(params.current.teamIds, nextTeamIds)
  );
}

export function isTeamScopedWithoutTeams(params: {
  visibility: KnowledgeSourceVisibility;
  teamIds: string[];
}): boolean {
  return params.visibility === "team-scoped" && params.teamIds.length === 0;
}

class KnowledgeSourceAccessControlService {
  async buildAccessControlContext(params: {
    userId: string;
    organizationId: string;
  }): Promise<KnowledgeSourceAccessControlContext> {
    const [canReadAll, teamIds] = await Promise.all([
      userHasPermission(
        params.userId,
        params.organizationId,
        "knowledgeSource",
        "admin",
      ),
      TeamModel.getUserTeamIds(params.userId),
    ]);

    return {
      canReadAll,
      teamIds,
    };
  }

  canAccessKnowledgeBase(
    _accessControl: KnowledgeSourceAccessControlContext,
    _knowledgeBase: KnowledgeBase,
  ) {
    // Knowledge bases are just collections of connectors now. Visibility is
    // enforced at the connector layer, so KB-level access is always allowed.
    return true;
  }

  canAccessConnector(
    accessControl: KnowledgeSourceAccessControlContext,
    connector: KnowledgeBaseConnector,
  ) {
    return this.canAccessSource(accessControl, connector);
  }

  filterKnowledgeBases(
    accessControl: KnowledgeSourceAccessControlContext,
    knowledgeBases: KnowledgeBase[],
  ) {
    return knowledgeBases.filter((knowledgeBase) =>
      this.canAccessKnowledgeBase(accessControl, knowledgeBase),
    );
  }

  filterConnectors(
    accessControl: KnowledgeSourceAccessControlContext,
    connectors: KnowledgeBaseConnector[],
  ) {
    return connectors.filter((connector) =>
      this.canAccessConnector(accessControl, connector),
    );
  }

  buildConnectorDocumentAccessControlList(params: {
    connector: KnowledgeBaseConnector;
  }): AclEntry[] {
    return buildDocumentAccessControlList({
      visibility: params.connector.visibility,
      teamIds: params.connector.teamIds,
    });
  }

  async refreshConnectorDocumentAccessControlLists(
    connectorId: string,
  ): Promise<void> {
    const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
    if (!connector) {
      return;
    }

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Auto-sync connectors own their per-document ACLs via the permission-sync
    // pass; never bulk-overwrite them with a single connector-level ACL. The
    // next scheduled (epoch-fenced) permission pass is the authoritative writer.
    if (connector.visibility === "auto-sync-permissions") {
      return;
    }
    // SPDX-SnippetEnd

    const acl = this.buildConnectorDocumentAccessControlList({ connector });

    // Epoch-fenced: the connector was read (with its current `aclConfigEpoch`)
    // above, after the caller bumped the epoch on the visibility/teamIds change.
    // If another change bumps it again before these writes land, they no-op so
    // the newest config wins regardless of ordering.
    const aclConfigEpoch = connector.aclConfigEpoch;
    await Promise.all([
      KbDocumentModel.updateAclByConnector({
        connectorId,
        acl,
        aclConfigEpoch,
      }),
      KbChunkModel.updateAclByConnector({ connectorId, acl, aclConfigEpoch }),
    ]);
  }

  private canAccessSource(
    accessControl: KnowledgeSourceAccessControlContext,
    source: VisibilityScopedKnowledgeSource,
  ) {
    if (accessControl.canReadAll) {
      return true;
    }

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (source.visibility !== "team-scoped") {
      return true;
    }

    return source.teamIds.some((teamId) =>
      accessControl.teamIds.includes(teamId),
    );
    // SPDX-SnippetEnd
  }
}

export const knowledgeSourceAccessControlService =
  new KnowledgeSourceAccessControlService();

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Build a document's ACL from its extracted upstream audience:
 * `org:*` (public) ∪ `user_email:<email>` ∪ `group:<connectorType>_<groupId>`.
 *
 * Empty permissions ⇒ empty ACL ⇒ fail-closed (only admins, who bypass the ACL,
 * can retrieve it). A pathologically large audience is over-approximated to
 * `org:*` rather than bloat every chunk's GIN-indexed `acl` array.
 */
function buildAutoSyncDocumentAccessControlList(params: {
  connectorType?: ConnectorType;
  permissions?: DocumentPermissions;
}): AclEntry[] {
  const permissions = params.permissions;
  if (!permissions) {
    return [];
  }

  const acl: AclEntry[] = [];
  if (permissions.isPublic) {
    acl.push("org:*");
  }
  for (const email of permissions.users ?? []) {
    acl.push(`user_email:${normalizeEmail(email)}`);
  }
  // Groups can only be namespaced when the connector type is known; without it
  // the token could collide across connectors, so groups are dropped (the
  // permission-sync pass always supplies it).
  if (params.connectorType) {
    for (const groupId of permissions.groups ?? []) {
      acl.push(
        buildGroupToken({ connectorType: params.connectorType, groupId }),
      );
    }
  }

  const deduped = [...new Set(acl)];
  if (deduped.length > MAX_DOCUMENT_ACL_ENTRIES) {
    return ["org:*"];
  }
  return deduped;
}
// SPDX-SnippetEnd

function haveSameTeamIds(current: string[], next: string[]) {
  if (current.length !== next.length) {
    return false;
  }

  const currentSorted = [...current].sort();
  const nextSorted = [...next].sort();

  return currentSorted.every((teamId, index) => teamId === nextSorted[index]);
}

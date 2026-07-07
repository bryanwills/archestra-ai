// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
"use client";

import { Globe, RefreshCw, Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  VisibilitySelector as SharedVisibilitySelector,
  type VisibilityOption,
} from "@/components/visibility-selector";
import { useEnterpriseFeature } from "@/lib/config/config.query";
import { useTeams } from "@/lib/teams/team.query";

export type KnowledgeSourceVisibility =
  | "org-wide"
  | "team-scoped"
  | "auto-sync-permissions";

const VISIBILITY_OPTIONS: Record<
  KnowledgeSourceVisibility,
  VisibilityOption<KnowledgeSourceVisibility>
> = {
  "org-wide": {
    value: "org-wide",
    label: "Organization",
    description: "Anyone in your org can access this knowledge source",
    icon: Globe,
  },
  "team-scoped": {
    value: "team-scoped",
    label: "Teams",
    description: "Share this knowledge source with selected teams",
    icon: Users,
  },
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  "auto-sync-permissions": {
    value: "auto-sync-permissions",
    label: "Auto-sync permissions",
    description: "Sync access from the source system's own permissions",
    icon: RefreshCw,
  },
  // SPDX-SnippetEnd
};

const visibilityEntries = Object.entries(VISIBILITY_OPTIONS) as [
  KnowledgeSourceVisibility,
  VisibilityOption<KnowledgeSourceVisibility>,
][];

export function KnowledgeSourceVisibilitySelector({
  visibility,
  onVisibilityChange,
  teamIds,
  onTeamIdsChange,
  showTeamRequired,
  supportsAutoSync = false,
}: {
  visibility: KnowledgeSourceVisibility;
  onVisibilityChange: (visibility: KnowledgeSourceVisibility) => void;
  teamIds: string[];
  onTeamIdsChange: (ids: string[]) => void;
  showTeamRequired?: boolean;
  /** Whether the chosen connector type's implementation supports permission sync. */
  supportsAutoSync?: boolean;
}) {
  const { data: teams } = useTeams();
  const knowledgeBaseEnterprise = useEnterpriseFeature("knowledgeBase");

  const options = visibilityEntries.map(([value, option]) => {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Keep team-scoped visible per spec; disable when enterprise access
    // control isn't active or there are no teams yet.
    const isTeamScoped = value === "team-scoped";
    const noTeams = isTeamScoped && (teams ?? []).length === 0;
    const enterpriseLocked =
      isTeamScoped && !knowledgeBaseEnterprise && visibility !== "team-scoped";

    // Auto-sync-permissions: gated by the enterprise flag AND the connector
    // type supporting permission sync (Stage 1: GitHub / Confluence / Jira).
    const isAutoSync = value === "auto-sync-permissions";
    const alreadyAutoSync = visibility === "auto-sync-permissions";
    const autoSyncEnterpriseLocked =
      isAutoSync && !knowledgeBaseEnterprise && !alreadyAutoSync;
    const autoSyncUnsupported = isAutoSync && !supportsAutoSync;
    // SPDX-SnippetEnd

    const disabled =
      noTeams ||
      enterpriseLocked ||
      autoSyncEnterpriseLocked ||
      autoSyncUnsupported;
    const disabledLabel =
      enterpriseLocked || autoSyncEnterpriseLocked
        ? "Enterprise feature"
        : autoSyncUnsupported
          ? "Not supported for this source"
          : noTeams
            ? "No teams available"
            : undefined;
    return { ...option, value, disabled, disabledLabel };
  });

  return (
    <SharedVisibilitySelector
      value={visibility}
      options={options}
      onValueChange={onVisibilityChange}
    >
      {/* SPDX-SnippetBegin */}
      {/* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */}
      {/* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
      {visibility === "auto-sync-permissions" && (
        <p className="text-muted-foreground text-sm">
          Access is synced from the source system's own permissions on a
          schedule. Each user sees only the documents they can access upstream.
        </p>
      )}
      {/* SPDX-SnippetEnd */}
      {visibility === "team-scoped" && (
        <div className="space-y-2">
          <Label>
            Teams
            {showTeamRequired && (
              <span className="text-destructive ml-1">(required)</span>
            )}
          </Label>
          <MultiSelectCombobox
            options={
              teams?.map((team) => ({
                value: team.id,
                label: team.name,
              })) || []
            }
            value={teamIds}
            onChange={onTeamIdsChange}
            placeholder={
              teams?.length === 0 ? "No teams available" : "Search teams..."
            }
            emptyMessage="No teams found."
          />
        </div>
      )}
    </SharedVisibilitySelector>
  );
}

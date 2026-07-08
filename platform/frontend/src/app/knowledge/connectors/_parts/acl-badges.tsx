"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTeams } from "@/lib/teams/team.query";

const MAX_VISIBLE_ENTRIES = 3;

/**
 * Human-readable rendering of a document's ACL. Every entry kind the backend
 * writes is covered: `org:*`, `team:<id>` (resolved to the team name),
 * `user_email:<email>`, `group:<connectorType>_<groupId>`, and the empty ACL
 * (fail-closed — nobody can retrieve the document until a permission sync
 * tags it). Raw tokens stay available on hover for correlation with the
 * User Groups tab.
 */
export function AclBadges({ acl }: { acl: string[] }) {
  const { data: teams } = useTeams();

  if (acl.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="border-amber-600 text-amber-600 whitespace-nowrap"
          >
            Fail-closed
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          No one can retrieve this document yet — it stays access-restricted
          until a permission sync tags it with its source permissions.
        </TooltipContent>
      </Tooltip>
    );
  }

  const entries = acl.map((entry) => ({
    entry,
    label: formatAclEntry(entry, teams),
  }));
  const visible = entries.slice(0, MAX_VISIBLE_ENTRIES);
  const hidden = entries.slice(MAX_VISIBLE_ENTRIES);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map(({ entry, label }) => (
        <Badge
          key={entry}
          variant="secondary"
          className="max-w-[180px] font-normal"
          title={entry}
        >
          <span className="truncate">{label}</span>
        </Badge>
      ))}
      {hidden.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="font-normal">
              +{hidden.length}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              {hidden.map(({ entry, label }) => (
                <span key={entry}>{label}</span>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function formatAclEntry(
  entry: string,
  teams: { id: string; name: string }[] | undefined,
): string {
  if (entry === "org:*") {
    return "Everyone in org";
  }
  if (entry.startsWith("team:")) {
    const teamId = entry.slice("team:".length);
    const team = teams?.find(({ id }) => id === teamId);
    return `Team: ${team?.name ?? teamId}`;
  }
  if (entry.startsWith("user_email:")) {
    return entry.slice("user_email:".length);
  }
  if (entry.startsWith("group:")) {
    return `Group: ${entry.slice("group:".length)}`;
  }
  return entry;
}

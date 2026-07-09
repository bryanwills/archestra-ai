"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Users } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConnectorUserGroups } from "@/lib/knowledge/connector.query";
import { formatDate } from "@/lib/utils";

type ConnectorUserGroup =
  archestraApiTypes.GetConnectorUserGroupsResponses["200"]["groups"][number];
type ConnectorUserGroupMember = ConnectorUserGroup["members"][number];

/**
 * Admin visibility into the synced group snapshot: which upstream groups
 * exist, who is in them, and which Archestra org user each member resolves
 * to at query time (matched by email — the same join access control uses).
 */
export function ConnectorUserGroupsTable({
  connectorId,
}: {
  connectorId: string;
}) {
  const {
    data: userGroups,
    isPending,
    isError,
  } = useConnectorUserGroups({ connectorId, enabled: true });

  // The shared Table is `table-fixed`: explicit sizes keep wide member
  // badges from overflowing under the Documents column.
  const columns = useMemo<ColumnDef<ConnectorUserGroup>[]>(
    () => [
      {
        id: "group",
        accessorKey: "groupId",
        header: "Group",
        size: 260,
        cell: ({ row }) => (
          <div className="flex items-center gap-2 max-w-[280px]">
            <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {row.original.groupId}
              </div>
              <div
                className="truncate text-xs text-muted-foreground"
                title={row.original.token}
              >
                {row.original.token}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: "members",
        header: "Members",
        size: 380,
        minSize: 260,
        cell: ({ row }) => <MemberBadges members={row.original.members} />,
      },
      {
        id: "documentCount",
        accessorKey: "documentCount",
        header: "Documents",
        size: 100,
        cell: ({ row }) => (
          <span className="text-sm">
            {row.original.documentCount.toLocaleString()}
          </span>
        ),
      },
      {
        id: "lastSyncedAt",
        accessorKey: "lastSyncedAt",
        header: "Last Synced",
        size: 140,
        cell: ({ row }) =>
          row.original.lastSyncedAt ? (
            <span
              className="text-sm text-muted-foreground"
              title={formatDate({ date: row.original.lastSyncedAt })}
            >
              {formatDistanceToNow(new Date(row.original.lastSyncedAt), {
                addSuffix: true,
              })}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">-</span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Group membership synced from the source system. Members resolve to
        Archestra users by email — teams do not affect auto-synced permissions.
      </p>
      <DataTable
        columns={columns}
        data={userGroups?.groups ?? []}
        isLoading={isPending}
        emptyMessage={
          isError
            ? "Failed to load user groups. Please try again."
            : "No user groups synced yet. Groups appear after the first permission sync."
        }
      />
    </div>
  );
}

const MAX_VISIBLE_MEMBERS = 2;

/**
 * Members rendered like the Access/Models columns: the first two as badges,
 * everything else behind a "+N more" badge whose tooltip lists all collapsed
 * members (scrollable — an upstream group can have hundreds). Resolved
 * members keep the filled badge; unresolved ones use the same neutral outline
 * style as ACL badges, with the reason on hover.
 */
function MemberBadges({ members }: { members: ConnectorUserGroupMember[] }) {
  if (members.length === 0) {
    return (
      <span className="text-sm text-amber-600">
        No resolvable members — documents granting only this group are
        inaccessible
      </span>
    );
  }

  const visible = members.slice(0, MAX_VISIBLE_MEMBERS);
  const hidden = members.slice(MAX_VISIBLE_MEMBERS);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((member) => (
        <Badge
          key={member.accountId}
          variant={member.user ? "secondary" : "outline"}
          className="max-w-full text-xs font-normal"
          title={memberTitle(member)}
        >
          <span className="truncate">{memberLabel(member)}</span>
        </Badge>
      ))}
      {hidden.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="cursor-default text-xs font-normal"
            >
              +{hidden.length} more
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {hidden.map((member) => (
                <div key={member.accountId}>{memberLabel(member)}</div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function memberLabel(member: ConnectorUserGroupMember): string {
  const identity =
    member.email ?? `${member.displayName ?? member.accountId} · email hidden`;
  return member.user ? `${identity} · ${member.user.name}` : identity;
}

function memberTitle(member: ConnectorUserGroupMember): string {
  if (member.user) {
    return `Resolves to ${member.user.name}`;
  }
  if (member.email) {
    return "No Archestra user with this email — this grant currently resolves to nobody";
  }
  return "The source system hides this member's email, so they cannot be matched to a user — their access through this group stays fail-closed";
}

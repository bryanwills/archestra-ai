"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Users } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { useConnectorUserGroups } from "@/lib/knowledge/connector.query";
import { formatDate } from "@/lib/utils";

type ConnectorUserGroup =
  archestraApiTypes.GetConnectorUserGroupsResponses["200"]["groups"][number];

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

  const columns = useMemo<ColumnDef<ConnectorUserGroup>[]>(
    () => [
      {
        id: "group",
        accessorKey: "groupId",
        header: "Group",
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
        cell: ({ row }) =>
          row.original.members.length === 0 ? (
            <span className="text-sm text-amber-600">
              No resolvable members — documents granting only this group are
              inaccessible
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              {row.original.members.map((member) => (
                <Badge
                  key={member.email}
                  variant={member.user ? "secondary" : "outline"}
                  className={
                    member.user
                      ? "max-w-[240px] font-normal"
                      : "max-w-[240px] font-normal text-amber-600 border-amber-600"
                  }
                  title={
                    member.user
                      ? `Resolves to ${member.user.name}`
                      : "No Archestra user with this email — this grant currently resolves to nobody"
                  }
                >
                  <span className="truncate">
                    {member.email}
                    {member.user ? ` · ${member.user.name}` : ""}
                  </span>
                </Badge>
              ))}
            </div>
          ),
      },
      {
        id: "documentCount",
        accessorKey: "documentCount",
        header: "Documents",
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

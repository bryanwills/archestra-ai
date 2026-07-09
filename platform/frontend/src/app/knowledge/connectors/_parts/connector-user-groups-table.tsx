"use client";

import type { archestraApiTypes, ConnectorType } from "@archestra/shared";
import { DocsPage, getDocsUrl } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Users } from "lucide-react";
import { useMemo, useState } from "react";
import { getPermissionSyncCredentialNote } from "@/app/knowledge/knowledge-bases/_parts/connector-dialog-config";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

type GroupFilter = "all" | "needs-attention" | "fully-resolved";

/**
 * Admin visibility into the synced group snapshot: which upstream groups
 * exist, who is in them, and which Archestra org user each member resolves
 * to at query time (matched by email — the same join access control uses).
 * Beyond the raw table it answers the operational questions: how healthy is
 * resolution overall (stats strip), why members are unresolved and how to fix
 * it (credential-scope hint), and which groups matter most (severity-first
 * ordering, search, and an attention filter).
 */
export function ConnectorUserGroupsTable({
  connectorId,
  connectorType,
}: {
  connectorId: string;
  connectorType: ConnectorType;
}) {
  const {
    data: userGroups,
    isPending,
    isError,
  } = useConnectorUserGroups({ connectorId, enabled: true });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<GroupFilter>("all");

  const groups = useMemo(() => userGroups?.groups ?? [], [userGroups?.groups]);
  const stats = useMemo(() => computeMemberStats(groups), [groups]);

  const visibleGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    return groups
      .filter((group) => matchesFilter(group, filter))
      .filter((group) => matchesSearch(group, query))
      .sort(compareGroupsBySeverity);
  }, [groups, search, filter]);

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
        Groups that gate documents but resolve to nobody sort first.
      </p>

      {groups.length > 0 && <MemberStatsStrip stats={stats} />}

      {stats.hiddenEmail > 0 && (
        <UnresolvedMembersHint
          connectorType={connectorType}
          hiddenEmail={stats.hiddenEmail}
          noMatchingUser={stats.noMatchingUser}
        />
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full max-w-md">
            <SearchInput
              value={search}
              syncQueryParams={false}
              placeholder="Search groups and members..."
              onSearchChange={setSearch}
            />
          </div>
          <Tabs
            value={filter}
            onValueChange={(value) => setFilter(value as GroupFilter)}
          >
            <TabsList>
              <TabsTrigger value="all">All groups</TabsTrigger>
              <TabsTrigger value="needs-attention">Needs attention</TabsTrigger>
              <TabsTrigger value="fully-resolved">Fully resolved</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}

      <DataTable
        columns={columns}
        data={visibleGroups}
        isLoading={isPending}
        emptyMessage={
          isError
            ? "Failed to load user groups. Please try again."
            : groups.length > 0
              ? "No groups match your search or filter."
              : "No user groups synced yet. Groups appear after the first permission sync."
        }
      />
    </div>
  );
}

// ===== Internal pieces =====

const MAX_VISIBLE_MEMBERS = 2;

interface MemberStats {
  groups: number;
  /** Distinct upstream accounts across all groups. */
  uniqueMembers: number;
  resolved: number;
  hiddenEmail: number;
  noMatchingUser: number;
}

/**
 * Distinct-account rollup: the same person appears in many groups, so the
 * strip counts accounts, not memberships — "how many people resolve" is the
 * question the admin is actually asking.
 */
function computeMemberStats(groups: ConnectorUserGroup[]): MemberStats {
  const byAccount = new Map<string, ConnectorUserGroupMember>();
  for (const group of groups) {
    for (const member of group.members) {
      byAccount.set(member.accountId, member);
    }
  }
  const members = [...byAccount.values()];
  return {
    groups: groups.length,
    uniqueMembers: members.length,
    resolved: members.filter((m) => m.user).length,
    hiddenEmail: members.filter((m) => !m.user && !m.email).length,
    noMatchingUser: members.filter((m) => !m.user && m.email).length,
  };
}

function MemberStatsStrip({ stats }: { stats: MemberStats }) {
  const unresolved = stats.hiddenEmail + stats.noMatchingUser;
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-lg border p-4">
      <StatBlock label="Groups" value={stats.groups.toLocaleString()} />
      <StatBlock label="Members" value={stats.uniqueMembers.toLocaleString()} />
      <StatBlock
        label="Resolved"
        value={stats.resolved.toLocaleString()}
        detail="map to an Archestra user"
      />
      <StatBlock
        label="Unresolved"
        value={unresolved.toLocaleString()}
        detail={
          unresolved > 0
            ? `${stats.hiddenEmail.toLocaleString()} email hidden · ${stats.noMatchingUser.toLocaleString()} no matching user`
            : undefined
        }
        warn={unresolved > 0}
      />
    </div>
  );
}

function StatBlock({
  label,
  value,
  detail,
  warn,
}: {
  label: string;
  value: string;
  detail?: string;
  warn?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${warn ? "text-amber-600" : ""}`}>
        {value}
      </div>
      {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

/**
 * Turns the unresolved counts into a diagnosis + fix. A large hidden-email
 * count is a property of the connector credential's view of the source (not
 * of Archestra), so the hint explains the per-source visibility rule and what
 * an admin can change.
 */
function UnresolvedMembersHint({
  connectorType,
  hiddenEmail,
  noMatchingUser,
}: {
  connectorType: ConnectorType;
  hiddenEmail: number;
  noMatchingUser: number;
}) {
  const credentialNote = getPermissionSyncCredentialNote(connectorType);
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
      <p>
        <span className="font-medium">
          {hiddenEmail.toLocaleString()} member
          {hiddenEmail === 1 ? "" : "s"} can&apos;t be resolved
        </span>{" "}
        because the source system hides their email from this connector&apos;s
        credential.
        {credentialNote ? ` ${credentialNote}` : ""} Once an email becomes
        visible, the next permission sync resolves that member automatically.
      </p>
      {noMatchingUser > 0 && (
        <p>
          {noMatchingUser.toLocaleString()} member
          {noMatchingUser === 1 ? " has a" : "s have"} visible email
          {noMatchingUser === 1 ? "" : "s"} but no matching Archestra user —
          invite them with the same email and they get their access on first
          login, no extra sync needed.
        </p>
      )}
      <a
        href={getDocsUrl(DocsPage.PlatformKnowledge)}
        target="_blank"
        rel="noreferrer"
        className="font-medium underline underline-offset-4"
      >
        Learn more about upstream email visibility
      </a>
    </div>
  );
}

/**
 * Attention buckets: a group needs attention when any member is unresolved,
 * or when it gates documents nobody can reach (no resolvable members at all).
 */
function matchesFilter(group: ConnectorUserGroup, filter: GroupFilter) {
  if (filter === "all") return true;
  const resolved = group.members.filter((m) => m.user).length;
  const needsAttention =
    resolved < group.members.length ||
    (group.documentCount > 0 && resolved === 0);
  return filter === "needs-attention" ? needsAttention : !needsAttention;
}

function matchesSearch(group: ConnectorUserGroup, query: string) {
  if (!query) return true;
  if (
    group.groupId.toLowerCase().includes(query) ||
    group.token.toLowerCase().includes(query)
  ) {
    return true;
  }
  return group.members.some(
    (member) =>
      member.email?.toLowerCase().includes(query) ||
      member.displayName?.toLowerCase().includes(query) ||
      member.accountId.toLowerCase().includes(query) ||
      member.user?.name.toLowerCase().includes(query),
  );
}

/**
 * Severity-first default order, so the groups an admin must act on surface
 * without scrolling: (1) groups gating documents that resolve to nobody,
 * (2) then by how many documents the group gates, (3) then by unresolved
 * member count, (4) then alphabetically for a stable tail.
 */
function compareGroupsBySeverity(
  a: ConnectorUserGroup,
  b: ConnectorUserGroup,
): number {
  const severity = (g: ConnectorUserGroup) => {
    const resolved = g.members.filter((m) => m.user).length;
    return g.documentCount > 0 && resolved === 0 ? 1 : 0;
  };
  const unresolvedCount = (g: ConnectorUserGroup) =>
    g.members.filter((m) => !m.user).length;
  return (
    severity(b) - severity(a) ||
    b.documentCount - a.documentCount ||
    unresolvedCount(b) - unresolvedCount(a) ||
    a.groupId.localeCompare(b.groupId)
  );
}

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

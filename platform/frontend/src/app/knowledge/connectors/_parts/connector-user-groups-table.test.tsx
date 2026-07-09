import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorUserGroupsTable } from "./connector-user-groups-table";

const mockUseConnectorUserGroups = vi.fn();

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectorUserGroups: (args: unknown) => mockUseConnectorUserGroups(args),
}));

vi.mock("next/navigation");

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

function mockGroups() {
  mockUseConnectorUserGroups.mockReturnValue({
    data: {
      groups: [
        {
          groupId: "engineers",
          token: "group:jira_engineers",
          documentCount: 128,
          lastSyncedAt: "2026-07-08T15:00:00.000Z",
          members: [
            {
              accountId: "acc-alice",
              displayName: "Alice A",
              email: "alice@example.com",
              user: { id: "user-1", name: "Alice" },
            },
            {
              accountId: "acc-bob",
              displayName: "Bob B",
              email: "bob@example.com",
              user: null,
            },
            // Email hidden upstream: recorded, shown, fail-closed.
            {
              accountId: "acc-dave",
              displayName: "Dave D",
              email: null,
              user: null,
            },
          ],
        },
        {
          groupId: "ghosts",
          token: "group:jira_ghosts",
          documentCount: 3,
          lastSyncedAt: null,
          members: [],
        },
      ],
    },
    isPending: false,
    isError: false,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectorUserGroupsTable", () => {
  it("shows each group's members with their resolved org users", () => {
    mockGroups();

    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    expect(screen.getByText("engineers")).toBeInTheDocument();
    expect(screen.getByText("group:jira_engineers")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    // Resolved member shows the org user it maps to; unresolved shows email only.
    expect(screen.getByText("alice@example.com · Alice")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    // Past the 2 visible badges, members collapse behind +N more — the
    // hidden-email member is still listed (in the tooltip), not dropped.
    expect(screen.getByText("+1 more")).toBeInTheDocument();
    expect(screen.getByText("Dave D · email hidden")).toBeInTheDocument();
    // A group granted on documents but with no snapshot members is called out.
    expect(screen.getByText(/No resolvable members/)).toBeInTheDocument();
  });

  it("summarizes resolution health in the stats strip", () => {
    mockGroups();

    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    expect(screen.getByText("Groups")).toBeInTheDocument();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    // 3 distinct accounts: alice (resolved), bob (no matching user),
    // dave (email hidden) — 1 resolved, 2 unresolved.
    expect(screen.getByText("Unresolved")).toBeInTheDocument();
    expect(
      screen.getByText("1 email hidden · 1 no matching user"),
    ).toBeInTheDocument();
  });

  it("diagnoses unresolved members with the credential-scope hint and the invite path", () => {
    mockGroups();

    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    // Hidden emails are a credential-visibility property of the source.
    expect(screen.getByText(/1 member can't be resolved/)).toBeInTheDocument();
    expect(
      screen.getByText(/Atlassian Cloud only returns/),
    ).toBeInTheDocument();
    // Visible email but no account → inviting the user closes the gap.
    expect(
      screen.getByText(/invite them with the same email/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: /Learn more about upstream email visibility/,
      }),
    ).toBeInTheDocument();
  });

  it("sorts groups that gate documents nobody can reach to the top", () => {
    mockGroups();

    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    // "ghosts" gates 3 documents with zero resolvable members — highest
    // severity, above "engineers" despite its far larger document count.
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("ghosts");
    expect(rows[2]).toHaveTextContent("engineers");
  });

  it("filters to fully resolved groups and reports when nothing matches", async () => {
    const { userEvent } = await import("@testing-library/user-event").then(
      (m) => ({ userEvent: m.default.setup() }),
    );
    mockGroups();

    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    // Neither group is fully resolved (engineers has unresolved members,
    // ghosts has none at all).
    await userEvent.click(screen.getByRole("tab", { name: "Fully resolved" }));
    expect(
      screen.getByText("No groups match your search or filter."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Needs attention" }));
    expect(screen.getByText("engineers")).toBeInTheDocument();
    expect(screen.getByText("ghosts")).toBeInTheDocument();
  });

  it("searches across group names and member identities", () => {
    vi.useFakeTimers();
    mockGroups();

    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    // A member email finds the groups containing that member.
    fireEvent.change(
      screen.getByPlaceholderText("Search groups and members..."),
      { target: { value: "bob@example.com" } },
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByText("engineers")).toBeInTheDocument();
    expect(screen.queryByText("ghosts")).not.toBeInTheDocument();
  });

  it("explains the email-based mapping and shows an empty state before the first sync", () => {
    mockUseConnectorUserGroups.mockReturnValue({
      data: { groups: [] },
      isPending: false,
      isError: false,
    });

    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    expect(
      screen.getByText(/Members resolve to Archestra users by email/),
    ).toBeInTheDocument();
    expect(screen.getByText(/No user groups synced yet/)).toBeInTheDocument();
  });
});

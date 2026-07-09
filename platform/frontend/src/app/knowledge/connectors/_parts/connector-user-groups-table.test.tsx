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
              accountType: "atlassian",
              user: { id: "user-1", name: "Alice" },
            },
            {
              accountId: "acc-bob",
              displayName: "Bob B",
              email: "bob@example.com",
              accountType: "atlassian",
              user: null,
            },
            // Email hidden upstream: recorded, shown, fail-closed.
            {
              accountId: "acc-dave",
              displayName: "Dave D",
              email: null,
              accountType: null,
              user: null,
            },
            // Add-on/bot account: no email BY NATURE — excluded from
            // resolution stats, labeled instead of read as a credential gap.
            {
              accountId: "acc-bot",
              displayName: "Automation for Jira",
              email: null,
              accountType: "app",
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
    expect(screen.getByText("+2 more")).toBeInTheDocument();
    expect(screen.getByText("Dave D · email hidden")).toBeInTheDocument();
    // The bot is labeled as an app account, not as a hidden-email human.
    expect(screen.getByText("Automation for Jira · app")).toBeInTheDocument();
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
    // 3 distinct human accounts: alice (resolved), bob (no matching user),
    // dave (email hidden) — the add-on bot is counted separately, NOT as an
    // unresolvable human.
    expect(screen.getByText("Unresolved")).toBeInTheDocument();
    expect(
      screen.getByText("email hidden: 1 · no matching user: 1"),
    ).toBeInTheDocument();
    expect(screen.getByText("+ 1 app account")).toBeInTheDocument();
  });

  it("omits zero-count unresolved reasons from the detail line", () => {
    mockUseConnectorUserGroups.mockReturnValue({
      data: {
        groups: [
          {
            groupId: "engineers",
            token: "group:jira_engineers",
            documentCount: 1,
            lastSyncedAt: "2026-07-08T15:00:00.000Z",
            members: [
              {
                accountId: "acc-dave",
                displayName: "Dave D",
                email: null,
                accountType: null,
                user: null,
              },
            ],
          },
        ],
      },
      isPending: false,
      isError: false,
    });

    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    expect(screen.getByText("email hidden: 1")).toBeInTheDocument();
    expect(screen.queryByText(/no matching user/)).not.toBeInTheDocument();
  });

  it("diagnoses unresolved members with the credential-scope hint and the invite path", () => {
    mockGroups();

    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    // Two sentences: what is wrong, then the per-source fix.
    expect(
      screen.getByText(/1 member can't get document access/),
    ).toBeInTheDocument();
    // The source is named dynamically per connector type.
    expect(
      screen.getByText(/because Jira hides their email/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/profile email visibility to "Anyone"/),
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
    // Radix Select relies on pointer-capture + scrollIntoView, which jsdom
    // does not implement.
    window.HTMLElement.prototype.hasPointerCapture = vi.fn();
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
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
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter groups" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Fully resolved" }),
    );
    expect(
      screen.getByText("No groups match your search or filter."),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter groups" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Needs attention" }),
    );
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

  it("shows an empty state before the first sync", () => {
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

    expect(screen.getByText(/No user groups synced yet/)).toBeInTheDocument();
  });
});

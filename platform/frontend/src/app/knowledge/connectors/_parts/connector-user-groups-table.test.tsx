import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectorUserGroupsTable } from "./connector-user-groups-table";

const mockUseConnectorUserGroups = vi.fn();

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectorUserGroups: (args: unknown) => mockUseConnectorUserGroups(args),
}));

describe("ConnectorUserGroupsTable", () => {
  it("shows each group's members with their resolved org users", () => {
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

    render(<ConnectorUserGroupsTable connectorId="connector-1" />);

    expect(screen.getByText("engineers")).toBeInTheDocument();
    expect(screen.getByText("group:jira_engineers")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    // Resolved member shows the org user it maps to; unresolved shows email only.
    expect(screen.getByText("alice@example.com · Alice")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    // A hidden-email member is still listed, flagged instead of dropped.
    expect(screen.getByText("Dave D · email hidden")).toBeInTheDocument();
    // A group granted on documents but with no snapshot members is called out.
    expect(screen.getByText(/No resolvable members/)).toBeInTheDocument();
  });

  it("explains the email-based mapping and shows an empty state before the first sync", () => {
    mockUseConnectorUserGroups.mockReturnValue({
      data: { groups: [] },
      isPending: false,
      isError: false,
    });

    render(<ConnectorUserGroupsTable connectorId="connector-1" />);

    expect(
      screen.getByText(/Members resolve to Archestra users by email/),
    ).toBeInTheDocument();
    expect(screen.getByText(/No user groups synced yet/)).toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEnterpriseFeature } from "@/lib/config/config.query";
import { useTeams } from "@/lib/teams/team.query";
import { KnowledgeSourceVisibilitySelector } from "./knowledge-source-visibility-selector";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/teams/team.query");

function renderSelector(props: {
  visibility?: "org-wide" | "team-scoped" | "auto-sync-permissions";
  supportsAutoSync?: boolean;
}) {
  render(
    <KnowledgeSourceVisibilitySelector
      visibility={props.visibility ?? "org-wide"}
      onVisibilityChange={vi.fn()}
      teamIds={[]}
      onTeamIdsChange={vi.fn()}
      supportsAutoSync={props.supportsAutoSync ?? false}
    />,
  );
}

describe("KnowledgeSourceVisibilitySelector — auto-sync-permissions", () => {
  beforeEach(() => {
    vi.mocked(useTeams).mockReturnValue({
      data: [{ id: "team-1", name: "Team 1" }],
    } as ReturnType<typeof useTeams>);
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);
  });

  // The selector renders collapsed; click the summary to reveal the options.
  function expandOptions() {
    fireEvent.click(screen.getByText("Organization"));
  }

  function autoSyncButton(): HTMLButtonElement {
    expandOptions();
    const label = screen.getByText("Auto-sync permissions");
    const button = label.closest("button");
    if (!button) throw new Error("Auto-sync option is not a button");
    return button;
  }

  it("offers the Auto-sync permissions option, enabled for a supported connector", () => {
    renderSelector({ supportsAutoSync: true });
    expect(autoSyncButton()).toBeEnabled();
  });

  it("disables the option for a connector type that does not support it", () => {
    renderSelector({ supportsAutoSync: false });
    const button = autoSyncButton();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Not supported for this source");
  });

  it("disables the option when the enterprise feature is off", () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(false);
    renderSelector({ supportsAutoSync: true });
    const button = autoSyncButton();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Enterprise feature");
  });

  it("shows the synced-access note and no team control when auto-sync is selected", () => {
    renderSelector({
      visibility: "auto-sync-permissions",
      supportsAutoSync: true,
    });
    expect(
      screen.getByText(/Access is synced from the source system/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Teams")).not.toBeInTheDocument();
  });
});

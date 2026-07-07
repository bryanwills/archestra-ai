import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mock handles (referenced inside the module factories below) ---
const {
  mockUseConnector,
  mockUseConnectorRuns,
  mockUseConnectorKnowledgeBases,
} = vi.hoisted(() => ({
  mockUseConnector: vi.fn(),
  mockUseConnectorRuns: vi.fn(),
  mockUseConnectorKnowledgeBases: vi.fn(),
}));

const noopMutation = () => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  isPending: false,
});

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnector: (id: string) => mockUseConnector(id),
  useConnectorRuns: (params: unknown) => mockUseConnectorRuns(params),
  useConnectorKnowledgeBases: (id: string) =>
    mockUseConnectorKnowledgeBases(id),
  useSyncConnector: () => noopMutation(),
  useForceResyncConnector: () => noopMutation(),
  useTestConnectorConnection: () => noopMutation(),
  useAssignConnectorToKnowledgeBases: () => noopMutation(),
  useUnassignConnectorFromKnowledgeBase: () => noopMutation(),
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: () => ({ data: [], isPending: false }),
}));

// Heavy child dialogs/tables are out of scope for these behavior tests.
vi.mock(
  "@/app/knowledge/connectors/_parts/connector-run-details-dialog",
  () => ({ ConnectorRunDetailsDialog: () => null }),
);
vi.mock("@/app/knowledge/connectors/_parts/connector-documents-table", () => ({
  ConnectorDocumentsTable: () => null,
}));
vi.mock("@/app/knowledge/knowledge-bases/_parts/edit-connector-dialog", () => ({
  EditConnectorDialog: () => null,
}));

vi.mock("next/navigation");

import { usePathname, useSearchParams } from "next/navigation";

import ConnectorDetailPage from "./page.client";

const CONNECTOR_ID = "conn-1";

function makeConnector(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: CONNECTOR_ID,
    name: "My Connector",
    description: null,
    connectorType: "google-drive",
    visibility: "org-wide",
    enabled: true,
    lastSyncStatus: "success",
    lastSyncAt: null,
    totalDocsIngested: 0,
    schedule: null,
    ...overrides,
  };
}

function setSearchParams(params: Record<string, string>) {
  vi.mocked(useSearchParams).mockReturnValue({
    get: (key: string) => params[key] ?? null,
    toString: () => new URLSearchParams(params).toString(),
  } as unknown as ReturnType<typeof useSearchParams>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(usePathname).mockReturnValue(
    `/knowledge/connectors/${CONNECTOR_ID}`,
  );
  setSearchParams({});
  mockUseConnector.mockReturnValue({
    data: makeConnector(),
    isPending: false,
    isLoadingError: false,
    refetch: vi.fn(),
  });
  mockUseConnectorRuns.mockReturnValue({ data: null, isPending: false });
  mockUseConnectorKnowledgeBases.mockReturnValue({
    data: { data: [] },
    isPending: false,
  });
});

describe("ConnectorDetailPage", () => {
  describe("Permission Sync Runs tab visibility", () => {
    it("shows the Permission Sync Runs tab for auto-sync-permissions connectors", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      // PageLayout renders the tab list twice (desktop + mobile), so each label
      // appears more than once; assert on the first match.
      const permissionTabs = screen.getAllByRole("link", {
        name: "Permission Sync Runs",
      });
      expect(permissionTabs.length).toBeGreaterThan(0);
      expect(permissionTabs[0]).toHaveAttribute(
        "href",
        `/knowledge/connectors/${CONNECTOR_ID}?tab=permission-runs`,
      );
      // The base "Sync Runs" content tab is always present.
      expect(
        screen.getAllByRole("link", { name: "Sync Runs" }).length,
      ).toBeGreaterThan(0);
    });

    it("hides the Permission Sync Runs tab for non-auto-sync connectors", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "org-wide" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(
        screen.queryAllByRole("link", { name: "Permission Sync Runs" }),
      ).toHaveLength(0);
      expect(
        screen.getAllByRole("link", { name: "Sync Runs" }).length,
      ).toBeGreaterThan(0);
    });
  });

  describe("useConnectorRuns runType wiring", () => {
    it("requests content runs on the default Sync Runs tab", () => {
      setSearchParams({});
      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(mockUseConnectorRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          connectorId: CONNECTOR_ID,
          runType: "content",
        }),
      );
    });

    it("requests permission runs on the Permission Sync Runs tab", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permission-runs" });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(mockUseConnectorRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          connectorId: CONNECTOR_ID,
          runType: "permission",
        }),
      );
    });

    it("shows the permission-specific empty state on the Permission Sync Runs tab", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permission-runs" });
      mockUseConnectorRuns.mockReturnValue({
        data: { data: [], pagination: { total: 0 } },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(
        screen.getByText(/No permission sync runs yet/),
      ).toBeInTheDocument();
    });
  });
});

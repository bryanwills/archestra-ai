import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mock handles (referenced inside the module factories below) ---
const {
  mockUseConnector,
  mockUseConnectorRuns,
  mockUseConnectorKnowledgeBases,
  mockUseConnectorPermissionCoverage,
  mockTriggerPermissionSyncMutate,
} = vi.hoisted(() => ({
  mockUseConnector: vi.fn(),
  mockUseConnectorRuns: vi.fn(),
  mockUseConnectorKnowledgeBases: vi.fn(),
  mockUseConnectorPermissionCoverage: vi.fn(),
  mockTriggerPermissionSyncMutate: vi.fn(),
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
  useConnectorPermissionCoverage: (params: unknown) =>
    mockUseConnectorPermissionCoverage(params),
  useTriggerPermissionSync: () => ({
    mutate: mockTriggerPermissionSyncMutate,
    mutateAsync: vi.fn(),
    isPending: false,
  }),
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
  mockUseConnectorPermissionCoverage.mockReturnValue({ data: null });
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

    it("shows the embedding phase with batch progress for a draining content run", () => {
      // totalBatches is only set once the ingest loop finishes, so a running
      // run with it set is draining embeddings — the frozen Processed count
      // must not read as a hang.
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "run-1",
              connectorId: CONNECTOR_ID,
              status: "running",
              runType: "content",
              startedAt: "2026-07-08T10:00:00Z",
              completedAt: null,
              documentsProcessed: 22915,
              documentsIngested: 22915,
              totalItems: 22915,
              totalBatches: 459,
              completedBatches: 324,
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(
        screen.getByText("embedding · 324/459 batches"),
      ).toBeInTheDocument();
    });

    it("shows the ingesting phase for a running content run before batches are set", () => {
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "run-2",
              connectorId: CONNECTOR_ID,
              status: "running",
              runType: "content",
              startedAt: "2026-07-08T10:00:00Z",
              completedAt: null,
              documentsProcessed: 120,
              documentsIngested: 120,
              totalItems: 500,
              totalBatches: null,
              completedBatches: null,
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.getByText("ingesting documents")).toBeInTheDocument();
    });

    it("shows no phase line for completed runs", () => {
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "run-3",
              connectorId: CONNECTOR_ID,
              status: "success",
              runType: "content",
              startedAt: "2026-07-08T10:00:00Z",
              completedAt: "2026-07-08T11:00:00Z",
              documentsProcessed: 500,
              documentsIngested: 500,
              totalItems: 500,
              totalBatches: 10,
              completedBatches: 10,
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.queryByText(/embedding ·/)).not.toBeInTheDocument();
      expect(screen.queryByText("ingesting documents")).not.toBeInTheDocument();
    });

    it("shows permission-run stats columns and the during-content-sync badge on the permission tab", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permission-runs" });
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "prun-1",
              connectorId: CONNECTOR_ID,
              status: "success",
              runType: "permission",
              startedAt: "2026-07-08T14:46:36Z",
              completedAt: "2026-07-08T14:50:14Z",
              documentsProcessed: 0,
              documentsIngested: 0,
              stats: {
                totalDocs: 22915,
                docsScanned: 22915,
                aclsChanged: 13831,
                chunksRewritten: 14000,
                failClosed: 3,
                groupsSynced: 6,
                membershipsUpserted: 6,
                contentSyncActiveDuringRun: true,
              },
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      // Family-relevant columns instead of Processed/Ingested.
      expect(screen.getByText("Docs scanned")).toBeInTheDocument();
      expect(screen.getByText("ACLs changed")).toBeInTheDocument();
      expect(screen.getByText("Fail-closed")).toBeInTheDocument();
      expect(screen.queryByText("Processed")).not.toBeInTheDocument();
      expect(screen.queryByText("Ingested")).not.toBeInTheDocument();
      expect(screen.getByText("13,831")).toBeInTheDocument();
      // The legibility badge: this success ran during a content backfill.
      expect(screen.getByText("during content sync")).toBeInTheDocument();
    });

    it("shows the coverage banner with pending documents and triggers a manual sync", async () => {
      const { userEvent } = await import("@testing-library/user-event").then(
        (m) => ({ userEvent: m.default.setup() }),
      );
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      mockUseConnectorPermissionCoverage.mockReturnValue({
        data: {
          totalDocuments: 100,
          failClosedDocuments: 40,
          permissionSyncRunning: false,
          nextScheduledAt: "2026-07-08T16:00:00Z",
        },
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(
        screen.getByText(/40 documents awaiting permission sync/),
      ).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: /Sync permissions now/ }),
      );
      expect(mockTriggerPermissionSyncMutate).toHaveBeenCalledWith(
        CONNECTOR_ID,
      );
    });

    it("shows full coverage when no documents are fail-closed", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      mockUseConnectorPermissionCoverage.mockReturnValue({
        data: {
          totalDocuments: 22915,
          failClosedDocuments: 0,
          permissionSyncRunning: false,
          nextScheduledAt: null,
        },
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(
        screen.getByText(/22,915 \/ 22,915 documents tagged/),
      ).toBeInTheDocument();
    });

    it("hides the coverage banner for non-auto-sync connectors", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "org-wide" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      mockUseConnectorPermissionCoverage.mockReturnValue({
        data: {
          totalDocuments: 100,
          failClosedDocuments: 40,
          permissionSyncRunning: false,
          nextScheduledAt: null,
        },
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(
        screen.queryByText(/Permissions coverage/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/awaiting permission sync/),
      ).not.toBeInTheDocument();
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

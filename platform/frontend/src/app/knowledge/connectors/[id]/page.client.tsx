"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowLeft,
  Database,
  Logs,
  MoreHorizontal,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ConnectorDocumentsTable } from "@/app/knowledge/connectors/_parts/connector-documents-table";
import { ConnectorRunDetailsDialog } from "@/app/knowledge/connectors/_parts/connector-run-details-dialog";
import { ConnectorStatusDot } from "@/app/knowledge/knowledge-bases/_parts/connector-enabled-dot";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { EditConnectorDialog } from "@/app/knowledge/knowledge-bases/_parts/edit-connector-dialog";
import { FormDialog } from "@/components/form-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { MetadataItem } from "@/components/metadata-card";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useAssignConnectorToKnowledgeBases,
  useConnector,
  useConnectorKnowledgeBases,
  useConnectorPermissionCoverage,
  useConnectorRuns,
  useForceResyncConnector,
  useSyncConnector,
  useTestConnectorConnection,
  useTriggerPermissionSync,
  useUnassignConnectorFromKnowledgeBase,
} from "@/lib/knowledge/connector.query";
import { useKnowledgeBases } from "@/lib/knowledge/knowledge-base.query";
import { formatDate } from "@/lib/utils";
import { formatCronSchedule } from "@/lib/utils/format-cron";

type ConnectorRunItem =
  archestraApiTypes.GetConnectorRunsResponses["200"]["data"][number];

/**
 * Phase of a RUNNING content-sync run. A content run first ingests documents,
 * then drains its queued embedding batches — `totalBatches` is only set once
 * the ingest loop finishes, which makes it the phase discriminator. Surfacing
 * the embedding phase matters: during a long drain the Processed count sits
 * frozen at the total, which otherwise reads as a hang.
 */
function contentRunPhase(
  run: ConnectorRunItem,
): { label: string; progress: number | null } | null {
  if (run.status !== "running" || run.runType !== "content") return null;
  const totalBatches = run.totalBatches ?? 0;
  if (totalBatches > 0) {
    const completed = run.completedBatches ?? 0;
    return {
      label: `embedding · ${completed}/${totalBatches} batches`,
      progress: Math.min(100, Math.round((completed / totalBatches) * 100)),
    };
  }
  const total = run.totalItems ?? 0;
  const processed = run.documentsProcessed ?? 0;
  return {
    label: "ingesting documents",
    progress:
      total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : null,
  };
}

export default function ConnectorDetailPage({
  connectorId,
}: {
  connectorId: string;
}) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <ConnectorDetail connectorId={connectorId} />
      </ErrorBoundary>
    </div>
  );
}

function ConnectorDetail({ connectorId }: { connectorId: string }) {
  const searchParams = useSearchParams();
  const from = searchParams.get("from");
  const backHref =
    from === "knowledge-bases"
      ? "/knowledge/knowledge-bases"
      : "/knowledge/connectors";
  const backLabel =
    from === "knowledge-bases"
      ? "Back to Knowledge Bases"
      : "Back to Connectors";
  const tabParam = searchParams.get("tab");
  const currentTab =
    tabParam === "documents"
      ? "documents"
      : tabParam === "permission-runs"
        ? "permission-runs"
        : "runs";

  const {
    data: connector,
    isPending,
    isLoadingError,
    refetch,
  } = useConnector(connectorId);

  // The "Permission Sync Runs" tab exists only for auto-sync-permissions
  // connectors; content and permission runs are shown in separate tabs, each
  // filtered by runType.
  const isAutoSync = connector?.visibility === "auto-sync-permissions";
  const tabs = [
    { label: "Sync Runs", href: `/knowledge/connectors/${connectorId}` },
    ...(isAutoSync
      ? [
          {
            label: "Permission Sync Runs",
            href: `/knowledge/connectors/${connectorId}?tab=permission-runs`,
          },
        ]
      : []),
    {
      label: "Documents",
      href: `/knowledge/connectors/${connectorId}?tab=documents`,
    },
  ];
  const syncConnector = useSyncConnector();
  const forceResync = useForceResyncConnector();
  const testConnection = useTestConnectorConnection();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isForceResyncOpen, setIsForceResyncOpen] = useState(false);

  const [pageIndex, setPageIndex] = useState(0);
  const pageSize = 10;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: runsData, isPending: isRunsPending } = useConnectorRuns({
    connectorId,
    limit: pageSize,
    offset: pageIndex * pageSize,
    runType: currentTab === "permission-runs" ? "permission" : "content",
  });

  const handleSync = useCallback(async () => {
    await syncConnector.mutateAsync(connectorId);
  }, [syncConnector, connectorId]);

  const handleTestConnection = useCallback(async () => {
    await testConnection.mutateAsync(connectorId);
  }, [testConnection, connectorId]);

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      setPageIndex(newPagination.pageIndex);
    },
    [],
  );

  const columns: ColumnDef<ConnectorRunItem>[] = [
    {
      id: "status",
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => {
        const run = row.original;
        const phase = contentRunPhase(run);
        if (!phase) return <ConnectorStatusBadge status={run.status} />;
        return (
          <div className="space-y-1">
            <ConnectorStatusBadge status={run.status} />
            <div className="flex items-center gap-2">
              {phase.progress !== null && (
                <Progress value={phase.progress} className="h-1 w-16" />
              )}
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {phase.label}
              </span>
            </div>
          </div>
        );
      },
    },
    {
      id: "startedAt",
      accessorKey: "startedAt",
      header: "Started",
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({ date: row.original.startedAt })}
        </div>
      ),
    },
    {
      id: "completedAt",
      header: "Completed",
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {row.original.completedAt
            ? formatDate({ date: row.original.completedAt })
            : "-"}
        </div>
      ),
    },
    {
      id: "documentsProcessed",
      header: "Processed",
      cell: ({ row }) => {
        const processed = row.original.documentsProcessed ?? 0;
        const total = row.original.totalItems;
        return (
          <div>
            {processed}
            {total != null && total > 0 && (
              <span className="text-muted-foreground"> / {total}</span>
            )}
          </div>
        );
      },
    },
    {
      id: "documentsIngested",
      header: "Ingested",
      cell: ({ row }) => <div>{row.original.documentsIngested ?? 0}</div>,
    },
    {
      id: "logs",
      header: "Logs",
      cell: ({ row }) => {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground"
                onClick={() => setSelectedRunId(row.original.id)}
                aria-label="View run logs"
              >
                <Logs className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>View logs</TooltipContent>
          </Tooltip>
        );
      },
    },
  ];

  // Permission runs get family-relevant columns: the content counters
  // (Processed/Ingested) are always 0 for them; what matters is how much of
  // the corpus was scanned, what changed, and what fail-closed.
  const permissionColumns: ColumnDef<ConnectorRunItem>[] = [
    {
      id: "status",
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => {
        const run = row.original;
        return (
          <div className="space-y-1">
            <ConnectorStatusBadge status={run.status} />
            {run.stats?.contentSyncActiveDuringRun && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="text-xs font-normal">
                    during content sync
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  A content sync was still ingesting when this pass ran.
                  Documents ingested after it started stay access-restricted
                  until the next pass.
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        );
      },
    },
    {
      id: "startedAt",
      accessorKey: "startedAt",
      header: "Started",
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({ date: row.original.startedAt })}
        </div>
      ),
    },
    {
      id: "completedAt",
      header: "Completed",
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {row.original.completedAt
            ? formatDate({ date: row.original.completedAt })
            : "-"}
        </div>
      ),
    },
    {
      id: "docsScanned",
      header: "Docs scanned",
      cell: ({ row }) => {
        const stats = row.original.stats;
        if (!stats) return <div className="text-muted-foreground">-</div>;
        return (
          <div>
            {stats.docsScanned.toLocaleString()}
            {stats.totalDocs > 0 && (
              <span className="text-muted-foreground">
                {" "}
                / {stats.totalDocs.toLocaleString()}
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: "aclsChanged",
      header: "ACLs changed",
      cell: ({ row }) => (
        <div>{row.original.stats?.aclsChanged.toLocaleString() ?? "-"}</div>
      ),
    },
    {
      id: "failClosed",
      header: "Fail-closed",
      cell: ({ row }) => {
        const failClosed = row.original.stats?.failClosed;
        if (failClosed == null)
          return <div className="text-muted-foreground">-</div>;
        return (
          <div className={failClosed > 0 ? "text-amber-600" : undefined}>
            {failClosed.toLocaleString()}
          </div>
        );
      },
    },
    {
      id: "groupsSynced",
      header: "Groups",
      cell: ({ row }) => (
        <div>{row.original.stats?.groupsSynced.toLocaleString() ?? "-"}</div>
      ),
    },
    // Reuse the content table's logs column (same details dialog).
    columns[columns.length - 1],
  ];

  if (isPending) {
    return <LoadingSpinner />;
  }

  if (isLoadingError) {
    return (
      <div className="p-6">
        <QueryLoadError
          title="Couldn't load this connector"
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  if (!connector) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Connector not found.</p>
      </div>
    );
  }

  return (
    <PageLayout
      title={
        <div className="flex items-center gap-2.5">
          <ConnectorStatusDot
            enabled={connector.enabled}
            lastSyncStatus={connector.lastSyncStatus}
          />
          <div>
            <span>{connector.name}</span>
            {connector.description ? (
              <p className="text-sm font-normal text-muted-foreground mt-1 line-clamp-2 max-w-2xl">
                {connector.description.length > 300
                  ? `${connector.description.slice(0, 300)}…`
                  : connector.description}
              </p>
            ) : (
              <div>
                <Badge variant="secondary" className="gap-1.5 capitalize mt-1">
                  <ConnectorTypeIcon
                    type={connector.connectorType}
                    className="h-3.5 w-3.5"
                  />
                  {connector.connectorType}
                </Badge>
              </div>
            )}
          </div>
        </div>
      }
      description=""
      tabs={tabs}
      actionButton={
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSync}
                  disabled={
                    syncConnector.isPending ||
                    connector.lastSyncStatus === "running"
                  }
                >
                  <Play className="h-4 w-4" />
                  {syncConnector.isPending
                    ? "Starting..."
                    : connector.lastSyncStatus === "running"
                      ? "Syncing..."
                      : "Sync Now"}
                </Button>
              </span>
            </TooltipTrigger>
            {connector.lastSyncStatus === "running" && (
              <TooltipContent>Sync run in progress</TooltipContent>
            )}
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={handleTestConnection}
                disabled={testConnection.isPending}
              >
                <Plug className="h-4 w-4" />
                {testConnection.isPending ? "Testing..." : "Test Connection"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsEditOpen(true)}>
                <Pencil className="h-4 w-4" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={
                  forceResync.isPending ||
                  connector.lastSyncStatus === "running"
                }
                onClick={() => setIsForceResyncOpen(true)}
              >
                <RotateCcw className="h-4 w-4" />
                {forceResync.isPending ? "Starting..." : "Force Re-sync"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <FormDialog
            open={isForceResyncOpen}
            onOpenChange={setIsForceResyncOpen}
            title="Force Re-sync"
            description="This will delete all documents, chunks, and sync history for this connector, then start a fresh sync from scratch. This action cannot be undone."
            size="small"
          >
            <DialogStickyFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsForceResyncOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  forceResync.mutate(connectorId);
                  setIsForceResyncOpen(false);
                }}
              >
                Force Re-sync
              </Button>
            </DialogStickyFooter>
          </FormDialog>
        </div>
      }
    >
      <div className="space-y-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href={backHref}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {backLabel}
          </Link>
        </Button>

        <div className="rounded-lg border p-4">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 text-sm">
            <MetadataItem label="Last Sync">
              <div>
                {connector.lastSyncAt
                  ? formatDate({ date: connector.lastSyncAt })
                  : "Never"}
              </div>
            </MetadataItem>
            <MetadataItem label="Documents">
              <div>{connector.totalDocsIngested}</div>
            </MetadataItem>
            <MetadataItem label="Schedule">
              <div>{formatCronSchedule(connector.schedule)}</div>
            </MetadataItem>
            <KnowledgeBasesMetadataItem connectorId={connectorId} />
          </div>
        </div>

        {isAutoSync && <PermissionCoverageBanner connectorId={connectorId} />}

        {currentTab === "documents" ? (
          <ConnectorDocumentsTable connectorId={connectorId} />
        ) : (
          <LoadingWrapper
            isPending={isRunsPending}
            loadingFallback={<LoadingSpinner />}
          >
            {(runsData?.data ?? []).length === 0 ? (
              <div className="text-muted-foreground">
                {currentTab === "permission-runs"
                  ? "No permission sync runs yet. Permission sync runs on a schedule; the first run tags this connector's documents with their upstream access."
                  : "No sync runs yet. Trigger a manual sync or wait for the scheduled sync."}
              </div>
            ) : (
              <DataTable
                columns={
                  currentTab === "permission-runs" ? permissionColumns : columns
                }
                data={runsData?.data ?? []}
                manualPagination={true}
                pagination={{
                  pageIndex,
                  pageSize,
                  total: runsData?.pagination?.total ?? 0,
                }}
                onPaginationChange={handlePaginationChange}
              />
            )}
          </LoadingWrapper>
        )}

        <ConnectorRunDetailsDialog
          connectorId={connectorId}
          runId={selectedRunId}
          onClose={() => setSelectedRunId(null)}
        />

        <EditConnectorDialog
          connector={connector}
          open={isEditOpen}
          onOpenChange={setIsEditOpen}
        />
      </div>
    </PageLayout>
  );
}

/**
 * Live ACL coverage for an auto-sync-permissions connector. Answers "is
 * everything ingested reconciled right now?" directly instead of leaving the
 * admin to infer it from run history: shows tagged vs fail-closed counts, the
 * next scheduled pass, and a manual trigger for agency over the gap.
 */
function PermissionCoverageBanner({ connectorId }: { connectorId: string }) {
  const { data: coverage } = useConnectorPermissionCoverage({
    connectorId,
    enabled: true,
  });
  const triggerPermissionSync = useTriggerPermissionSync();

  if (!coverage || coverage.totalDocuments === 0) return null;

  const pending = coverage.failClosedDocuments;
  const tagged = coverage.totalDocuments - pending;
  const fullyCovered = pending === 0;

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4 text-sm ${
        fullyCovered ? "" : "border-amber-500/40 bg-amber-500/5"
      }`}
    >
      {fullyCovered ? (
        <ShieldCheck className="h-4 w-4 shrink-0 text-green-600" />
      ) : (
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
      )}
      <div className="min-w-0">
        <span className="font-medium">Permissions coverage:</span>{" "}
        {fullyCovered ? (
          <>
            {tagged.toLocaleString()} /{" "}
            {coverage.totalDocuments.toLocaleString()} documents tagged
          </>
        ) : (
          <>
            {pending.toLocaleString()} document{pending === 1 ? "" : "s"}{" "}
            awaiting permission sync (access-restricted until tagged)
          </>
        )}
      </div>
      <div className="ml-auto flex items-center gap-3">
        {coverage.permissionSyncRunning ? (
          <span className="text-muted-foreground">
            Permission sync running…
          </span>
        ) : (
          coverage.nextScheduledAt && (
            <span className="text-muted-foreground">
              Next pass: {formatDate({ date: coverage.nextScheduledAt })}
            </span>
          )
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => triggerPermissionSync.mutate(connectorId)}
          disabled={
            triggerPermissionSync.isPending || coverage.permissionSyncRunning
          }
        >
          <RefreshCw className="h-4 w-4" />
          {coverage.permissionSyncRunning ? "Syncing…" : "Sync permissions now"}
        </Button>
      </div>
    </div>
  );
}

function KnowledgeBasesMetadataItem({ connectorId }: { connectorId: string }) {
  const { data: assignedKbs, isPending } =
    useConnectorKnowledgeBases(connectorId);
  const { data: allKbs } = useKnowledgeBases();
  const assignMutation = useAssignConnectorToKnowledgeBases();
  const unassignMutation = useUnassignConnectorFromKnowledgeBase();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedKbId, setSelectedKbId] = useState<string>("");

  const assignedIds = new Set((assignedKbs?.data ?? []).map((kb) => kb.id));
  const availableKbs = (allKbs ?? []).filter((kb) => !assignedIds.has(kb.id));

  const handleAssign = useCallback(async () => {
    if (!selectedKbId) return;
    const result = await assignMutation.mutateAsync({
      connectorId,
      knowledgeBaseIds: [selectedKbId],
    });
    if (result) {
      setSelectedKbId("");
      setIsAddDialogOpen(false);
    }
  }, [selectedKbId, connectorId, assignMutation]);

  const handleUnassign = useCallback(
    async (knowledgeBaseId: string) => {
      await unassignMutation.mutateAsync({ connectorId, knowledgeBaseId });
    },
    [connectorId, unassignMutation],
  );

  const kbItems = assignedKbs?.data ?? [];

  return (
    <MetadataItem label="Knowledge Bases">
      {isPending ? (
        <LoadingSpinner />
      ) : kbItems.length === 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">None</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => setIsAddDialogOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {kbItems.map((kb) => (
            <Badge key={kb.id} variant="secondary" className="gap-1 pr-1">
              <Database className="h-3 w-3" />
              {kb.name}
              <Button
                variant="ghost"
                size="icon"
                className="h-4 w-4 ml-0.5 hover:bg-destructive/20"
                onClick={() => handleUnassign(kb.id)}
                disabled={unassignMutation.isPending}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => setIsAddDialogOpen(true)}
            disabled={availableKbs.length === 0}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign to Knowledge Base</DialogTitle>
            <DialogDescription>
              Select a knowledge base to assign this connector to.
            </DialogDescription>
          </DialogHeader>
          <DialogForm onSubmit={handleAssign}>
            <div className="py-2">
              <Select value={selectedKbId} onValueChange={setSelectedKbId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a knowledge base" />
                </SelectTrigger>
                <SelectContent>
                  {availableKbs.map((kb) => (
                    <SelectItem key={kb.id} value={kb.id}>
                      {kb.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsAddDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!selectedKbId || assignMutation.isPending}
              >
                {assignMutation.isPending ? "Assigning..." : "Assign"}
              </Button>
            </DialogFooter>
          </DialogForm>
        </DialogContent>
      </Dialog>
    </MetadataItem>
  );
}

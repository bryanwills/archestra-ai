import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { clipErrorMessage, trackEvent } from "@/lib/analytics";
import {
  getApiErrorMessage,
  handleApiError,
  throwOnApiError,
} from "@/lib/utils";

const {
  getConnectors,
  getConnector,
  createConnector,
  updateConnector,
  deleteConnector,
  syncConnector,
  forceResyncConnector,
  testConnectorConnection,
  getConnectorRuns,
  getConnectorRun,
  triggerPermissionSync,
  getPermissionSyncCoverage,
  assignConnectorToKnowledgeBases,
  unassignConnectorFromKnowledgeBase,
  getConnectorKnowledgeBases,
} = archestraApiSdk;

type ConnectorsQuery = NonNullable<
  archestraApiTypes.GetConnectorsData["query"]
>;
type ConnectorsListParams = Pick<
  ConnectorsQuery,
  "knowledgeBaseId" | "limit" | "offset"
> & {
  enabled?: boolean;
};
type ConnectorsPaginatedParams = Pick<
  ConnectorsQuery,
  "limit" | "offset" | "search" | "connectorType"
>;

// ===== Query hooks =====

export function useConnectors(params?: string | Partial<ConnectorsListParams>) {
  const knowledgeBaseId =
    typeof params === "string" ? params : params?.knowledgeBaseId;
  const enabled = typeof params === "object" ? params?.enabled : undefined;
  const limit = typeof params === "object" ? params?.limit : undefined;
  const offset = typeof params === "object" ? params?.offset : undefined;
  return useQuery({
    queryKey: knowledgeBaseId
      ? ["connectors", { knowledgeBaseId, limit, offset }]
      : ["connectors", { limit, offset }],
    queryFn: async () => {
      const { data, error } = await getConnectors({
        query: {
          knowledgeBaseId,
          limit: limit ?? 100,
          offset: offset ?? 0,
        },
      });
      throwOnApiError(error);
      return data?.data ?? [];
    },
    enabled,
    refetchInterval: (query) => {
      const hasRunning = query.state.data?.some(
        (c) => c.lastSyncStatus === "running",
      );
      return hasRunning ? 3000 : false;
    },
  });
}

export function useConnectorsPaginated(params: ConnectorsPaginatedParams) {
  return useQuery({
    queryKey: ["connectors", "paginated", params],
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await getConnectors({ query: params });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

export function useConnector(id: string) {
  return useQuery({
    queryKey: ["connectors", id],
    queryFn: async () => {
      const { data, error } = await getConnector({ path: { id } });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
    enabled: !!id,
    refetchInterval: (query) => {
      const connector = query.state.data;
      return connector?.lastSyncStatus === "running" ||
        connector?.lastPermissionSyncStatus === "running"
        ? 3000
        : false;
    },
  });
}

export function useConnectorKnowledgeBases(connectorId: string) {
  return useQuery({
    queryKey: ["connectors", connectorId, "knowledge-bases"],
    queryFn: async () => {
      const { data, error } = await getConnectorKnowledgeBases({
        path: { id: connectorId },
      });
      // A deleted connector 404s here; degrade gracefully instead of erroring.
      throwOnApiError(error, { allowNotFound: true });
      return data;
    },
    enabled: !!connectorId,
  });
}

export function useCreateConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: archestraApiTypes.CreateConnectorData["body"]) => {
      const { data, error } = await createConnector({ body });
      if (error) {
        trackEvent("knowledge_base_connector_installation_failed", {
          connectorType: body.connectorType,
          stage: "create",
          errorMessage: clipErrorMessage(getApiErrorMessage(error)),
        });
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Connector created successfully");
    },
  });
}

export function useUpdateConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: archestraApiTypes.UpdateConnectorData["body"];
    }) => {
      const { data, error } = await updateConnector({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      queryClient.invalidateQueries({
        queryKey: ["connectors", variables.id],
      });
      toast.success("Connector updated successfully");
    },
  });
}

export function useDeleteConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteConnector({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Connector deleted successfully");
    },
  });
}

export function useSyncConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectorId: string) => {
      const { data, error } = await syncConnector({
        path: { id: connectorId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, connectorId) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["connectors", connectorId],
      });
      queryClient.invalidateQueries({
        queryKey: ["connectors", connectorId, "runs"],
      });
      toast.success("Sync started successfully");
    },
  });
}

export function useForceResyncConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectorId: string) => {
      const { data, error } = await forceResyncConnector({
        path: { id: connectorId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, connectorId) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["connectors", connectorId],
      });
      queryClient.invalidateQueries({
        queryKey: ["connectors", connectorId, "runs"],
      });
      toast.success("Force re-sync started");
    },
  });
}

export function useTestConnectorConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectorId: string) => {
      const { data, error } = await testConnectorConnection({
        path: { id: connectorId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, connectorId) => {
      if (!data) return;
      if (data.success) {
        toast.success("Connection test successful");
      } else {
        const connector = queryClient.getQueryData<
          archestraApiTypes.GetConnectorResponses["200"]
        >(["connectors", connectorId]);
        trackEvent("knowledge_base_connector_installation_failed", {
          connectorType: connector?.connectorType,
          stage: "connection_test",
          errorMessage: clipErrorMessage(data.error),
        });
        toast.error(data.error || "Connection test failed");
      }
    },
  });
}

export function useTriggerPermissionSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectorId: string) => {
      const { data, error } = await triggerPermissionSync({
        path: { id: connectorId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, connectorId) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["connectors", connectorId],
      });
      queryClient.invalidateQueries({
        queryKey: ["connectors", connectorId, "runs"],
      });
      queryClient.invalidateQueries({
        queryKey: ["connectors", connectorId, "permission-coverage"],
      });
      toast.success("Permission sync started");
    },
  });
}

/**
 * Live ACL coverage for an auto-sync-permissions connector: how many ingested
 * documents are tagged vs still fail-closed. Polls while a pass is running or
 * documents are still awaiting one, so the header stat converges on its own.
 */
export function useConnectorPermissionCoverage(params: {
  connectorId: string;
  enabled: boolean;
}) {
  const { connectorId, enabled } = params;
  return useQuery({
    queryKey: ["connectors", connectorId, "permission-coverage"],
    queryFn: async () => {
      const { data, error } = await getPermissionSyncCoverage({
        path: { id: connectorId },
      });
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
    enabled: enabled && !!connectorId,
    refetchInterval: (query) => {
      const coverage = query.state.data;
      return coverage?.permissionSyncRunning ||
        (coverage?.failClosedDocuments ?? 0) > 0
        ? 5000
        : false;
    },
  });
}

export function useConnectorRuns(params: {
  connectorId: string;
  limit?: number;
  offset?: number;
  /** Scope to one job family: "content" (Sync Runs) or "permission" (Permission Sync Runs). */
  runType?: "content" | "permission";
}) {
  const queryClient = useQueryClient();
  const { connectorId, limit = 10, offset = 0, runType } = params;
  return useQuery({
    queryKey: ["connectors", connectorId, "runs", { limit, offset, runType }],
    queryFn: async () => {
      const { data, error } = await getConnectorRuns({
        path: { id: connectorId },
        query: { limit, offset, ...(runType ? { runType } : {}) },
      });
      // A deleted/missing connector 404s here; degrade to a null result rather
      // than an error. Return null (not bare data) so react-query doesn't throw
      // its own "data is undefined" when the 404 path skips the throw.
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
    enabled: !!connectorId,
    refetchInterval: (query) => {
      const hasRunning = query.state.data?.data?.some(
        (r) => r.status === "running",
      );
      const connector = queryClient.getQueryData<
        archestraApiTypes.GetConnectorResponses["200"]
      >(["connectors", connectorId]);
      // A just-triggered sync flips the connector status before the worker
      // creates the run row — poll off the status so the new run shows up
      // without a reload. Scope to the tab's run family.
      const contentRunning = connector?.lastSyncStatus === "running";
      const permissionRunning =
        connector?.lastPermissionSyncStatus === "running";
      const connectorIsRunning =
        runType === "permission"
          ? permissionRunning
          : runType === "content"
            ? contentRunning
            : contentRunning || permissionRunning;
      return hasRunning || connectorIsRunning ? 3000 : false;
    },
  });
}

export function useConnectorRun(params: {
  connectorId: string;
  runId: string | null;
}) {
  const { connectorId, runId } = params;
  return useQuery({
    queryKey: ["connectors", connectorId, "runs", runId],
    queryFn: async () => {
      if (!runId) return null;
      const { data, error } = await getConnectorRun({
        path: { id: connectorId, runId },
      });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
    enabled: !!connectorId && !!runId,
    refetchInterval: (query) => {
      return query.state.data?.status === "running" ? 2000 : false;
    },
  });
}

export function useAssignConnectorToKnowledgeBases() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectorId,
      knowledgeBaseIds,
    }: { connectorId: string } & NonNullable<
      archestraApiTypes.AssignConnectorToKnowledgeBasesData["body"]
    >) => {
      const { data, error } = await assignConnectorToKnowledgeBases({
        path: { id: connectorId },
        body: { knowledgeBaseIds },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Connector assigned successfully");
    },
  });
}

export function useUnassignConnectorFromKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectorId,
      knowledgeBaseId,
    }: {
      connectorId: string;
      knowledgeBaseId: string;
    }) => {
      const { data, error } = await unassignConnectorFromKnowledgeBase({
        path: { id: connectorId, kbId: knowledgeBaseId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Connector unassigned successfully");
    },
  });
}

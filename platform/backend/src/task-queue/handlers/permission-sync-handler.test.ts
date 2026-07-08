import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

const mockExecutePass = vi.hoisted(() => vi.fn());
vi.mock("@/knowledge-base", () => ({
  permissionSyncService: { executePass: mockExecutePass },
}));

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue("task-id"));
vi.mock("@/task-queue", () => ({
  taskQueueService: { enqueue: mockEnqueue },
}));

const mockWithinResumeBudget = vi.hoisted(() => vi.fn());
vi.mock("./connector-resume-budget", () => ({
  withinResumeBudget: mockWithinResumeBudget,
}));

vi.mock("@/entrypoints/_shared/log-capture", () => ({
  createCapturingLogger: () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
      fatal: vi.fn(),
    },
    getLogOutput: () => "",
  }),
}));

import { handlePermissionSync } from "./permission-sync-handler";

describe("handlePermissionSync", () => {
  let connectorId: string;

  beforeEach(() => {
    connectorId = randomUUID();
    vi.clearAllMocks();
    mockWithinResumeBudget.mockResolvedValue(true);
  });

  test("enqueues a continuation on a partial result when within the permission-run budget", async () => {
    mockExecutePass.mockResolvedValue({ runId: "run-1", status: "partial" });

    await handlePermissionSync({ connectorId });

    expect(mockWithinResumeBudget).toHaveBeenCalledWith({
      connectorId,
      runType: "permission",
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "permission_sync",
      payload: { connectorId },
    });
  });

  test("does not enqueue a continuation when the connector is over its permission-run budget", async () => {
    // A pass that persistently fails fast ends partial every time; without the
    // budget gate it re-enqueues itself in a hot loop with no backoff.
    mockExecutePass.mockResolvedValue({ runId: "run-1", status: "partial" });
    mockWithinResumeBudget.mockResolvedValue(false);

    await handlePermissionSync({ connectorId });

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("does not enqueue a continuation on success", async () => {
    mockExecutePass.mockResolvedValue({ runId: "run-1", status: "success" });

    await handlePermissionSync({ connectorId });

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("throws when connectorId is missing", async () => {
    await expect(handlePermissionSync({})).rejects.toThrow(
      "Missing connectorId in permission_sync payload",
    );
  });
});

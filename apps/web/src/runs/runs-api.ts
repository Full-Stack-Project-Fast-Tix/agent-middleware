import {
  agentsResponseSchema,
  apiPaths,
  approvalResponseSchema,
  followRunEvents,
  runListResponseSchema,
  runResponseSchema,
  runSnapshotResponseSchema,
  runTimelineResponseSchema,
  type Agent,
  type Approval,
  type CreateRunRequest,
  type Run,
  type RunEvent,
  type RunListResponse,
  type RunSnapshot,
  type RunStatus,
  type RunTimeline,
  type WorkspaceSummary,
  workspacesResponseSchema,
} from "@launchpad/shared";
import { ApiError, authHeaders, request } from "../api";

// The Run API from packages/shared/src/api.ts. Every response is validated
// against the shared schema, so a server that drifts from the contract fails
// here, with a clear message, rather than as an undefined somewhere in the UI.

export type { WorkspaceSummary };

export const runsApi = {
  workspaces: async (): Promise<{ workspaces: WorkspaceSummary[]; viewerId: string }> =>
    workspacesResponseSchema.parse(await request(apiPaths.workspaces())),

  agents: async (workspaceId: string): Promise<Agent[]> =>
    agentsResponseSchema.parse(await request(apiPaths.workspaceAgents(workspaceId))).agents,

  createRun: async (workspaceId: string, body: CreateRunRequest): Promise<Run> =>
    runResponseSchema.parse(await request(apiPaths.runs(workspaceId), { method: "POST", body: JSON.stringify(body) })).run,

  /** A page of the workspace's runs, newest first. Includes the workspace's total of pending approvals. */
  listRuns: async (
    workspaceId: string,
    query: { limit?: number; status?: RunStatus; cursor?: string } = {},
  ): Promise<RunListResponse> => {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.status !== undefined) params.set("status", query.status);
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const search = params.toString();
    return runListResponseSchema.parse(await request(apiPaths.runs(workspaceId) + (search ? `?${search}` : "")));
  },

  /** Saved decisions at the gate. Not pushed, so callers refetch: see useRunTimeline. */
  timeline: async (runId: string): Promise<RunTimeline> =>
    runTimelineResponseSchema.parse(await request(apiPaths.runTimeline(runId))).timeline,

  snapshot: async (runId: string): Promise<RunSnapshot> =>
    runSnapshotResponseSchema.parse(await request(apiPaths.runSnapshot(runId))).snapshot,

  cancel: async (runId: string): Promise<Run> =>
    runResponseSchema.parse(await request(apiPaths.cancelRun(runId), { method: "POST" })).run,

  resolveApproval: async (approvalId: string, decision: "approve" | "deny"): Promise<Approval> =>
    approvalResponseSchema.parse(
      await request(apiPaths.resolveApproval(approvalId), { method: "POST", body: JSON.stringify({ decision }) }),
    ).approval,

  /** One attempt's raw trace, and how many values the server redacted from it. */
  trace: async (runId: string, executionId: string): Promise<{ text: string; redactions: number }> => {
    const response = await fetch(apiPaths.executionTrace(runId, executionId), { headers: authHeaders() });
    if (!response.ok) {
      const { error } = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(error ?? "Request failed", response.status);
    }
    const redactions = Number(response.headers.get("x-redactions") ?? 0);
    return { text: await response.text(), redactions: Number.isFinite(redactions) ? redactions : 0 };
  },

  /** Follow the Run's events until `signal` aborts; reconnects and resyncs on its own. */
  follow: (
    runId: string,
    afterSeq: number,
    handlers: { onEvent: (event: RunEvent) => void; onResync: () => Promise<number> },
    signal: AbortSignal,
  ): Promise<void> =>
    followRunEvents({ url: apiPaths.runEvents(runId), afterSeq, signal, headers: authHeaders(), ...handlers }),
};

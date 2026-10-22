import {
  agentsResponseSchema,
  apiPaths,
  approvalResponseSchema,
  followRunEvents,
  runResponseSchema,
  runSnapshotResponseSchema,
  type Agent,
  type Approval,
  type CreateRunRequest,
  type Run,
  type RunEvent,
  type RunSnapshot,
  type WorkspaceSummary,
  workspacesResponseSchema,
} from "@launchpad/shared";
import { authHeaders, request } from "../api";

// The Run API from packages/shared/src/api.ts. Every response is validated
// against the shared schema, so a server that drifts from the contract fails
// here, with a clear message, rather than as an undefined somewhere in the UI.

export type { WorkspaceSummary };

export const runsApi = {
  workspaces: async (): Promise<WorkspaceSummary[]> =>
    workspacesResponseSchema.parse(await request(apiPaths.workspaces())).workspaces,

  agents: async (workspaceId: string): Promise<Agent[]> =>
    agentsResponseSchema.parse(await request(apiPaths.workspaceAgents(workspaceId))).agents,

  createRun: async (workspaceId: string, body: CreateRunRequest): Promise<Run> =>
    runResponseSchema.parse(await request(apiPaths.runs(workspaceId), { method: "POST", body: JSON.stringify(body) })).run,

  snapshot: async (runId: string): Promise<RunSnapshot> =>
    runSnapshotResponseSchema.parse(await request(apiPaths.runSnapshot(runId))).snapshot,

  cancel: async (runId: string): Promise<Run> =>
    runResponseSchema.parse(await request(apiPaths.cancelRun(runId), { method: "POST" })).run,

  resolveApproval: async (approvalId: string, decision: "approve" | "deny"): Promise<Approval> =>
    approvalResponseSchema.parse(
      await request(apiPaths.resolveApproval(approvalId), { method: "POST", body: JSON.stringify({ decision }) }),
    ).approval,

  /** Follow the Run's events until `signal` aborts; reconnects and resyncs on its own. */
  follow: (
    runId: string,
    afterSeq: number,
    handlers: { onEvent: (event: RunEvent) => void; onResync: () => Promise<number> },
    signal: AbortSignal,
  ): Promise<void> =>
    followRunEvents({ url: apiPaths.runEvents(runId), afterSeq, signal, headers: authHeaders(), ...handlers }),
};

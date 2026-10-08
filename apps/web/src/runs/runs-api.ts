import { z } from "zod";
import {
  agentSchema,
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
} from "@launchpad/shared";
import { authHeaders, request } from "../api";

// The Run API from packages/shared/src/api.ts. Every response is validated
// against the shared schema, so a server that drifts from the contract fails
// here, with a clear message, rather than as an undefined somewhere in the UI.

export interface WorkspaceSummary {
  id: string;
  name: string;
}

// Workspace and agent listings are not in the shared contract yet (P3 owns
// them). These match what the RUNS_DEMO server offers.
const workspacesSchema = z.object({ workspaces: z.array(z.object({ id: z.string(), name: z.string() })) });
const agentsSchema = z.object({ agents: z.array(agentSchema) });

export const runsApi = {
  workspaces: async (): Promise<WorkspaceSummary[]> =>
    workspacesSchema.parse(await request("/api/workspaces")).workspaces,

  agents: async (workspaceId: string): Promise<Agent[]> =>
    agentsSchema.parse(await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`)).agents,

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

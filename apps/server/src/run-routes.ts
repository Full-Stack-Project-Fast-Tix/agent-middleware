import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createRunRequestSchema,
  resolveApprovalRequestSchema,
  type Agent,
  type Approval,
  type RunSnapshot,
  type WorkspaceSummary,
} from "@launchpad/shared";
import { HttpError } from "./errors.js";
import type { Orchestrator } from "./orchestrator/orchestrator.js";

// HTTP routes for the Run -> Task -> AgentExecution model, as specified in
// packages/shared/src/api.ts:
//
//   GET  /api/workspaces                                            -> { workspaces }
//   GET  /api/workspaces/:workspaceId/agents                        -> { agents }
//   POST /api/workspaces/:workspaceId/runs   CreateRunRequest       -> 201 { run }
//   GET  /api/runs/:runId/snapshot                                  -> { snapshot }
//   POST /api/runs/:runId/cancel                                    -> 202 { run }
//   POST /api/approvals/:approvalId/resolve  ResolveApprovalRequest -> { approval }
//
// The SSE stream (GET /api/runs/:runId/events) is run-events-route.ts.
// Authentication is the app's onRequest hook. Authorisation, meaning who may
// act in which workspace, arrives with P3's identity work through the two
// hooks below. Until then every authenticated caller is the one demo user.

export interface RunRoutesOptions {
  orchestrator: Pick<Orchestrator, "createRun" | "cancel" | "resolveApproval">;
  /** The snapshot and its lastEventSeq, read together (contract decision 9). */
  snapshot(runId: string): Promise<RunSnapshot | null>;
  /** To find which run, and so which workspace, an approval belongs to. */
  approval(approvalId: string): Promise<Approval | null>;
  /** Who is making the request. */
  currentUserId(request: FastifyRequest): string;
  /** May this user start runs in, and read runs of, this workspace? */
  canAccessWorkspace(workspaceId: string, userId: string): Promise<boolean>;
  /** The workspaces this user may access, by name. */
  listWorkspaces(userId: string): Promise<WorkspaceSummary[]>;
  /** Every agent in the workspace, including disabled and archived ones. */
  listAgents(workspaceId: string): Promise<Agent[]>;
}

const workspaceParams = z.object({ workspaceId: z.guid() });
const runParams = z.object({ runId: z.guid() });
const approvalParams = z.object({ approvalId: z.guid() });

export function registerRunRoutes(app: FastifyInstance, options: RunRoutesOptions): void {
  /** A run the caller may not see is reported exactly like one that does not exist. */
  async function readableSnapshot(request: FastifyRequest, runId: string): Promise<RunSnapshot> {
    const snapshot = await options.snapshot(runId);
    if (snapshot === null) throw new HttpError(404, "Run not found");
    const allowed = await options.canAccessWorkspace(snapshot.run.workspaceId, options.currentUserId(request));
    if (!allowed) throw new HttpError(404, "Run not found");
    return snapshot;
  }

  app.get("/api/workspaces", async (request) => ({
    workspaces: await options.listWorkspaces(options.currentUserId(request)),
  }));

  app.get("/api/workspaces/:workspaceId/agents", async (request) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    if (!(await options.canAccessWorkspace(workspaceId, options.currentUserId(request)))) {
      throw new HttpError(404, "Workspace not found");
    }
    return { agents: await options.listAgents(workspaceId) };
  });

  app.post("/api/workspaces/:workspaceId/runs", async (request, reply) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    const userId = options.currentUserId(request);
    if (!(await options.canAccessWorkspace(workspaceId, userId))) throw new HttpError(404, "Workspace not found");
    const body = createRunRequestSchema.parse(request.body);
    const run = await options.orchestrator.createRun({
      workspaceId,
      createdByUserId: userId,
      userPrompt: body.userPrompt,
      orchestrationMode: body.orchestrationMode,
      ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
    });
    return reply.code(201).send({ run });
  });

  app.get("/api/runs/:runId/snapshot", async (request) => {
    const { runId } = runParams.parse(request.params);
    return { snapshot: await readableSnapshot(request, runId) };
  });

  app.post("/api/runs/:runId/cancel", async (request, reply) => {
    const { runId } = runParams.parse(request.params);
    await readableSnapshot(request, runId);
    return reply.code(202).send({ run: await options.orchestrator.cancel(runId, options.currentUserId(request)) });
  });

  app.post("/api/approvals/:approvalId/resolve", async (request) => {
    const { approvalId } = approvalParams.parse(request.params);
    const { decision } = resolveApprovalRequestSchema.parse(request.body);
    const existing = await options.approval(approvalId);
    if (existing === null) throw new HttpError(404, "Approval not found");
    await readableSnapshot(request, existing.runId).catch((error: unknown) => {
      throw error instanceof HttpError && error.statusCode === 404 ? new HttpError(404, "Approval not found") : error;
    });
    // The orchestrator answers 409 for an approval that is already answered.
    const approval = await options.orchestrator.resolveApproval(approvalId, decision, options.currentUserId(request));
    return { approval };
  });
}

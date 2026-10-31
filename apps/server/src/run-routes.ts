import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createRunRequestSchema,
  resolveApprovalRequestSchema,
  RUN_TIMELINE_MAX_ENTRIES,
  runListQuerySchema,
  type Agent,
  type Approval,
  type AuditEventType,
  type RunListQuery,
  type RunListResponse,
  type RunSnapshot,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "@launchpad/shared";
import { HttpError } from "./errors.js";
import type { Orchestrator } from "./orchestrator/orchestrator.js";
import type { RunAudit } from "./orchestrator/ports.js";
import { buildRunTimeline } from "./run-timeline.js";
import { traceFilePath } from "./trace.js";

// HTTP routes for the Run -> Task -> AgentExecution model, as specified in
// packages/shared/src/api.ts:
//
//   GET  /api/workspaces                                            -> { workspaces }
//   GET  /api/workspaces/:workspaceId/agents                        -> { agents }
//   GET  /api/workspaces/:workspaceId/runs   RunListQuery           -> RunListResponse
//   POST /api/workspaces/:workspaceId/runs   CreateRunRequest       -> 201 { run }
//   GET  /api/runs/:runId/snapshot                                  -> { snapshot }
//   GET  /api/runs/:runId/timeline                                  -> { timeline }
//   POST /api/runs/:runId/cancel                                    -> 202 { run }
//   POST /api/approvals/:approvalId/resolve  ResolveApprovalRequest -> { approval }
//   GET  /api/runs/:runId/executions/:executionId/trace             -> JSON Lines
//
// The SSE stream (GET /api/runs/:runId/events) is run-events-route.ts.
// Authentication is the app's onRequest hook. Authorisation is the caller's
// role in the workspace: any role may read, and only ACTING_ROLES may start or
// cancel a run or answer an approval.

export interface RunRoutesOptions {
  orchestrator: Pick<Orchestrator, "createRun" | "cancel" | "resolveApproval">;
  /** The snapshot and its lastEventSeq, read together (contract decision 9). */
  snapshot(runId: string): Promise<RunSnapshot | null>;
  /** One page of the workspace's runs, newest first. */
  listRuns(workspaceId: string, query: RunListQuery): Promise<RunListResponse>;
  /** A Run's newest audit events of one type, for its timeline. */
  runAudit(runId: string, eventType: AuditEventType, limit: number): Promise<RunAudit>;
  /** To find which run, and so which workspace, an approval belongs to. */
  approval(approvalId: string): Promise<Approval | null>;
  /** Who is making the request. */
  currentUserId(request: FastifyRequest): string;
  /** The user's role in the workspace, or null when they may not see it. */
  workspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  /** The workspaces this user may access, by name. */
  listWorkspaces(userId: string): Promise<WorkspaceSummary[]>;
  /** Every agent in the workspace, including disabled and archived ones. */
  listAgents(workspaceId: string): Promise<Agent[]>;
}

const ACTING_ROLES: ReadonlySet<WorkspaceRole> = new Set(["developer", "security_admin"]);
const RAW_TRACE_ROLES: ReadonlySet<WorkspaceRole> = new Set(["developer", "security_admin"]);

const workspaceParams = z.object({ workspaceId: z.guid() });
const runParams = z.object({ runId: z.guid() });
const approvalParams = z.object({ approvalId: z.guid() });
const executionParams = z.object({ runId: z.guid(), executionId: z.guid() });

export function registerRunRoutes(app: FastifyInstance, options: RunRoutesOptions, dataDirectory: string): void {
  /** A workspace the caller may not see is reported exactly like one that does not exist. */
  async function roleIn(request: FastifyRequest, workspaceId: string, notFound: string): Promise<WorkspaceRole> {
    const role = await options.workspaceRole(workspaceId, options.currentUserId(request));
    if (role === null) throw new HttpError(404, notFound);
    return role;
  }

  function mayAct(role: WorkspaceRole): void {
    if (!ACTING_ROLES.has(role)) throw new HttpError(403, `The ${role} role can only read runs`);
  }

  async function readableSnapshot(request: FastifyRequest, runId: string): Promise<{ snapshot: RunSnapshot; role: WorkspaceRole }> {
    const snapshot = await options.snapshot(runId);
    if (snapshot === null) throw new HttpError(404, "Run not found");
    return { snapshot, role: await roleIn(request, snapshot.run.workspaceId, "Run not found") };
  }

  app.get("/api/workspaces", async (request) => ({
    workspaces: await options.listWorkspaces(options.currentUserId(request)),
  }));

  app.get("/api/workspaces/:workspaceId/agents", async (request) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    await roleIn(request, workspaceId, "Workspace not found");
    return { agents: await options.listAgents(workspaceId) };
  });

  app.get("/api/workspaces/:workspaceId/runs", async (request) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    await roleIn(request, workspaceId, "Workspace not found");
    return options.listRuns(workspaceId, runListQuerySchema.parse(request.query));
  });

  app.post("/api/workspaces/:workspaceId/runs", async (request, reply) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    const userId = options.currentUserId(request);
    mayAct(await roleIn(request, workspaceId, "Workspace not found"));
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
    return { snapshot: (await readableSnapshot(request, runId)).snapshot };
  });

  app.get("/api/runs/:runId/timeline", async (request) => {
    const { runId } = runParams.parse(request.params);
    const { snapshot } = await readableSnapshot(request, runId);
    const [decisions, delegations] = await Promise.all([
      options.runAudit(runId, "security.decision", RUN_TIMELINE_MAX_ENTRIES),
      options.runAudit(runId, "delegation.requested", RUN_TIMELINE_MAX_ENTRIES),
    ]);
    return {
      timeline: buildRunTimeline({
        decisions: decisions.events,
        omittedDecisions: decisions.total - decisions.events.length,
        delegations: delegations.events,
        approvals: snapshot.approvals,
      }),
    };
  });

  /**
   * One attempt's raw trace. The file is named from the id stored on the Run's
   * own execution, so the path never comes from the request or a stored path.
   * It is read whole, not streamed, because the outbound redaction hook skips
   * streams; TraceWriter bounds its size.
   */
  app.get("/api/runs/:runId/executions/:executionId/trace", async (request, reply) => {
    const { runId, executionId } = executionParams.parse(request.params);
    const { snapshot, role } = await readableSnapshot(request, runId);
    if (!RAW_TRACE_ROLES.has(role)) {
      throw new HttpError(403, `The ${role} role cannot read raw execution traces`);
    }
    const execution = snapshot.executions.find((candidate) => candidate.id === executionId);
    if (execution === undefined) throw new HttpError(404, "Execution not found");
    const contents = await readFile(traceFilePath(dataDirectory, execution.id), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (contents === null) throw new HttpError(404, "No trace for this execution");
    return reply.type("application/x-ndjson").send(contents);
  });

  app.post("/api/runs/:runId/cancel", async (request, reply) => {
    const { runId } = runParams.parse(request.params);
    mayAct((await readableSnapshot(request, runId)).role);
    return reply.code(202).send({ run: await options.orchestrator.cancel(runId, options.currentUserId(request)) });
  });

  app.post("/api/approvals/:approvalId/resolve", async (request) => {
    const { approvalId } = approvalParams.parse(request.params);
    const { decision } = resolveApprovalRequestSchema.parse(request.body);
    const existing = await options.approval(approvalId);
    if (existing === null) throw new HttpError(404, "Approval not found");
    const { role } = await readableSnapshot(request, existing.runId).catch((error: unknown) => {
      throw error instanceof HttpError && error.statusCode === 404 ? new HttpError(404, "Approval not found") : error;
    });
    mayAct(role);
    // The orchestrator answers 409 for an approval that is already answered.
    const approval = await options.orchestrator.resolveApproval(approvalId, decision, options.currentUserId(request));
    return { approval };
  });
}

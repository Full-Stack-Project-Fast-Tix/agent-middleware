import { z } from "zod";
import { idSchema, jsonObjectSchema, nonEmptyStringSchema, requiredTextSchema, timestampSchema } from "./common.js";
import { agentCapabilitiesSchema, agentSchema, capabilityCeilingSchema } from "./agents.js";
import {
  actionTypeSchema,
  approvalDecisionSchema,
  findingSeveritySchema,
  orchestrationModeSchema,
  runStatusSchema,
  securityDecisionOutcomeSchema,
  workspaceRoleSchema,
} from "./enums.js";
import { runSnapshotSchema } from "./events.js";
import { userSchema, workspaceMemberSchema, workspaceSchema } from "./identity.js";
import { fileChangeSchema } from "./middleware.js";
import { runSchema } from "./runs.js";
import { approvalSchema } from "./security.js";

// HTTP conventions, matching what the server already does:
//
//   - Success bodies name the resource: `{ run }`, `{ runs }`, `{ agent }`.
//   - Errors are `{ error, code?, details? }`. `error` stays a human-readable
//     message so existing clients keep working; `code` is what new clients
//     should branch on.

export const API_ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal",
  "unavailable",
] as const;
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.string(),
  code: apiErrorCodeSchema.optional(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Cursor-paginated list, for findings, approvals and audit history. */
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    /** Opaque; pass back as `cursor` to fetch the next page. Null on the last page. */
    nextCursor: z.string().nullable(),
  });
export type Page<T> = { items: T[]; nextCursor: string | null };

export const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/**
 * Sign-in. `GET /api/auth` says whether requests need a bearer token, and
 * which kind: the operator's shared token, or a session from signing in.
 *
 *   GET    /api/auth                    -> AuthInfo
 *   POST   /api/auth/session  SignInRequest -> 201 Session (401 on a wrong email or password,
 *                                         429 with Retry-After after too many failed attempts)
 *   DELETE /api/auth/session            -> 204, ends the session in the Authorization header
 *   GET    /api/auth/me                 -> { user }
 */
export const authInfoSchema = z.object({
  required: z.boolean(),
  method: z.enum(["token", "password"]),
});
export type AuthInfo = z.infer<typeof authInfoSchema>;

export const signInRequestSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(1_024),
});
export type SignInRequest = z.infer<typeof signInRequestSchema>;

/** The token is the bearer for every later request, until expiresAt or sign-out. */
export const sessionSchema = z.object({
  token: z.string(),
  user: userSchema,
  expiresAt: z.string(),
});
export type SessionResponse = z.infer<typeof sessionSchema>;

export const meResponseSchema = z.object({ user: userSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * Routes for the Run -> Task -> AgentExecution model. The legacy single-agent
 * routes (`/api/agents/...`, `GET /api/runs/:id`) keep working alongside these
 * until the new model replaces them.
 *
 *   GET  /api/workspaces                                        -> { workspaces }
 *   GET  /api/workspaces/:workspaceId/agents                    -> { agents }
 *   GET  /api/workspaces/:workspaceId/configuration              -> WorkspaceConfiguration
 *   GET  /api/workspaces/:workspaceId/audit                      -> WorkspaceAuditResponse
 *   GET  /api/workspaces/:workspaceId/runs   RunListQuery       -> RunListResponse
 *   POST /api/workspaces/:workspaceId/runs   CreateRunRequest   -> 201 { run }
 *   GET  /api/runs/:runId/snapshot                              -> { snapshot }
 *   GET  /api/runs/:runId/timeline                              -> { timeline }
 *   GET  /api/runs/:runId/events             Server-Sent Events (RunEvent)
 *   POST /api/runs/:runId/cancel                                -> 202 { run }
 *   POST /api/approvals/:approvalId/resolve  ResolveApprovalRequest -> { approval }
 *   GET  /api/runs/:runId/executions/:executionId/trace         -> application/x-ndjson
 *
 * The workspaces are the caller's own. Reading needs any role in the
 * workspace; starting or cancelling a run and answering an approval need
 * `developer` or `security_admin` (403 for an `auditor`). The agents include
 * disabled and archived ones, so a past Run's agent can still be named.
 *
 * Cancel is idempotent: the first call sets cancelRequestedAt and the run
 * reaches `cancelled` asynchronously, visible on the event stream. Repeating
 * it, even once the run is cancelled, returns 202 with the run unchanged. Only
 * a run that already completed or failed answers 409.
 */
export const apiPaths = {
  session: () => "/api/auth/session",
  me: () => "/api/auth/me",
  workspaces: () => "/api/workspaces",
  workspaceAgents: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/agents`,
  workspaceConfiguration: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/configuration`,
  workspaceAudit: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/audit`,
  runs: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/runs`,
  runSnapshot: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/snapshot`,
  runTimeline: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/timeline`,
  runEvents: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/events`,
  cancelRun: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/cancel`,
  resolveApproval: (approvalId: string) => `/api/approvals/${encodeURIComponent(approvalId)}/resolve`,
  workspaceMembers: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
  workspaceMember: (workspaceId: string, userId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
  executionTrace: (runId: string, executionId: string) =>
    `/api/runs/${encodeURIComponent(runId)}/executions/${encodeURIComponent(executionId)}/trace`,
} as const;

/** A workspace as listings show it; where its source lives stays on the server. */
export const workspaceSummarySchema = workspaceSchema.pick({ id: true, name: true });
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspacesResponseSchema = z.object({ workspaces: z.array(workspaceSummarySchema) });
export type WorkspacesResponse = z.infer<typeof workspacesResponseSchema>;

export const agentsResponseSchema = z.object({ agents: z.array(agentSchema) });
export type AgentsResponse = z.infer<typeof agentsResponseSchema>;

/** A Run as the workspace listing shows it: no results, errors or benchmark labels. */
export const runSummarySchema = runSchema
  .pick({
    id: true,
    workspaceId: true,
    createdByUserId: true,
    orchestrationMode: true,
    status: true,
    cancelRequestedAt: true,
    createdAt: true,
    updatedAt: true,
    startedAt: true,
    completedAt: true,
  })
  .extend({
    /** At most RUN_SUMMARY_PROMPT_LENGTH characters; the snapshot has the whole prompt. */
    userPrompt: runSchema.shape.userPrompt,
    taskCount: z.number().int().nonnegative(),
    pendingApprovalCount: z.number().int().nonnegative(),
    findingCount: z.number().int().nonnegative(),
  });
export type RunSummary = z.infer<typeof runSummarySchema>;

export const RUN_SUMMARY_PROMPT_LENGTH = 280;
/** Used when a listing names no `limit`. pageQuerySchema caps it at 200. */
export const RUN_LIST_DEFAULT_LIMIT = 50;

export const runListQuerySchema = pageQuerySchema.extend({
  /** Only runs in this status. `waiting_approval` finds every run waiting on a person, however old. */
  status: runStatusSchema.optional(),
});
export type RunListQuery = z.infer<typeof runListQuerySchema>;

/** Newest first. An unknown cursor is a 400. */
export const runListResponseSchema = z.object({
  runs: z.array(runSummarySchema),
  nextCursor: z.string().nullable(),
  /** Pending approvals across the whole workspace, whatever the page or status filter. */
  pendingApprovalCount: z.number().int().nonnegative(),
});
export type RunListResponse = z.infer<typeof runListResponseSchema>;

export const RUN_TIMELINE_MAX_ENTRIES = 500;
export const RUN_TIMELINE_MAX_FILE_CHANGES = 300;

/**
 * What an agent proposed at the gate. Agent-authored, so untrusted, even
 * though it is redacted and bounded: show it as evidence, never as a fact.
 */
export const timelineProposalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), command: nonEmptyStringSchema, cwd: z.string().nullable() }),
  z.object({
    type: z.literal("file_change"),
    /** At most 50 per action. */
    files: z.array(z.object({ path: nonEmptyStringSchema, kind: fileChangeSchema.shape.kind, movePath: z.string().nullable() })),
    /** How many files the action named, which can be more than `files` holds. */
    filesTotal: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("delegation"), targetAgentId: idSchema, title: nonEmptyStringSchema, objective: nonEmptyStringSchema }),
  z.object({ type: z.literal("context_handoff"), fromTaskId: idSchema, toTaskId: idSchema, characters: z.number().int().nonnegative() }),
]);
export type TimelineProposal = z.infer<typeof timelineProposalSchema>;

/** One decision at the gate. Everything except `proposed` comes from the middleware or a person. */
export const runTimelineEntrySchema = z.object({
  id: idSchema,
  /** When the action reached the gate, which for a held action is before it was decided. */
  at: timestampSchema,
  taskId: idSchema.nullable(),
  executionId: idSchema.nullable(),
  agentId: idSchema.nullable(),
  /** `observed`: noticed in the agent's activity rather than asked about first, so `actionType` is null. */
  source: z.enum(["evaluated", "observed"]),
  actionType: actionTypeSchema.nullable(),
  actionId: z.string().nullable(),
  /**
   * Null when no text was saved for this action. A command's text is saved only
   * if it went to a person, because audit events never hold command text.
   */
  proposed: timelineProposalSchema.nullable(),
  /**
   * The final decision. `require_approval` means none was recorded: the action
   * is held when `approval.status` is `pending`, and otherwise the run ended
   * before an answer took effect, so the action did not run.
   */
  decision: securityDecisionOutcomeSchema,
  reason: nonEmptyStringSchema,
  /** Null until the decision is final. */
  severity: findingSeveritySchema.nullable(),
  stop: z.enum(["action", "execution"]).nullable(),
  findingCodes: z.array(z.string()),
  approval: approvalSchema
    .pick({ id: true, status: true, reason: true, requestedAt: true, expiresAt: true, resolvedAt: true, resolvedByUserId: true })
    .nullable(),
});
export type RunTimelineEntry = z.infer<typeof runTimelineEntrySchema>;

/**
 * A Run's decisions, read from saved rows, oldest first. It is not pushed:
 * refetch on any event from the Run's stream, and every few seconds while the
 * Run is active, because an action allowed without a person publishes no event.
 */
export const runTimelineSchema = z.object({
  /** The newest RUN_TIMELINE_MAX_ENTRIES. */
  entries: z.array(runTimelineEntrySchema),
  /** Older or unreadable decisions not in `entries`. */
  omittedEntries: z.number().int().nonnegative(),
  /**
   * File changes proposed at the gate, with the latest decision for each file.
   * These are proposals: an `allow` does not prove the change was applied, and
   * there are no contents or diffs.
   */
  fileChanges: z.object({
    items: z.array(
      z.object({
        path: nonEmptyStringSchema,
        movePath: z.string().nullable(),
        kind: fileChangeSchema.shape.kind,
        decision: securityDecisionOutcomeSchema,
        /** The entry that decided it, for its reason and approval. */
        entryId: idSchema,
        taskId: idSchema.nullable(),
        at: timestampSchema,
      }),
    ),
    /** More files were proposed than are listed. */
    truncated: z.boolean(),
    /** File-change decisions whose file list was not saved, so `items` can be missing files. */
    entriesWithoutFileList: z.number().int().nonnegative(),
    /** Commands that were allowed to run. Any files they changed are not in `items`. */
    allowedCommands: z.number().int().nonnegative(),
  }),
});
export type RunTimeline = z.infer<typeof runTimelineSchema>;

export const runTimelineResponseSchema = z.object({ timeline: runTimelineSchema });
export type RunTimelineResponse = z.infer<typeof runTimelineResponseSchema>;

export const runResponseSchema = z.object({ run: runSchema });
export type RunResponse = z.infer<typeof runResponseSchema>;

export const runSnapshotResponseSchema = z.object({ snapshot: runSnapshotSchema });
export type RunSnapshotResponse = z.infer<typeof runSnapshotResponseSchema>;

export const approvalResponseSchema = z.object({ approval: approvalSchema });
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;

// Request bodies. Ids that appear in the URL (workspaceId, runId, approvalId)
// are path parameters and are not repeated here.

export const createRunRequestSchema = z.object({
  userPrompt: requiredTextSchema.max(20_000),
  orchestrationMode: orchestrationModeSchema.default("single"),
  /** Agent for `single` mode, or the supervisor for `auto`. Server default when omitted. */
  agentId: idSchema.optional(),
});
export type CreateRunRequest = z.input<typeof createRunRequestSchema>;

export const resolveApprovalRequestSchema = z.object({
  decision: approvalDecisionSchema,
});
export type ResolveApprovalRequest = z.infer<typeof resolveApprovalRequestSchema>;

export const createAgentRequestSchema = z.object({
  name: requiredTextSchema.max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(20_000).optional(),
  profileId: idSchema,
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

/** Optimistic concurrency: the version the editor started from. A stale one is a 409. */
const expectedVersion = { expectedVersion: z.number().int().positive() };

export const updateAgentRequestSchema = createAgentRequestSchema
  .partial()
  .extend({ enabled: z.boolean().optional(), ...expectedVersion });
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

export const createAgentProfileRequestSchema = z.object({
  name: requiredTextSchema.max(80),
  description: z.string().max(500).optional(),
  capabilities: agentCapabilitiesSchema,
});
export type CreateAgentProfileRequest = z.infer<typeof createAgentProfileRequestSchema>;

export const updateAgentProfileRequestSchema = createAgentProfileRequestSchema.partial().extend(expectedVersion);
export type UpdateAgentProfileRequest = z.infer<typeof updateAgentProfileRequestSchema>;

export const createSecurityPolicyRequestSchema = z.object({
  name: requiredTextSchema.max(120),
  capabilityCeiling: capabilityCeilingSchema.default({}),
  rules: jsonObjectSchema,
  rulesSchemaVersion: z.number().int().positive(),
});
export type CreateSecurityPolicyRequest = z.input<typeof createSecurityPolicyRequestSchema>;

export const updateSecurityPolicyRequestSchema = createSecurityPolicyRequestSchema.partial().extend(expectedVersion);
export type UpdateSecurityPolicyRequest = z.infer<typeof updateSecurityPolicyRequestSchema>;

export const addWorkspaceMemberRequestSchema = z.object({
  email: z.email(),
  role: workspaceRoleSchema,
});
export type AddWorkspaceMemberRequest = z.infer<typeof addWorkspaceMemberRequestSchema>;

/**
 * Workspace members, in password mode only.
 *
 *   GET    /api/workspaces/:workspaceId/members                  -> WorkspaceMembersResponse
 *   POST   /api/workspaces/:workspaceId/members  AddWorkspaceMemberRequest    -> 201 { member }
 *   PATCH  /api/workspaces/:workspaceId/members/:userId  UpdateWorkspaceMemberRequest -> { member }
 *   DELETE /api/workspaces/:workspaceId/members/:userId         -> 204
 *
 * Any member may read the list. Only `security_admin` may change it (403
 * otherwise). A workspace the caller is not in answers 404. Adding needs an
 * existing account (404); someone already in the workspace answers 409, and so
 * does demoting or removing the workspace's last `security_admin`. Creating
 * users and workspaces stays with the db:admin command line. See contract
 * decision 15.
 */
export const workspaceMemberSummarySchema = workspaceMemberSchema
  .pick({ userId: true, role: true, joinedAt: true })
  .extend({ email: userSchema.shape.email, name: userSchema.shape.name });
export type WorkspaceMemberSummary = z.infer<typeof workspaceMemberSummarySchema>;

export const workspaceMembersResponseSchema = z.object({
  members: z.array(workspaceMemberSummarySchema),
  /** The caller's own role, so a screen can offer only what the server will accept. */
  viewerRole: workspaceRoleSchema,
});
export type WorkspaceMembersResponse = z.infer<typeof workspaceMembersResponseSchema>;

export const workspaceMemberResponseSchema = z.object({ member: workspaceMemberSummarySchema });
export type WorkspaceMemberResponse = z.infer<typeof workspaceMemberResponseSchema>;

export const updateWorkspaceMemberRequestSchema = z.object({ role: workspaceRoleSchema });
export type UpdateWorkspaceMemberRequest = z.infer<typeof updateWorkspaceMemberRequestSchema>;

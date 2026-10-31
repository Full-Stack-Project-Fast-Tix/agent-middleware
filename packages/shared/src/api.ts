import { z } from "zod";
import { idSchema, jsonObjectSchema, requiredTextSchema } from "./common.js";
import { agentCapabilitiesSchema, agentSchema, capabilityCeilingSchema } from "./agents.js";
import { approvalDecisionSchema, orchestrationModeSchema, workspaceRoleSchema } from "./enums.js";
import { runSnapshotSchema } from "./events.js";
import { userSchema, workspaceMemberSchema, workspaceSchema } from "./identity.js";
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
 *   POST   /api/auth/session  SignInRequest -> 201 Session (401 on a wrong email or password)
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
 *   POST /api/workspaces/:workspaceId/runs   CreateRunRequest   -> 201 { run }
 *   GET  /api/runs/:runId/snapshot                              -> { snapshot }
 *   GET  /api/runs/:runId/events             Server-Sent Events (RunEvent)
 *   POST /api/runs/:runId/cancel                                -> 202 { run }
 *   POST /api/approvals/:approvalId/resolve  ResolveApprovalRequest -> { approval }
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
  runs: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/runs`,
  runSnapshot: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/snapshot`,
  runEvents: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/events`,
  cancelRun: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/cancel`,
  resolveApproval: (approvalId: string) => `/api/approvals/${encodeURIComponent(approvalId)}/resolve`,
  workspaceMembers: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
  workspaceMember: (workspaceId: string, userId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
} as const;

/** A workspace as listings show it; where its source lives stays on the server. */
export const workspaceSummarySchema = workspaceSchema.pick({ id: true, name: true });
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspacesResponseSchema = z.object({ workspaces: z.array(workspaceSummarySchema) });
export type WorkspacesResponse = z.infer<typeof workspacesResponseSchema>;

export const agentsResponseSchema = z.object({ agents: z.array(agentSchema) });
export type AgentsResponse = z.infer<typeof agentsResponseSchema>;

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
 * decision 13.
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

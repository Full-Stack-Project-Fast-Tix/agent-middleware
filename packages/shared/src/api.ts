import { z } from "zod";
import { idSchema, nonEmptyStringSchema, requiredTextSchema, timestampSchema } from "./common.js";
import {
  agentCapabilitiesSchema,
  agentProfileSchema,
  agentSchema,
  capabilityCeilingSchema,
  effectivePolicySchema,
  policyRulesSchema,
  securityPolicySchema,
} from "./agents.js";
import { auditEventSchema, auditEventTypeSchema } from "./audit.js";
import {
  actionTypeSchema,
  approvalDecisionSchema,
  approvalStatusSchema,
  findingSeveritySchema,
  orchestrationModeSchema,
  runStatusSchema,
  securityDecisionOutcomeSchema,
  workspaceRoleSchema,
  type ApprovalReason,
  type WorkspaceRole,
} from "./enums.js";
import { runSnapshotSchema } from "./events.js";
import { userSchema, workspaceMemberSchema, workspaceSchema } from "./identity.js";
import { fileChangeSchema } from "./middleware.js";
import { runSchema } from "./runs.js";
import { approvalSchema, securityFindingSchema } from "./security.js";

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
 * Routes for the Run -> Task -> AgentExecution model.
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
 * `developer` or `security_admin` (403 for an `auditor`). An approval also has
 * to be the caller's to answer: see mayAnswerApproval. The agents include
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
  workspaceCreate: () => "/api/workspaces",
  workspaceArchive: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/source/archive`,
  workspaceAgents: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/agents`,
  workspaceVault: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/vault/secrets`,
  workspaceVaultSecret: (workspaceId: string, name: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/vault/secrets/${encodeURIComponent(name)}`,
  workspaceAudit: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/audit`,
  runs: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/runs`,
  runSnapshot: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/snapshot`,
  runTimeline: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/timeline`,
  runEvents: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/events`,
  cancelRun: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/cancel`,
  resolveApproval: (approvalId: string) => `/api/approvals/${encodeURIComponent(approvalId)}/resolve`,
  workspaceMembers: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
  workspaceAccounts: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/accounts`,
  workspaceMember: (workspaceId: string, userId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
  executionTrace: (runId: string, executionId: string) =>
    `/api/runs/${encodeURIComponent(runId)}/executions/${encodeURIComponent(executionId)}/trace`,
  runFiles: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/files`,
  /** Full-byte ZIP export of a Run working copy (bounded and credential-filtered). */
  runArchive: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/archive`,
  runDiff: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/diff`,
  runFile: (runId: string, filePath: string) =>
    `/api/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(filePath)}`,
  benchmarks: () => "/api/benchmarks",
  workspaceFindings: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/findings`,
  workspaceApprovals: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/approvals`,
  workspaceEffectivePermissions: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/effective-permissions`,
  workspaceAgent: (workspaceId: string, agentId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`,
  workspaceProfiles: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/profiles`,
  workspaceProfile: (workspaceId: string, profileId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/profiles/${encodeURIComponent(profileId)}`,
  workspacePolicies: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/policies`,
  workspacePolicy: (workspaceId: string, policyId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/policies/${encodeURIComponent(policyId)}`,
} as const;

/** A workspace as listings show it; where its source lives stays on the server. */
export const workspaceSummarySchema = workspaceSchema
  .pick({ id: true, name: true })
  .extend({ /** The caller's own role, so a screen can offer only what the server will accept. */ role: workspaceRoleSchema });
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspacesResponseSchema = z.object({ workspaces: z.array(workspaceSummarySchema), viewerId: idSchema });
export type WorkspacesResponse = z.infer<typeof workspacesResponseSchema>;

export const agentsResponseSchema = z.object({ agents: z.array(agentSchema) });
export type AgentsResponse = z.infer<typeof agentsResponseSchema>;

/** Secret metadata only: encrypted values never cross the API boundary. */
export const workspaceVaultSecretInfoSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  allowedHosts: z.array(z.string()),
  authHeader: z.string(),
  authPrefix: z.string(),
});
export const workspaceVaultResponseSchema = z.object({ secrets: z.array(workspaceVaultSecretInfoSchema) });
export type WorkspaceVaultSecretInfo = z.infer<typeof workspaceVaultSecretInfoSchema>;
export const putWorkspaceVaultSecretSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  value: z.string().min(4).max(16_384),
  allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(20),
  authHeader: z.string().min(1).max(64).default("Authorization"),
  authPrefix: z.string().regex(/^[\x20-\x7e]{0,80}$/).default("Bearer "),
});
export type PutWorkspaceVaultSecret = z.input<typeof putWorkspaceVaultSecretSchema>;

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
  /** Secrets granted to selected agents for this Run. The server resolves values from that workspace's vault. */
  vaultGrants: z.array(z.object({
    secretName: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    agentIds: z.array(idSchema).min(1).max(20),
  })).max(100).default([]),
});
export type CreateRunRequest = z.input<typeof createRunRequestSchema>;

/**
 * Who may answer a pending approval (contract decision 19): `policy_required`
 * needs a Security Admin of the workspace, and every other reason needs the
 * developer or Security Admin who started the Run. The server enforces this;
 * the web app uses it only to offer what the server will accept.
 */
export function mayAnswerApproval(input: {
  role: WorkspaceRole;
  userId: string;
  runCreatedByUserId: string;
  reason: ApprovalReason;
}): boolean {
  if (input.role === "auditor") return false;
  if (input.reason === "policy_required") return input.role === "security_admin";
  return input.userId === input.runCreatedByUserId;
}

/**
 * The files in a Run's working copy, for the roles that may read raw traces.
 * The listing is bounded; `truncated` says it stopped before listing everything.
 */
export const runFilesResponseSchema = z.object({
  files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), modifiedAt: z.string() })),
  truncated: z.boolean().default(false),
});
export type RunFilesResponse = z.infer<typeof runFilesResponseSchema>;

/**
 * One file as redacted text, for previewing. `truncated` means it was larger
 * than the 256 KB preview and `content` is only its start. It is never the full
 * bytes: the Run ZIP is the full-byte path.
 */
export const runFileResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type RunFileResponse = z.infer<typeof runFileResponseSchema>;

// The Run diff contract (runDiffResponseSchema) lives in ./review.ts with the final review.

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
  rules: policyRulesSchema.default({}),
});
export type CreateSecurityPolicyRequest = z.input<typeof createSecurityPolicyRequestSchema>;

export const updateSecurityPolicyRequestSchema = createSecurityPolicyRequestSchema.partial().extend(expectedVersion);
export type UpdateSecurityPolicyRequest = z.infer<typeof updateSecurityPolicyRequestSchema>;

export const addWorkspaceMemberRequestSchema = z.object({
  email: z.email(),
  role: workspaceRoleSchema,
});
export type AddWorkspaceMemberRequest = z.infer<typeof addWorkspaceMemberRequestSchema>;

export const createMemberAccountRequestSchema = z.object({
  email: z.email(),
  name: requiredTextSchema.max(120),
  password: z.string().min(12).max(256),
  role: workspaceRoleSchema,
});
export type CreateMemberAccountRequest = z.infer<typeof createMemberAccountRequestSchema>;

export const createWorkspaceRequestSchema = z.object({
  name: requiredTextSchema.max(120),
  authorizationWorkspaceId: idSchema,
  /** A folder on the server for Runs to copy. Only inside the server's WORKSPACE_SOURCE_ROOTS. */
  sourcePath: requiredTextSchema.max(4096).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

export const createdWorkspaceResponseSchema = z.object({ workspace: workspaceSummarySchema });
export type CreatedWorkspaceResponse = z.infer<typeof createdWorkspaceResponseSchema>;

export const uploadWorkspaceArchiveSchema = z.object({ archiveBase64: z.string().min(1).max(14_000_000) });

/**
 * Workspace members, in password mode only.
 *
 *   GET    /api/workspaces/:workspaceId/members                  -> WorkspaceMembersResponse
 *   POST   /api/workspaces/:workspaceId/members  AddWorkspaceMemberRequest    -> 201 { member }
 *   PATCH  /api/workspaces/:workspaceId/members/:userId  UpdateWorkspaceMemberRequest -> { member }
 *   DELETE /api/workspaces/:workspaceId/members/:userId         -> 204
 *
 * Any member may read the list. Only `security_admin` may change it (403
 * otherwise). A workspace the caller is not in answers 404. Adding an existing
 * account is separate from creating a new account; a workspace security admin
 * may create an account with an initial password and add it atomically. A
 * security admin may also create an empty workspace, using a workspace they
 * administer to authorize the request. Host project paths remain operator-only.
 * See contract decision 15.
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

/**
 * Evidence across a workspace, in password mode only. Any role in the workspace
 * may read; a workspace the caller is not in answers 404. Newest first, paged by
 * an opaque cursor (an unknown one is a 400).
 *
 *   GET /api/workspaces/:workspaceId/findings   FindingListQuery  -> FindingPage
 *   GET /api/workspaces/:workspaceId/approvals  ApprovalListQuery -> ApprovalPage
 *   GET /api/workspaces/:workspaceId/audit      AuditListQuery    -> AuditPage
 *
 * Configuration, in password mode only (contract decision 21). Any role may
 * read. Developers and Security Admins may add and edit agents, but only a
 * Security Admin may give an existing agent another profile, or change profiles
 * and policies. A stale `expectedVersion` is a 409. DELETE archives, so history
 * can still name the row. Platform and locked policies are read-only here.
 *
 *   GET                    /api/workspaces/:workspaceId/effective-permissions -> { agents }
 *   POST | PATCH | DELETE  /api/workspaces/:workspaceId/agents[/:agentId]     -> { agent }
 *   GET  | POST | PATCH | DELETE  /api/workspaces/:workspaceId/profiles[/:id] -> { profiles } | { profile }
 *   GET  | POST | PATCH | DELETE  /api/workspaces/:workspaceId/policies[/:id] -> { policies } | { policy }
 */
export const findingListQuerySchema = pageQuerySchema.extend({ severity: findingSeveritySchema.optional() });
export type FindingListQuery = z.infer<typeof findingListQuerySchema>;
export const findingPageSchema = pageSchema(securityFindingSchema);
export type FindingPage = z.infer<typeof findingPageSchema>;

export const approvalListQuerySchema = pageQuerySchema.extend({ status: approvalStatusSchema.optional() });
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;
/** An approval with what a queue needs to name it and to know whose it is. */
export const approvalQueueItemSchema = approvalSchema.extend({
  runCreatedByUserId: idSchema,
  taskTitle: z.string().nullable(),
});
export type ApprovalQueueItem = z.infer<typeof approvalQueueItemSchema>;
export const approvalPageSchema = pageSchema(approvalQueueItemSchema);
export type ApprovalPage = z.infer<typeof approvalPageSchema>;

export const auditListQuerySchema = pageQuerySchema.extend({ eventType: auditEventTypeSchema.optional() });
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
export const auditPageSchema = pageSchema(auditEventSchema);
export type AuditPage = z.infer<typeof auditPageSchema>;

/** What an agent may actually do once every policy applied. Null `policy` means it could not be resolved, so it cannot run. */
export const effectivePermissionsResponseSchema = z.object({
  agents: z.array(
    z.object({
      agentId: idSchema,
      policy: effectivePolicySchema.nullable(),
    }),
  ),
});
export type EffectivePermissionsResponse = z.infer<typeof effectivePermissionsResponseSchema>;

/** Saved benchmark reports, for any signed-in user: `GET /api/benchmarks`. */
export const benchmarksResponseSchema = z.object({
  results: z.array(z.object({ name: z.string(), report: z.string() })),
});
export type BenchmarksResponse = z.infer<typeof benchmarksResponseSchema>;

export const agentResponseSchema = z.object({ agent: agentSchema });
export const profileResponseSchema = z.object({ profile: agentProfileSchema });
export const profilesResponseSchema = z.object({ profiles: z.array(agentProfileSchema) });
export const policyResponseSchema = z.object({ policy: securityPolicySchema });
export const policiesResponseSchema = z.object({ policies: z.array(securityPolicySchema) });

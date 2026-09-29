import { z } from "zod";

// Values follow the "Shared enum" table in the Product Vision & Work Plan
// (section 3.1). Changing a value is a contract change: every subsystem owner
// it affects reviews it.

export const WORKSPACE_ROLES = ["developer", "security_admin", "auditor"] as const;
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const POLICY_SCOPES = ["platform", "workspace"] as const;
export const policyScopeSchema = z.enum(POLICY_SCOPES);
export type PolicyScope = z.infer<typeof policyScopeSchema>;

export const RUN_STATUSES = [
  "queued",
  "planning",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "skipped",
  "cancelled",
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const EXECUTION_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;
export const executionStatusSchema = z.enum(EXECUTION_STATUSES);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const APPROVAL_STATUSES = ["pending", "approved", "denied", "timed_out", "cancelled"] as const;
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const FINDING_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export const findingSeveritySchema = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const SECURITY_LAYERS = ["deterministic", "semantic", "policy", "memory", "runtime"] as const;
export const securityLayerSchema = z.enum(SECURITY_LAYERS);
export type SecurityLayer = z.infer<typeof securityLayerSchema>;

export const ORCHESTRATION_MODES = ["single", "auto"] as const;
export const orchestrationModeSchema = z.enum(ORCHESTRATION_MODES);
export type OrchestrationMode = z.infer<typeof orchestrationModeSchema>;

// Enums below are not in the plan's table but are implied by section 3.4
// (security contract) and by the existing HITL runtime.

/** Outcome of one middleware evaluation (plan section 3.4). */
export const SECURITY_DECISION_OUTCOMES = ["allow", "steer", "block", "require_approval"] as const;
export const securityDecisionOutcomeSchema = z.enum(SECURITY_DECISION_OUTCOMES);
export type SecurityDecisionOutcome = z.infer<typeof securityDecisionOutcomeSchema>;

/** Normalised action kinds the middleware evaluates. Expand only when needed. */
export const ACTION_TYPES = ["command", "file_change", "delegation"] as const;
export const actionTypeSchema = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof actionTypeSchema>;

/**
 * Why a human is being asked. The first three are the reasons the current
 * runtime already raises; `policy_required` covers policy-driven HITL.
 */
export const APPROVAL_REASONS = [
  "high_consequence",
  "semantic_uncertainty",
  "semantic_unavailable",
  "policy_required",
] as const;
export const approvalReasonSchema = z.enum(APPROVAL_REASONS);
export type ApprovalReason = z.infer<typeof approvalReasonSchema>;

export const APPROVAL_DECISIONS = ["approve", "deny"] as const;
export const approvalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const ACTOR_TYPES = ["user", "agent", "system"] as const;
export const actorTypeSchema = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof actorTypeSchema>;

// Terminal statuses: nothing transitions out of these. The scheduler uses them
// to decide when a Run is finished; the UI uses them to stop showing spinners.

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);
const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);
const TERMINAL_APPROVAL_STATUSES: ReadonlySet<ApprovalStatus> = new Set([
  "approved",
  "denied",
  "timed_out",
  "cancelled",
]);

export const isTerminalRunStatus = (status: RunStatus): boolean => TERMINAL_RUN_STATUSES.has(status);
export const isTerminalTaskStatus = (status: TaskStatus): boolean => TERMINAL_TASK_STATUSES.has(status);
export const isTerminalExecutionStatus = (status: ExecutionStatus): boolean =>
  TERMINAL_EXECUTION_STATUSES.has(status);
export const isTerminalApprovalStatus = (status: ApprovalStatus): boolean =>
  TERMINAL_APPROVAL_STATUSES.has(status);

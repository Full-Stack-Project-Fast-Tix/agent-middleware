import { z } from "zod";
import { idSchema, nonEmptyStringSchema } from "./common.js";
import { approvalReasonSchema, findingSeveritySchema } from "./enums.js";
import { securityFindingDraftSchema } from "./security.js";

// The P1/P2 boundary (plan section 3.4):
//
//   orchestrator (P2) builds SecurityContext + ProposedAction
//     -> middleware (P1) evaluates capabilities, policy, deterministic guards,
//        and semantic alignment
//     -> SecurityDecision
//     -> orchestrator executes only if permitted
//
// The middleware resolves the effective policy itself from workspaceId and
// agentId, so a caller cannot hand it a weaker policy than the one stored.

export const trajectoryEntrySchema = z.object({
  /** Sequence number in the execution's raw trace. */
  seq: z.number().int().nonnegative(),
  kind: z.enum(["reasoning", "command", "file_change", "tool_output", "delegation"]),
  /** Bounded, redacted summary. */
  summary: z.string().max(2_000),
});
export type TrajectoryEntry = z.infer<typeof trajectoryEntrySchema>;

/**
 * Workspace content the agent has read (README, skills, config, tool output).
 * Always untrusted: it may inform the work but never redefines the objective.
 */
export const untrustedSourceSchema = z.object({
  seq: z.number().int().nonnegative(),
  path: nonEmptyStringSchema,
});
export type UntrustedSource = z.infer<typeof untrustedSourceSchema>;

/** The execution that delegated the current task, if any. */
export const delegatorContextSchema = z.object({
  agentId: idSchema,
  executionId: idSchema,
  taskId: idSchema.nullable(),
  /** The objective the delegator was itself working on. */
  objective: nonEmptyStringSchema,
});
export type DelegatorContext = z.infer<typeof delegatorContextSchema>;

/**
 * Trusted facts about who is acting and why. Authority order: the original
 * user goal and mandatory constraints outrank the delegated task objective,
 * which outranks anything in `recentSources`.
 */
export const securityContextSchema = z.object({
  workspaceId: idSchema,
  runId: idSchema,
  taskId: idSchema,
  executionId: idSchema,
  agentId: idSchema,
  /** Run.userPrompt, verbatim. */
  originalUserGoal: nonEmptyStringSchema,
  /** Task.objective for the current task. */
  taskObjective: nonEmptyStringSchema,
  agentInstructions: z.string(),
  /** Null for a top-level task. */
  delegator: delegatorContextSchema.nullable(),
  /** 0 for a top-level task, +1 per delegation hop. */
  delegationDepth: z.number().int().nonnegative(),
  /** Limited recent window. Runtime-only; never persisted as a whole. */
  recentTrajectory: z.array(trajectoryEntrySchema),
  recentSources: z.array(untrustedSourceSchema),
});
export type SecurityContext = z.infer<typeof securityContextSchema>;

export const fileChangeSchema = z.object({
  path: nonEmptyStringSchema,
  kind: z.enum(["add", "update", "delete"]),
  /** Destination for a rename; null otherwise. */
  movePath: z.string().nullable(),
  diff: z.string().nullable(),
});
export type FileChange = z.infer<typeof fileChangeSchema>;

const actionIdSchema = nonEmptyStringSchema;

export const commandActionSchema = z.object({
  type: z.literal("command"),
  /** Runtime item id, used to correlate with the trace and approvals. */
  actionId: actionIdSchema,
  command: nonEmptyStringSchema,
  cwd: z.string().nullable(),
});

export const fileChangeActionSchema = z.object({
  type: z.literal("file_change"),
  actionId: actionIdSchema,
  changes: z.array(fileChangeSchema).min(1),
});

export const delegationActionSchema = z.object({
  type: z.literal("delegation"),
  actionId: actionIdSchema,
  /** Must be a registered Agent in the same workspace. */
  targetAgentId: idSchema,
  title: nonEmptyStringSchema,
  objective: nonEmptyStringSchema,
  dependsOnTaskIds: z.array(idSchema),
});

export const proposedActionSchema = z.discriminatedUnion("type", [
  commandActionSchema,
  fileChangeActionSchema,
  delegationActionSchema,
]);
export type ProposedAction = z.infer<typeof proposedActionSchema>;
export type CommandAction = z.infer<typeof commandActionSchema>;
export type FileChangeAction = z.infer<typeof fileChangeActionSchema>;
export type DelegationAction = z.infer<typeof delegationActionSchema>;

export const securityEvaluationRequestSchema = z.object({
  context: securityContextSchema,
  action: proposedActionSchema,
});
export type SecurityEvaluationRequest = z.infer<typeof securityEvaluationRequestSchema>;

const decisionBase = {
  /** Why, in one or two sentences, for the timeline and the approver. */
  reason: nonEmptyStringSchema,
  /** Highest severity among `findings`, or "info" when there are none. */
  severity: findingSeveritySchema,
  findings: z.array(securityFindingDraftSchema),
};

/**
 * - allow: execute as proposed.
 * - steer: do not execute; send `steer` back to the agent as a correction.
 * - block: do not execute; `steer` optionally tells the agent what to do instead.
 * - require_approval: pause until a human approves or denies.
 */
export const securityDecisionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("allow"), ...decisionBase }),
  z.object({ outcome: z.literal("steer"), ...decisionBase, steer: nonEmptyStringSchema }),
  z.object({ outcome: z.literal("block"), ...decisionBase, steer: nonEmptyStringSchema.nullable() }),
  z.object({
    outcome: z.literal("require_approval"),
    ...decisionBase,
    approvalReason: approvalReasonSchema,
  }),
]);
export type SecurityDecision = z.infer<typeof securityDecisionSchema>;

/** Implemented by the middleware (P1); called by the orchestrator (P2). */
export interface SecurityEvaluator {
  evaluate(request: SecurityEvaluationRequest): Promise<SecurityDecision>;
}

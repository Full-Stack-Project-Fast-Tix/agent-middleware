import { z } from "zod";
import { idSchema, nonEmptyStringSchema } from "./common.js";
import { appliedPolicySchema } from "./agents.js";
import { approvalReasonSchema, findingSeveritySchema } from "./enums.js";
import { securityFindingDraftSchema } from "./security.js";

// Data crossing the P1/P2 boundary (plan section 3.4). The interfaces that use
// it (SecurityMiddleware, ExecutionGuard) are server-internal and live in
// apps/server/src/security-middleware.ts.
//
//   orchestrator (P2) opens a guard per AgentExecution with a SecurityContext
//     -> runtime feeds the guard every trace record and every gated action
//     -> middleware (P1) evaluates capabilities, policy, deterministic guards
//        and semantic alignment
//     -> SecurityDecision
//     -> the action executes only if the decision permits it

/**
 * Which execution is acting: identifiers only. The middleware loads the
 * trusted facts itself (Run.userPrompt, the Task and its delegation chain,
 * Agent.instructions, the effective policy) and derives the recent trajectory
 * and untrusted sources from the records it observes. The orchestrator
 * therefore cannot substitute a goal, weaken a policy, or decide what counts
 * as untrusted.
 */
export const securityContextSchema = z.object({
  workspaceId: idSchema,
  runId: idSchema,
  taskId: idSchema,
  executionId: idSchema,
  agentId: idSchema,
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

/**
 * Proposed by a supervisor. If the decision is not allow (or the approval is
 * not granted), no Task is created, planned tasks that depend on it are not
 * created either, and the finding stays on the delegating execution's task.
 */
export const delegationActionSchema = z.object({
  type: z.literal("delegation"),
  actionId: actionIdSchema,
  /** Must be a registered, enabled Agent in the same workspace. */
  targetAgentId: idSchema,
  title: nonEmptyStringSchema,
  objective: nonEmptyStringSchema,
  dependsOnTaskIds: z.array(idSchema),
});

/**
 * One task's result about to become input to another. Checked like any other
 * action, so context passing cannot carry secrets or injected instructions
 * past the middleware (plan Pillar A).
 */
export const contextHandoffActionSchema = z.object({
  type: z.literal("context_handoff"),
  actionId: actionIdSchema,
  fromTaskId: idSchema,
  toTaskId: idSchema,
  content: z.string(),
});

export const proposedActionSchema = z.discriminatedUnion("type", [
  commandActionSchema,
  fileChangeActionSchema,
  delegationActionSchema,
  contextHandoffActionSchema,
]);
export type ProposedAction = z.infer<typeof proposedActionSchema>;
export type CommandAction = z.infer<typeof commandActionSchema>;
export type FileChangeAction = z.infer<typeof fileChangeActionSchema>;
export type DelegationAction = z.infer<typeof delegationActionSchema>;
export type ContextHandoffAction = z.infer<typeof contextHandoffActionSchema>;

const decisionBase = {
  /** Why, in one or two sentences, for the timeline and the approver. */
  reason: nonEmptyStringSchema,
  /** Highest severity among `findings` (see highestSeverity), or "info" when there are none. */
  severity: findingSeveritySchema,
  /** A "warning" is a finding with intervened: false on an allow or steer. */
  findings: z.array(securityFindingDraftSchema),
  /** The policy versions this decision was made under. */
  appliedPolicies: z.array(appliedPolicySchema),
};

/**
 * - allow: the action proceeds.
 * - steer: the action proceeds, and `steer` is sent to the agent as a
 *   correction (as the runtime does today). An observed record with no action
 *   can also be steered.
 * - block: the action is refused. `stop: "action"` refuses just this one, and
 *   `steer` tells the agent what to do instead. `stop: "execution"` also ends
 *   the execution; the orchestrator marks it failed and does not retry it.
 *   Escalating repeated blocks to a stop is the middleware's call, not the
 *   orchestrator's.
 * - require_approval: pause until a human decides, then report the answer with
 *   ExecutionGuard.recordApprovalOutcome, which returns the final decision.
 */
export const securityDecisionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("allow"), ...decisionBase }),
  z.object({ outcome: z.literal("steer"), ...decisionBase, steer: nonEmptyStringSchema }),
  z.object({
    outcome: z.literal("block"),
    ...decisionBase,
    stop: z.enum(["action", "execution"]),
    steer: nonEmptyStringSchema.nullable(),
  }),
  z.object({
    outcome: z.literal("require_approval"),
    ...decisionBase,
    approvalReason: approvalReasonSchema,
  }),
]);
export type SecurityDecision = z.infer<typeof securityDecisionSchema>;

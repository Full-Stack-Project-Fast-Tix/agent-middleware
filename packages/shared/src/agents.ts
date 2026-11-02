import { z } from "zod";
import { auditTimestampsShape, idSchema, jsonObjectSchema, nonEmptyStringSchema, timestampSchema } from "./common.js";
import { policyScopeSchema } from "./enums.js";

/**
 * Least-privilege capability set (plan section 3.1: filesystem, shell/tool,
 * network, write, delegation).
 *
 * Layers combine so that a more specific one can only tighten: booleans by AND,
 * numbers by minimum. Finer limits (denied paths, allowed hosts) belong in
 * SecurityPolicy.rules.
 *
 * There is deliberately no `read` flag. The runtime auto-approves known-safe
 * read-only commands without a gate, so it could not be enforced, and the
 * Policies UI would be promising something nothing checks. `shell: false`
 * likewise still permits those safe reads.
 *
 * A new flag must be added with `.default(false)`, so profiles stored before it
 * existed still parse and gain nothing.
 */
export const agentCapabilitiesSchema = z.object({
  /** Create, modify or delete files in the run working copy. */
  write: z.boolean(),
  /** Run shell commands and tools beyond known-safe reads. */
  shell: z.boolean(),
  /** Reach the network from inside the execution. */
  network: z.boolean(),
  /** Hand a sub-task to another registered Agent. Normally only supervisor profiles. */
  delegate: z.boolean(),
  /** How many delegation hops may follow from this agent's tasks. 0 when `delegate` is false. */
  maxDelegationDepth: z.number().int().nonnegative(),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

/** A layer's upper bound. A missing key does not restrict that capability. */
export const capabilityCeilingSchema = agentCapabilitiesSchema.partial();

/** `SecurityPolicy.rules` at version 1: none yet. A rule stays unsupported until P1 has reviewed its schema. */
export const policyRulesSchema = z.strictObject({});
export type CapabilityCeiling = z.infer<typeof capabilityCeilingSchema>;

/** Soft delete. Archived rows stay referenced by history; they cannot be used for new work. */
const archivable = { archivedAt: timestampSchema.nullable() };

export const agentProfileSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: nonEmptyStringSchema,
  description: z.string().nullable(),
  capabilities: agentCapabilitiesSchema,
  /** Optimistic concurrency: capabilities are security-relevant. */
  version: z.number().int().positive(),
  ...archivable,
  ...auditTimestampsShape,
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

/**
 * Reusable configuration for a specialist. Runtime state (working directory,
 * thread, current status) belongs to AgentExecution, not here.
 */
export const agentSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: nonEmptyStringSchema,
  description: z.string().nullable(),
  instructions: z.string(),
  profileId: idSchema,
  enabled: z.boolean(),
  createdByUserId: idSchema,
  /** Optimistic concurrency: instructions are trusted context for the semantic guard. */
  version: z.number().int().positive(),
  ...archivable,
  ...auditTimestampsShape,
});
export type Agent = z.infer<typeof agentSchema>;

const securityPolicyObject = z.object({
  id: idSchema,
  /** Null only for mandatory platform policy. */
  workspaceId: idSchema.nullable(),
  name: nonEmptyStringSchema,
  scope: policyScopeSchema,
  /** Upper bound on every agent's capabilities in this policy's scope. */
  capabilityCeiling: capabilityCeilingSchema,
  /** Rule payload; its structure is owned by the policy engine (P1). */
  rules: jsonObjectSchema,
  /** Which format `rules` is in, so a later format change can find and migrate old rows. */
  rulesSchemaVersion: z.number().int().positive(),
  /** Locked policies cannot be edited by a workspace security admin. */
  locked: z.boolean(),
  /** Optimistic-concurrency counter; audit metadata records rules before and after. */
  version: z.number().int().positive(),
  ...archivable,
  ...auditTimestampsShape,
});

/**
 * Platform policy has no workspace; workspace policy must have one. Workspace
 * policy may tighten platform rules but never weaken them.
 */
export const securityPolicySchema = securityPolicyObject.refine(
  (policy) => (policy.scope === "platform") === (policy.workspaceId === null),
  { message: "Platform policies have no workspaceId; workspace policies require one", path: ["workspaceId"] },
);
export type SecurityPolicy = z.infer<typeof securityPolicySchema>;

export const appliedPolicySchema = z.object({
  policyId: idSchema,
  version: z.number().int().positive(),
});
export type AppliedPolicy = z.infer<typeof appliedPolicySchema>;

/**
 * What an agent may do in a workspace once every layer is combined: platform
 * ceilings, then workspace ceilings, then the agent's profile. Resolved by the
 * middleware (P1); the orchestrator (P2) uses it to schedule, and the Policies
 * UI shows it as "effective permissions".
 */
export const effectivePolicySchema = z.object({
  capabilities: agentCapabilitiesSchema,
  /** The policies that produced it, so a later reader can reconstruct why. */
  appliedPolicies: z.array(appliedPolicySchema),
});
export type EffectivePolicy = z.infer<typeof effectivePolicySchema>;

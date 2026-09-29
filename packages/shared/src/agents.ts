import { z } from "zod";
import { auditTimestampsShape, idSchema, jsonObjectSchema, nonEmptyStringSchema } from "./common.js";
import { policyScopeSchema } from "./enums.js";

/**
 * Least-privilege capability set (plan section 3.1: filesystem, shell/tool,
 * network, write, delegation).
 *
 * Every flag is a permission, so combining layers is a plain AND: a more
 * specific layer can switch a capability off but never back on. Finer-grained
 * limits (denied paths, allowed hosts) belong in SecurityPolicy.rules until
 * the policy engine needs them here.
 */
export const agentCapabilitiesSchema = z.object({
  /** Read files in the run working copy. */
  read: z.boolean(),
  /** Create, modify or delete files in the run working copy. */
  write: z.boolean(),
  /** Run shell commands and tools. */
  shell: z.boolean(),
  /** Reach the network from inside the execution. */
  network: z.boolean(),
  /** Hand a sub-task to another registered Agent. */
  delegate: z.boolean(),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

export const agentProfileSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: nonEmptyStringSchema,
  description: z.string().nullable(),
  capabilities: agentCapabilitiesSchema,
  ...auditTimestampsShape,
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

/**
 * Reusable configuration for a specialist. Runtime state (working directory,
 * Codex thread, current status) belongs to AgentExecution, not here.
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
  ...auditTimestampsShape,
});
export type Agent = z.infer<typeof agentSchema>;

const securityPolicyObject = z.object({
  id: idSchema,
  /** Null only for mandatory platform policy. */
  workspaceId: idSchema.nullable(),
  name: nonEmptyStringSchema,
  scope: policyScopeSchema,
  /** Rule payload; its structure is owned by the policy engine (P1). */
  rules: jsonObjectSchema,
  /** Locked policies cannot be edited by a workspace security admin. */
  locked: z.boolean(),
  version: z.number().int().positive(),
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

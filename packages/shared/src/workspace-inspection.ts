import { z } from "zod";
import { agentProfileSchema, agentSchema, securityPolicySchema } from "./agents.js";
import { idSchema, timestampSchema } from "./common.js";
import { auditEventTypeSchema } from "./audit.js";
import { workspaceRoleSchema } from "./enums.js";

export const workspaceConfigurationSchema = z.object({
  agents: z.array(agentSchema),
  profiles: z.array(agentProfileSchema),
  policies: z.array(securityPolicySchema),
  viewerRole: workspaceRoleSchema,
});
export type WorkspaceConfiguration = z.infer<typeof workspaceConfigurationSchema>;

// The audit view deliberately returns only index fields. Arbitrary event metadata
// can contain user supplied text and is not needed for the first audit screen.
export const workspaceAuditItemSchema = z.object({
  id: idSchema,
  actorType: z.enum(["user", "agent", "system"]),
  actorId: idSchema.nullable(),
  eventType: auditEventTypeSchema,
  runId: idSchema.nullable(),
  createdAt: timestampSchema,
});
export type WorkspaceAuditItem = z.infer<typeof workspaceAuditItemSchema>;
export const workspaceAuditResponseSchema = z.object({
  items: z.array(workspaceAuditItemSchema),
  nextCursor: z.string().nullable(),
});
export type WorkspaceAuditResponse = z.infer<typeof workspaceAuditResponseSchema>;

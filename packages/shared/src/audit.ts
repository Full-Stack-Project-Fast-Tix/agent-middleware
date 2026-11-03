import { z } from "zod";
import { idSchema, jsonObjectSchema, timestampSchema } from "./common.js";
import { actorTypeSchema } from "./enums.js";

/**
 * Starting set of audit event types: lifecycle, delegation, security, approval
 * and policy changes. Add a value here rather than inventing strings at call
 * sites, so the audit viewer can filter on it.
 */
export const AUDIT_EVENT_TYPES = [
  "run.created",
  "run.status_changed",
  "task.created",
  "task.status_changed",
  "execution.started",
  "execution.finished",
  "delegation.requested",
  "security.decision",
  "approval.requested",
  "approval.resolved",
  "run.cancel_requested",
  "policy.created",
  "policy.updated",
  "policy.archived",
  "profile.created",
  "profile.updated",
  "profile.archived",
  "agent.created",
  "agent.updated",
  "agent.archived",
  "member.added",
  "member.role_changed",
  "member.removed",
  "user.created",
  "workspace.created",
  "workspace.source_uploaded",
] as const;
export const auditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof auditEventTypeSchema>;

/**
 * Append-only. Never updated or deleted by application code. Nothing is
 * deleted elsewhere either: policies, profiles and agents are archived, so the
 * evidence that references them survives.
 */
export const auditEventSchema = z
  .object({
    id: idSchema,
    /** Null only for platform-scope events, such as changes to platform policy. */
    workspaceId: idSchema.nullable(),
    actorType: actorTypeSchema,
    /** User or Agent id; null for system actors. */
    actorId: idSchema.nullable(),
    eventType: auditEventTypeSchema,
    runId: idSchema.nullable(),
    taskId: idSchema.nullable(),
    executionId: idSchema.nullable(),
    metadata: jsonObjectSchema.nullable(),
    createdAt: timestampSchema,
  })
  .refine((event) => event.actorType === "system" || event.actorId !== null, {
    message: "User and agent actors require an actorId",
    path: ["actorId"],
  });
export type AuditEvent = z.infer<typeof auditEventSchema>;

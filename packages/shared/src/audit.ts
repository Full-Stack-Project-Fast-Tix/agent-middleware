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
  "policy.created",
  "policy.updated",
  "policy.deleted",
  "agent.created",
  "agent.updated",
  "member.added",
  "member.role_changed",
  "member.removed",
] as const;
export const auditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof auditEventTypeSchema>;

/** Append-only. Never updated or deleted by application code. */
export const auditEventSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
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

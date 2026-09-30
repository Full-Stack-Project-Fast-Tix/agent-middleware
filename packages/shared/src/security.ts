import { z } from "zod";
import {
  factsSchema,
  idSchema,
  jsonObjectSchema,
  nonEmptyStringSchema,
  timestampSchema,
} from "./common.js";
import {
  actionTypeSchema,
  approvalReasonSchema,
  approvalStatusSchema,
  findingSeveritySchema,
  securityLayerSchema,
} from "./enums.js";

/**
 * What a check reported, before it is attached to a Run and persisted. This is
 * the shape the middleware returns inside a SecurityDecision.
 */
export const securityFindingDraftSchema = z.object({
  layer: securityLayerSchema,
  /** Name of the check that produced this. */
  check: nonEmptyStringSchema,
  /** Stable machine-readable label, e.g. "read-then-egress". */
  code: nonEmptyStringSchema,
  severity: findingSeveritySchema,
  /** One sentence, written for a person reading a report. */
  message: nonEmptyStringSchema,
  /** Verbatim structured values for the memory layer. Never prose or model output. */
  facts: factsSchema.nullable(),
  /** Trace sequence numbers and compact derived data. Never raw secrets. */
  evidence: jsonObjectSchema.nullable(),
  /** True when this finding caused a steer, block or approval request. */
  intervened: z.boolean(),
});
export type SecurityFindingDraft = z.infer<typeof securityFindingDraftSchema>;

/**
 * A persisted finding. References the most specific scope available while
 * always keeping runId.
 */
export const securityFindingSchema = securityFindingDraftSchema.extend({
  id: idSchema,
  runId: idSchema,
  taskId: idSchema.nullable(),
  executionId: idSchema.nullable(),
  agentId: idSchema.nullable(),
  createdAt: timestampSchema,
});
export type SecurityFinding = z.infer<typeof securityFindingSchema>;

/** A persisted human-in-the-loop request. Decision history stays auditable. */
export const approvalSchema = z.object({
  id: idSchema,
  runId: idSchema,
  taskId: idSchema.nullable(),
  executionId: idSchema.nullable(),
  agentId: idSchema,
  actionType: actionTypeSchema,
  /** Runtime item id of the gated action, when the runtime provides one. */
  actionId: z.string().nullable(),
  reason: approvalReasonSchema,
  /** Short description for the approver. */
  summary: nonEmptyStringSchema,
  /** Redacted, bounded details safe to show in the UI. */
  safeDetails: jsonObjectSchema.nullable(),
  status: approvalStatusSchema,
  requestedAt: timestampSchema,
  /** When an unanswered request becomes `timed_out`. */
  expiresAt: timestampSchema.nullable(),
  resolvedAt: timestampSchema.nullable(),
  resolvedByUserId: idSchema.nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;

/** A structured lesson learned by an Agent, kept separate from the Agent row. */
export const reflectionSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  code: nonEmptyStringSchema,
  facts: factsSchema,
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
});
export type Reflection = z.infer<typeof reflectionSchema>;

/**
 * Where a reflection was observed, instead of a growing array on the Reflection.
 * runId and executionId are null only on rows migrated from the JSON store,
 * which kept run ids and thread ids unpaired. New sightings always set both.
 */
export const reflectionSightingSchema = z.object({
  id: idSchema,
  reflectionId: idSchema,
  runId: idSchema.nullable(),
  executionId: idSchema.nullable(),
  threadId: z.string().nullable(),
  seenAt: timestampSchema,
});
export type ReflectionSighting = z.infer<typeof reflectionSightingSchema>;

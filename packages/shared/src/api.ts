import { z } from "zod";
import { idSchema, jsonObjectSchema, nonEmptyStringSchema } from "./common.js";
import { agentCapabilitiesSchema } from "./agents.js";
import { approvalDecisionSchema, orchestrationModeSchema, workspaceRoleSchema } from "./enums.js";

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

// Request bodies. Ids that appear in the URL (workspaceId, runId, approvalId)
// are path parameters and are not repeated here.

export const createRunRequestSchema = z.object({
  userPrompt: nonEmptyStringSchema.max(20_000),
  orchestrationMode: orchestrationModeSchema.default("single"),
  /** Agent for `single` mode, or the supervisor for `auto`. Server default when omitted. */
  agentId: idSchema.optional(),
});
export type CreateRunRequest = z.input<typeof createRunRequestSchema>;

export const resolveApprovalRequestSchema = z.object({
  decision: approvalDecisionSchema,
});
export type ResolveApprovalRequest = z.infer<typeof resolveApprovalRequestSchema>;

export const createAgentRequestSchema = z.object({
  name: nonEmptyStringSchema.max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(20_000).optional(),
  profileId: idSchema,
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

export const updateAgentRequestSchema = createAgentRequestSchema
  .partial()
  .extend({ enabled: z.boolean().optional() });
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

export const createAgentProfileRequestSchema = z.object({
  name: nonEmptyStringSchema.max(80),
  description: z.string().max(500).optional(),
  capabilities: agentCapabilitiesSchema,
});
export type CreateAgentProfileRequest = z.infer<typeof createAgentProfileRequestSchema>;

export const createSecurityPolicyRequestSchema = z.object({
  name: nonEmptyStringSchema.max(120),
  rules: jsonObjectSchema,
});
export type CreateSecurityPolicyRequest = z.infer<typeof createSecurityPolicyRequestSchema>;

export const updateSecurityPolicyRequestSchema = createSecurityPolicyRequestSchema.partial().extend({
  /** Optimistic concurrency: the version the editor started from. */
  expectedVersion: z.number().int().positive(),
});
export type UpdateSecurityPolicyRequest = z.infer<typeof updateSecurityPolicyRequestSchema>;

export const addWorkspaceMemberRequestSchema = z.object({
  email: z.email(),
  role: workspaceRoleSchema,
});
export type AddWorkspaceMemberRequest = z.infer<typeof addWorkspaceMemberRequestSchema>;

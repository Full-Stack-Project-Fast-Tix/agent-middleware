import { z } from "zod";
import { auditTimestampsShape, idSchema, nonEmptyStringSchema, timestampSchema } from "./common.js";
import { workspaceRoleSchema } from "./enums.js";

/** Human identity only. Workspace access comes through WorkspaceMember. */
export const userSchema = z.object({
  id: idSchema,
  email: z.email(),
  name: nonEmptyStringSchema,
  /** Subject claim from the auth provider. */
  authSubject: nonEmptyStringSchema,
  ...auditTimestampsShape,
});
export type User = z.infer<typeof userSchema>;

/**
 * The logical project and security boundary. Each Run gets its own isolated
 * working copy prepared from this; the Workspace itself is never a shared
 * physical folder.
 */
export const workspaceSchema = z.object({
  id: idSchema,
  name: nonEmptyStringSchema,
  sourcePath: z.string().nullable(),
  repositoryUrl: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  createdByUserId: idSchema,
  ...auditTimestampsShape,
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** Composite key (workspaceId, userId). The backend enforces role permissions. */
export const workspaceMemberSchema = z.object({
  workspaceId: idSchema,
  userId: idSchema,
  role: workspaceRoleSchema,
  joinedAt: timestampSchema,
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

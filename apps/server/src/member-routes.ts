import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  addWorkspaceMemberRequestSchema,
  createMemberAccountRequestSchema,
  createWorkspaceRequestSchema,
  updateWorkspaceMemberRequestSchema,
  workspaceSummarySchema,
  uploadWorkspaceArchiveSchema,
} from "@launchpad/shared";
import { signedInUser } from "./auth-routes.js";
import { addMember, attachWorkspaceSource, changeMemberRole, createMemberAccount, createWorkspaceForAdmin, listMembers, removeMember } from "./db/admin.js";
import { extractWorkspaceZip } from "./workspace-archive.js";
import { HttpError } from "./errors.js";

// Workspace members, as specified in packages/shared/src/api.ts. Authentication
// is the session hook. Authorisation is in db/admin.ts, because the role has to
// be read inside the transaction that makes the change.

const workspaceParams = z.object({ workspaceId: z.guid() });
const memberParams = workspaceParams.extend({ userId: z.guid() });

export function registerMemberRoutes(app: FastifyInstance, pool: pg.Pool, sourceRoots: readonly string[] = [], dataDirectory = ".data"): void {
  app.post("/api/workspaces", async (request, reply) => {
    const input = createWorkspaceRequestSchema.parse(request.body);
    const created = await createWorkspaceForAdmin(pool, {
      authorizationWorkspaceId: input.authorizationWorkspaceId,
      actorUserId: signedInUser(request).id,
      name: input.name,
      ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
      sourceRoots,
    });
    return reply.code(201).send({ workspace: workspaceSummarySchema.parse({ ...created, role: "security_admin" }) });
  });

  app.post("/api/workspaces/:workspaceId/source/archive", async (request, reply) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    const { archiveBase64 } = uploadWorkspaceArchiveSchema.parse(request.body);
    const userId = signedInUser(request).id;
    const parent = path.join(dataDirectory, "workspace-sources", workspaceId);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(path.join(parent, ".staging-"));
    const sourcePath = path.join(parent, `project-${randomUUID()}`);
    try {
      await extractWorkspaceZip(archiveBase64, staging);
      await rename(staging, sourcePath);
      await attachWorkspaceSource(pool, { workspaceId, actorUserId: userId, sourcePath });
      return reply.code(201).send({ message: "Project files uploaded and attached to the workspace." });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      await rm(sourcePath, { recursive: true, force: true });
      if (error instanceof Error && !("statusCode" in error)) throw new HttpError(400, error.message);
      throw error;
    }
  });

  app.get("/api/workspaces/:workspaceId/members", async (request) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    return listMembers(pool, workspaceId, signedInUser(request).id);
  });

  app.post("/api/workspaces/:workspaceId/members", async (request, reply) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    const { email, role } = addWorkspaceMemberRequestSchema.parse(request.body);
    const member = await addMember(pool, { workspaceId, actorUserId: signedInUser(request).id, email, role });
    return reply.code(201).send({ member });
  });

  app.post("/api/workspaces/:workspaceId/accounts", async (request, reply) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    const input = createMemberAccountRequestSchema.parse(request.body);
    const member = await createMemberAccount(pool, {
      workspaceId,
      actorUserId: signedInUser(request).id,
      ...input,
    });
    return reply.code(201).send({ member });
  });

  app.patch("/api/workspaces/:workspaceId/members/:userId", async (request) => {
    const { workspaceId, userId } = memberParams.parse(request.params);
    const { role } = updateWorkspaceMemberRequestSchema.parse(request.body);
    return { member: await changeMemberRole(pool, { workspaceId, actorUserId: signedInUser(request).id, userId, role }) };
  });

  app.delete("/api/workspaces/:workspaceId/members/:userId", async (request, reply) => {
    const { workspaceId, userId } = memberParams.parse(request.params);
    await removeMember(pool, { workspaceId, actorUserId: signedInUser(request).id, userId });
    return reply.code(204).send();
  });
}

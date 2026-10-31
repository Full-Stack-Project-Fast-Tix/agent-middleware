import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { addWorkspaceMemberRequestSchema, updateWorkspaceMemberRequestSchema } from "@launchpad/shared";
import { signedInUser } from "./auth-routes.js";
import { addMember, changeMemberRole, listMembers, removeMember } from "./db/admin.js";

// Workspace members, as specified in packages/shared/src/api.ts. Authentication
// is the session hook. Authorisation is in db/admin.ts, because the role has to
// be read inside the transaction that makes the change.

const workspaceParams = z.object({ workspaceId: z.guid() });
const memberParams = workspaceParams.extend({ userId: z.guid() });

export function registerMemberRoutes(app: FastifyInstance, pool: pg.Pool): void {
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

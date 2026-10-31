import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { agentProfileSchema, agentSchema, securityPolicySchema, workspaceAuditItemSchema } from "@launchpad/shared";
import { z } from "zod";
import { signedInUser, type Identity } from "./auth-routes.js";
import { HttpError } from "./errors.js";
import { fromRow } from "./db/rows.js";

const paramsSchema = z.object({ workspaceId: z.guid() });
const auditQuerySchema = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
type WorkspaceIdentity = Identity & { workspaceRole(workspaceId: string, userId: string): Promise<"developer" | "security_admin" | "auditor" | null> };

function decodeCursor(value: string): { at: string; id: string } {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8").split("\n");
    if (decoded.length !== 2) throw new Error();
    return { at: z.iso.datetime().parse(decoded[0]), id: z.guid().parse(decoded[1]) };
  } catch {
    throw new HttpError(400, "Invalid audit cursor");
  }
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}\n${id}`).toString("base64url");
}

async function requireWorkspaceMember(identity: WorkspaceIdentity, workspaceId: string, userId: string) {
  if (await identity.workspaceRole(workspaceId, userId) === null) throw new HttpError(404, "Workspace not found");
}

export function registerWorkspaceInspectionRoutes(app: FastifyInstance, pool: pg.Pool, identity: WorkspaceIdentity): void {
  app.get("/api/workspaces/:workspaceId/configuration", async (request) => {
    const { workspaceId } = paramsSchema.parse(request.params);
    await requireWorkspaceMember(identity, workspaceId, signedInUser(request).id);
    const [agentRows, profileRows, policyRows, role] = await Promise.all([
      pool.query<Record<string, unknown>>("SELECT * FROM agents WHERE workspace_id = $1 ORDER BY created_at, id", [workspaceId]),
      pool.query<Record<string, unknown>>("SELECT * FROM agent_profiles WHERE workspace_id = $1 ORDER BY created_at, id", [workspaceId]),
      pool.query<Record<string, unknown>>(
        `SELECT * FROM security_policies WHERE archived_at IS NULL
          AND (scope = 'platform' OR (scope = 'workspace' AND workspace_id = $1))
          ORDER BY CASE scope WHEN 'platform' THEN 0 ELSE 1 END, created_at, id`,
        [workspaceId],
      ),
      identity.workspaceRole(workspaceId, signedInUser(request).id),
    ]);
    const agents = agentRows.rows.map((row) => agentSchema.parse(fromRow(row)));
    const profiles = profileRows.rows.map((row) => agentProfileSchema.parse(fromRow(row)));
    const policies = policyRows.rows.map((raw) => {
      const row = fromRow(raw);
      const source = raw as Record<string, unknown>;
      return securityPolicySchema.parse({
        ...row,
        capabilityCeiling: {
          ...(source.ceil_write === null ? {} : { write: source.ceil_write }),
          ...(source.ceil_shell === null ? {} : { shell: source.ceil_shell }),
          ...(source.ceil_network === null ? {} : { network: source.ceil_network }),
          ...(source.ceil_delegate === null ? {} : { delegate: source.ceil_delegate }),
          ...(source.ceil_max_delegation_depth === null ? {} : { maxDelegationDepth: source.ceil_max_delegation_depth }),
        },
      });
    });
    if (role === null) throw new HttpError(404, "Workspace not found");
    return { agents, profiles, policies, viewerRole: role };
  });

  app.get("/api/workspaces/:workspaceId/audit", async (request) => {
    const { workspaceId } = paramsSchema.parse(request.params);
    const { cursor, limit } = auditQuerySchema.parse(request.query);
    await requireWorkspaceMember(identity, workspaceId, signedInUser(request).id);
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const { rows } = await pool.query(
      `SELECT id, actor_type, actor_id, event_type, run_id, created_at
         FROM audit_events
        WHERE workspace_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [workspaceId, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row) => workspaceAuditItemSchema.parse(fromRow(row)));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
  });
}

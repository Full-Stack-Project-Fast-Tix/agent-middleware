import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import {
  approvalListQuerySchema,
  auditListQuerySchema,
  createAgentProfileRequestSchema,
  createAgentRequestSchema,
  createSecurityPolicyRequestSchema,
  findingListQuerySchema,
  updateAgentProfileRequestSchema,
  updateAgentRequestSchema,
  updateSecurityPolicyRequestSchema,
} from "@launchpad/shared";
import { signedInUser } from "./auth-routes.js";
import {
  archiveAgent,
  archivePolicy,
  archiveProfile,
  createAgent,
  createPolicy,
  createProfile,
  listAudit,
  listFindings,
  listPolicies,
  listProfiles,
  listWorkspaceApprovals,
  updateAgent,
  updatePolicy,
  updateProfile,
} from "./db/workspace-config.js";
import { PostgresSecuritySource } from "./db/postgres-security-source.js";
import { resolveAgentPolicy } from "./security-policy-resolver.js";

// Evidence and configuration, as specified in packages/shared/src/api.ts.
// Authentication is the session hook. Authorisation is in db/workspace-config.ts,
// because the role has to be read inside the transaction that makes the change.

const BENCHMARK_RESULTS = fileURLToPath(new URL("../../../benchmark-results", import.meta.url));

const workspaceParams = z.object({ workspaceId: z.guid() });
const agentParams = workspaceParams.extend({ agentId: z.guid() });
const profileParams = workspaceParams.extend({ profileId: z.guid() });
const policyParams = workspaceParams.extend({ policyId: z.guid() });

export function registerWorkspaceConfigRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const source = new PostgresSecuritySource(pool);

  // Only each result's report: its raw traces can hold sensitive material.
  app.get("/api/benchmarks", async () => {
    const entries = await readdir(BENCHMARK_RESULTS, { withFileTypes: true }).catch(() => []);
    const results = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async ({ name }) => ({ name, report: await readFile(path.join(BENCHMARK_RESULTS, name, "report.md"), "utf8").catch(() => null) })),
    );
    return {
      results: results
        .filter((result): result is { name: string; report: string } => result.report !== null)
        .sort((a, b) => b.name.localeCompare(a.name)),
    };
  });

  app.get("/api/workspaces/:workspaceId/findings", async (request) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    return listFindings(pool, workspaceId, signedInUser(request).id, findingListQuerySchema.parse(request.query));
  });

  app.get("/api/workspaces/:workspaceId/approvals", async (request) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    return listWorkspaceApprovals(pool, workspaceId, signedInUser(request).id, approvalListQuerySchema.parse(request.query));
  });

  app.get("/api/workspaces/:workspaceId/audit", async (request) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    return listAudit(pool, workspaceId, signedInUser(request).id, auditListQuerySchema.parse(request.query));
  });

  app.get("/api/workspaces/:workspaceId/effective-permissions", async (request) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    const userId = signedInUser(request).id;
    // Reading the profiles is what checks the caller's role here.
    await listProfiles(pool, workspaceId, userId);
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM agents WHERE workspace_id = $1 ORDER BY created_at, id", [workspaceId]);
    return {
      agents: await Promise.all(
        rows.map(async ({ id }) => {
          // A disabled or archived agent has no effective permissions: the resolver refuses it.
          const resolved = await resolveAgentPolicy(source, workspaceId, id).catch(() => null);
          return {
            agentId: id,
            policy: resolved === null
              ? null
              : { capabilities: resolved.capabilities, appliedPolicies: resolved.appliedPolicies, approvalActions: resolved.approvalActions },
          };
        }),
      ),
    };
  });

  app.post("/api/workspaces/:workspaceId/agents", async (request, reply) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    const body = createAgentRequestSchema.parse(request.body);
    return reply.code(201).send({ agent: await createAgent(pool, { workspaceId, actorUserId: signedInUser(request).id, body }) });
  });

  app.patch("/api/workspaces/:workspaceId/agents/:agentId", async (request) => {
    const { workspaceId, agentId } = agentParams.parse(request.params);
    const body = updateAgentRequestSchema.parse(request.body);
    return { agent: await updateAgent(pool, { workspaceId, agentId, actorUserId: signedInUser(request).id, body }) };
  });

  app.delete("/api/workspaces/:workspaceId/agents/:agentId", async (request, reply) => {
    const { workspaceId, agentId } = agentParams.parse(request.params);
    await archiveAgent(pool, { workspaceId, agentId, actorUserId: signedInUser(request).id });
    return reply.code(204).send();
  });

  app.get("/api/workspaces/:workspaceId/profiles", async (request) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    return { profiles: await listProfiles(pool, workspaceId, signedInUser(request).id) };
  });

  app.post("/api/workspaces/:workspaceId/profiles", async (request, reply) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    const body = createAgentProfileRequestSchema.parse(request.body);
    return reply.code(201).send({ profile: await createProfile(pool, { workspaceId, actorUserId: signedInUser(request).id, body }) });
  });

  app.patch("/api/workspaces/:workspaceId/profiles/:profileId", async (request) => {
    const { workspaceId, profileId } = profileParams.parse(request.params);
    const body = updateAgentProfileRequestSchema.parse(request.body);
    return { profile: await updateProfile(pool, { workspaceId, profileId, actorUserId: signedInUser(request).id, body }) };
  });

  app.delete("/api/workspaces/:workspaceId/profiles/:profileId", async (request, reply) => {
    const { workspaceId, profileId } = profileParams.parse(request.params);
    await archiveProfile(pool, { workspaceId, profileId, actorUserId: signedInUser(request).id });
    return reply.code(204).send();
  });

  app.get("/api/workspaces/:workspaceId/policies", async (request) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    return { policies: await listPolicies(pool, workspaceId, signedInUser(request).id) };
  });

  app.post("/api/workspaces/:workspaceId/policies", async (request, reply) => {
    const { workspaceId } = workspaceParams.parse(request.params);
    const body = createSecurityPolicyRequestSchema.parse(request.body);
    return reply.code(201).send({ policy: await createPolicy(pool, { workspaceId, actorUserId: signedInUser(request).id, body }) });
  });

  app.patch("/api/workspaces/:workspaceId/policies/:policyId", async (request) => {
    const { workspaceId, policyId } = policyParams.parse(request.params);
    const body = updateSecurityPolicyRequestSchema.parse(request.body);
    return { policy: await updatePolicy(pool, { workspaceId, policyId, actorUserId: signedInUser(request).id, body }) };
  });

  app.delete("/api/workspaces/:workspaceId/policies/:policyId", async (request, reply) => {
    const { workspaceId, policyId } = policyParams.parse(request.params);
    await archivePolicy(pool, { workspaceId, policyId, actorUserId: signedInUser(request).id });
    return reply.code(204).send();
  });
}


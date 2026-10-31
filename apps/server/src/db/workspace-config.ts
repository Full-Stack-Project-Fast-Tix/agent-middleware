import { randomUUID } from "node:crypto";
import {
  agentProfileSchema,
  agentSchema,
  approvalQueueItemSchema,
  auditEventSchema,
  securityFindingSchema,
  securityPolicySchema,
  type Agent,
  type AgentProfile,
  type ApprovalListQuery,
  type ApprovalPage,
  type AuditEventType,
  type AuditListQuery,
  type AuditPage,
  type CreateAgentProfileRequest,
  type CreateAgentRequest,
  type CreateSecurityPolicyRequest,
  type FindingListQuery,
  type FindingPage,
  type SecurityPolicy,
  type UpdateAgentProfileRequest,
  type UpdateAgentRequest,
  type UpdateSecurityPolicyRequest,
  type WorkspaceRole,
} from "@launchpad/shared";
import type pg from "pg";
import { HttpError } from "../errors.js";
import { decodeRunCursor, encodeRunCursor } from "../run-list.js";
import { fromRow, insertRow, updateRow } from "./rows.js";

// A workspace's agents, profiles and policies, and the evidence across its runs.
// The role is read inside the transaction that makes a change, as in admin.ts, so
// someone demoted a moment ago cannot act on the old role. Each change writes its
// audit row in that same transaction.

const DEFAULT_PAGE = 50;

async function roleIn(db: Pick<pg.Pool, "query">, workspaceId: string, userId: string): Promise<WorkspaceRole> {
  const { rows } = await db.query<{ role: WorkspaceRole }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  if (rows[0] === undefined) throw new HttpError(404, "Workspace not found");
  return rows[0].role;
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** One page, newest first. `where` may use $1 for the workspace; the cursor and limit are added here. */
async function page<T extends { id: string }>(
  pool: pg.Pool,
  options: {
    from: string;
    select: string;
    at: string;
    id: string;
    where: string[];
    params: unknown[];
    query: { cursor?: string | undefined; limit?: number | undefined };
    parse: (row: Record<string, unknown>) => T;
    createdAt: (item: T) => string;
  },
): Promise<{ items: T[]; nextCursor: string | null }> {
  const params = [...options.params];
  const where = [...options.where];
  if (options.query.cursor !== undefined) {
    const cursor = decodeRunCursor(options.query.cursor);
    params.push(cursor.createdAt, cursor.id);
    where.push(`(${options.at}, ${options.id}) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  const limit = options.query.limit ?? DEFAULT_PAGE;
  params.push(limit + 1);
  const { rows } = await pool.query(
    `SELECT ${options.select} FROM ${options.from} WHERE ${where.join(" AND ")}
      ORDER BY ${options.at} DESC, ${options.id} DESC LIMIT $${params.length}`,
    params,
  );
  const items = rows.slice(0, limit).map((row) => options.parse(fromRow(row)));
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeRunCursor({ createdAt: options.createdAt(last), id: last.id }) : null,
  };
}

export async function listFindings(pool: pg.Pool, workspaceId: string, userId: string, query: FindingListQuery): Promise<FindingPage> {
  await roleIn(pool, workspaceId, userId);
  const params: unknown[] = [workspaceId];
  const where = ["r.workspace_id = $1"];
  if (query.severity !== undefined) {
    params.push(query.severity);
    where.push(`f.severity = $${params.length}`);
  }
  return page(pool, {
    from: "security_findings f JOIN runs r ON r.id = f.run_id",
    select: "f.*",
    at: "f.created_at",
    id: "f.id",
    where,
    params,
    query,
    parse: (row) => securityFindingSchema.parse(row),
    createdAt: (item) => item.createdAt,
  });
}

export async function listWorkspaceApprovals(pool: pg.Pool, workspaceId: string, userId: string, query: ApprovalListQuery): Promise<ApprovalPage> {
  await roleIn(pool, workspaceId, userId);
  const params: unknown[] = [workspaceId];
  const where = ["r.workspace_id = $1"];
  if (query.status !== undefined) {
    params.push(query.status);
    where.push(`a.status = $${params.length}`);
  }
  return page(pool, {
    from: "approvals a JOIN runs r ON r.id = a.run_id LEFT JOIN tasks t ON t.id = a.task_id",
    select: "a.*, r.created_by_user_id AS run_created_by_user_id, t.title AS task_title",
    at: "a.requested_at",
    id: "a.id",
    where,
    params,
    query,
    parse: (row) => approvalQueueItemSchema.parse(row),
    createdAt: (item) => item.requestedAt,
  });
}

export async function listAudit(pool: pg.Pool, workspaceId: string, userId: string, query: AuditListQuery): Promise<AuditPage> {
  await roleIn(pool, workspaceId, userId);
  const params: unknown[] = [workspaceId];
  const where = ["workspace_id = $1"];
  if (query.eventType !== undefined) {
    params.push(query.eventType);
    where.push(`event_type = $${params.length}`);
  }
  return page(pool, {
    from: "audit_events",
    select: "*",
    at: "created_at",
    id: "id",
    where,
    params,
    query,
    parse: (row) => auditEventSchema.parse(row),
    createdAt: (item) => item.createdAt,
  });
}

function policyOf(raw: Record<string, unknown>): SecurityPolicy {
  const ceiling = (column: string) => (raw[column] === null ? undefined : raw[column]);
  const capabilityCeiling = Object.fromEntries(
    Object.entries({
      write: ceiling("ceil_write"),
      shell: ceiling("ceil_shell"),
      network: ceiling("ceil_network"),
      delegate: ceiling("ceil_delegate"),
      maxDelegationDepth: ceiling("ceil_max_delegation_depth"),
    }).filter(([, value]) => value !== undefined),
  );
  return securityPolicySchema.parse({ ...fromRow(raw), capabilityCeiling });
}

export async function listProfiles(pool: pg.Pool, workspaceId: string, userId: string): Promise<AgentProfile[]> {
  await roleIn(pool, workspaceId, userId);
  const { rows } = await pool.query("SELECT * FROM agent_profiles WHERE workspace_id = $1 ORDER BY created_at, id", [workspaceId]);
  return rows.map((row) => agentProfileSchema.parse(fromRow(row)));
}

/** Platform policies come first: they bind this workspace though it cannot change them. */
export async function listPolicies(pool: pg.Pool, workspaceId: string, userId: string): Promise<SecurityPolicy[]> {
  await roleIn(pool, workspaceId, userId);
  const { rows } = await pool.query(
    `SELECT * FROM security_policies WHERE scope = 'platform' OR workspace_id = $1
      ORDER BY CASE scope WHEN 'platform' THEN 0 ELSE 1 END, created_at, id`,
    [workspaceId],
  );
  return rows.map(policyOf);
}

// -----------------------------------------------------------------------------
// Changes
// -----------------------------------------------------------------------------

async function change<T>(
  pool: pg.Pool,
  input: { workspaceId: string; actorUserId: string },
  mayChange: (role: WorkspaceRole) => void,
  work: (db: pg.PoolClient, audit: (eventType: AuditEventType, metadata: object) => Promise<void>) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Changes to a workspace wait for each other, and the role is read after the wait.
    await db.query("SELECT 1 FROM workspaces WHERE id = $1 FOR NO KEY UPDATE", [input.workspaceId]);
    mayChange(await roleIn(db, input.workspaceId, input.actorUserId));
    const result = await work(db, async (eventType, metadata) => {
      await insertRow(
        db,
        "audit_events",
        auditEventSchema.parse({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          actorType: "user",
          actorId: input.actorUserId,
          eventType,
          runId: null,
          taskId: null,
          executionId: null,
          metadata,
          createdAt: new Date().toISOString(),
        }),
      );
    });
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

function adminOnly(what: string): (role: WorkspaceRole) => void {
  return (role) => {
    if (role !== "security_admin") throw new HttpError(403, `Only a Security Admin can change ${what}`);
  };
}

function actingOnly(role: WorkspaceRole): void {
  if (role === "auditor") throw new HttpError(403, "The auditor role can only read");
}

function checkVersion(current: { version: number }, expected: number): void {
  if (current.version !== expected) throw new HttpError(409, "Someone else changed this first. Reload it and try again.");
}

const now = () => new Date().toISOString();

async function lockedRow(db: pg.PoolClient, table: string, workspaceId: string, id: string, what: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [id, workspaceId]);
  if (rows[0] === undefined) throw new HttpError(404, `${what} not found`);
  return rows[0] as Record<string, unknown>;
}

async function requireActiveProfile(db: pg.PoolClient, workspaceId: string, profileId: string): Promise<AgentProfile> {
  const { rows } = await db.query("SELECT * FROM agent_profiles WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL", [profileId, workspaceId]);
  if (rows[0] === undefined) throw new HttpError(400, "That profile is not available in this workspace");
  return agentProfileSchema.parse(fromRow(rows[0]));
}

/**
 * `auto` runs pick the workspace's one enabled agent that may delegate
 * (PostgresAgentDirectory), so a second one would stop them all.
 */
async function keepOneSupervisor(db: pg.PoolClient, workspaceId: string, exceptAgentId: string | null): Promise<void> {
  const { rows } = await db.query<{ others: number }>(
    `SELECT count(*)::int AS others FROM agents a JOIN agent_profiles p ON p.id = a.profile_id
      WHERE a.workspace_id = $1 AND a.enabled AND a.archived_at IS NULL AND p.cap_delegate AND a.id IS DISTINCT FROM $2`,
    [workspaceId, exceptAgentId],
  );
  if (rows[0]!.others > 0) {
    throw new HttpError(409, "This workspace already has an agent that delegates, and automatic runs need exactly one.");
  }
}

type Actor = { workspaceId: string; actorUserId: string };

export async function createAgent(pool: pg.Pool, input: Actor & { body: CreateAgentRequest }): Promise<Agent> {
  return change(pool, input, actingOnly, async (db, audit) => {
    const profile = await requireActiveProfile(db, input.workspaceId, input.body.profileId);
    if (profile.capabilities.delegate) await keepOneSupervisor(db, input.workspaceId, null);
    const stamp = now();
    const row = await insertRow(db, "agents", {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.body.name,
      description: input.body.description ?? null,
      instructions: input.body.instructions ?? "",
      profileId: input.body.profileId,
      enabled: true,
      createdByUserId: input.actorUserId,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    });
    const agent = agentSchema.parse(fromRow(row));
    await audit("agent.created", { agentId: agent.id, profileId: agent.profileId });
    return agent;
  });
}

export async function updateAgent(pool: pg.Pool, input: Actor & { agentId: string; body: UpdateAgentRequest }): Promise<Agent> {
  let role: WorkspaceRole = "auditor";
  return change(pool, input, (actual) => {
    actingOnly(actual);
    role = actual;
  }, async (db, audit) => {
    const before = agentSchema.parse(fromRow(await lockedRow(db, "agents", input.workspaceId, input.agentId, "Agent")));
    if (before.archivedAt !== null) throw new HttpError(409, "This agent is archived");
    checkVersion(before, input.body.expectedVersion);
    const { expectedVersion: _expected, ...fields } = input.body;
    const changing = fields.profileId !== undefined && fields.profileId !== before.profileId;
    if (changing && role !== "security_admin") throw new HttpError(403, "Only a Security Admin can give an agent another profile");
    const profile = await requireActiveProfile(db, input.workspaceId, fields.profileId ?? before.profileId);
    if (profile.capabilities.delegate && (fields.enabled ?? before.enabled)) await keepOneSupervisor(db, input.workspaceId, before.id);
    const after = agentSchema.parse(fromRow(await updateRow(db, "agents", before.id, { ...fields, version: before.version + 1, updatedAt: now() })));
    await audit("agent.updated", {
      agentId: before.id,
      version: after.version,
      // Instructions can be long and hold anything, so only that they changed.
      changed: Object.keys(fields).filter((key) => fields[key as keyof typeof fields] !== before[key as keyof Agent]),
      ...(changing ? { profileFrom: before.profileId, profileTo: after.profileId } : {}),
    });
    return after;
  });
}

export async function archiveAgent(pool: pg.Pool, input: Actor & { agentId: string }): Promise<void> {
  await change(pool, input, actingOnly, async (db, audit) => {
    const before = agentSchema.parse(fromRow(await lockedRow(db, "agents", input.workspaceId, input.agentId, "Agent")));
    if (before.archivedAt !== null) return;
    const stamp = now();
    await updateRow(db, "agents", before.id, { archivedAt: stamp, enabled: false, version: before.version + 1, updatedAt: stamp });
    await audit("agent.archived", { agentId: before.id });
  });
}

export async function createProfile(pool: pg.Pool, input: Actor & { body: CreateAgentProfileRequest }): Promise<AgentProfile> {
  return change(pool, input, adminOnly("profiles"), async (db, audit) => {
    const stamp = now();
    const row = await insertRow(db, "agent_profiles", {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.body.name,
      description: input.body.description ?? null,
      capabilities: input.body.capabilities,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    });
    const profile = agentProfileSchema.parse(fromRow(row));
    await audit("profile.created", { profileId: profile.id, capabilities: profile.capabilities });
    return profile;
  });
}

export async function updateProfile(pool: pg.Pool, input: Actor & { profileId: string; body: UpdateAgentProfileRequest }): Promise<AgentProfile> {
  return change(pool, input, adminOnly("profiles"), async (db, audit) => {
    const before = agentProfileSchema.parse(fromRow(await lockedRow(db, "agent_profiles", input.workspaceId, input.profileId, "Profile")));
    if (before.archivedAt !== null) throw new HttpError(409, "This profile is archived");
    checkVersion(before, input.body.expectedVersion);
    const { expectedVersion: _expected, ...fields } = input.body;
    if (fields.capabilities?.delegate && !before.capabilities.delegate) {
      // Every enabled agent on this profile would start delegating at once.
      const { rows } = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM agents WHERE profile_id = $1 AND enabled AND archived_at IS NULL",
        [before.id],
      );
      if (rows[0]!.count > 0) await keepOneSupervisor(db, input.workspaceId, null);
    }
    const after = agentProfileSchema.parse(fromRow(await updateRow(db, "agent_profiles", before.id, { ...fields, version: before.version + 1, updatedAt: now() })));
    await audit("profile.updated", {
      profileId: before.id,
      version: after.version,
      capabilitiesBefore: before.capabilities,
      capabilitiesAfter: after.capabilities,
    });
    return after;
  });
}

export async function archiveProfile(pool: pg.Pool, input: Actor & { profileId: string }): Promise<void> {
  await change(pool, input, adminOnly("profiles"), async (db, audit) => {
    const before = agentProfileSchema.parse(fromRow(await lockedRow(db, "agent_profiles", input.workspaceId, input.profileId, "Profile")));
    if (before.archivedAt !== null) return;
    const { rows } = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM agents WHERE profile_id = $1 AND archived_at IS NULL", [before.id]);
    if (rows[0]!.count > 0) throw new HttpError(409, "Agents still use this profile. Move or archive them first.");
    const stamp = now();
    await updateRow(db, "agent_profiles", before.id, { archivedAt: stamp, version: before.version + 1, updatedAt: stamp });
    await audit("profile.archived", { profileId: before.id });
  });
}

/** A key missing from the ceiling writes NULL: it stops restricting that capability. */
function ceilingColumns(ceiling: SecurityPolicy["capabilityCeiling"]) {
  return {
    ceilWrite: ceiling.write ?? null,
    ceilShell: ceiling.shell ?? null,
    ceilNetwork: ceiling.network ?? null,
    ceilDelegate: ceiling.delegate ?? null,
    ceilMaxDelegationDepth: ceiling.maxDelegationDepth ?? null,
  };
}

async function editablePolicy(db: pg.PoolClient, workspaceId: string, policyId: string): Promise<SecurityPolicy> {
  const { rows } = await db.query("SELECT * FROM security_policies WHERE id = $1 FOR UPDATE", [policyId]);
  const raw = rows[0] as Record<string, unknown> | undefined;
  if (raw === undefined || (raw.workspace_id !== null && raw.workspace_id !== workspaceId)) throw new HttpError(404, "Policy not found");
  const policy = policyOf(raw);
  if (policy.scope === "platform" || policy.locked) throw new HttpError(403, "This policy is locked and cannot be changed here");
  return policy;
}

export async function createPolicy(
  pool: pg.Pool,
  input: Actor & { body: { name: string; capabilityCeiling: SecurityPolicy["capabilityCeiling"]; rules: SecurityPolicy["rules"] } },
): Promise<SecurityPolicy> {
  return change(pool, input, adminOnly("policies"), async (db, audit) => {
    const stamp = now();
    const row = await insertRow(db, "security_policies", {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.body.name,
      scope: "workspace",
      ...ceilingColumns(input.body.capabilityCeiling),
      rules: input.body.rules,
      rulesSchemaVersion: 1,
      locked: false,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    }).catch((error: { code?: string }) => {
      throw error.code === "23505" ? new HttpError(409, "This workspace already has a policy with that name") : error;
    });
    const policy = policyOf(row as Record<string, unknown>);
    await audit("policy.created", { policyId: policy.id, capabilityCeiling: policy.capabilityCeiling, rules: policy.rules });
    return policy;
  });
}

export async function updatePolicy(pool: pg.Pool, input: Actor & { policyId: string; body: UpdateSecurityPolicyRequest }): Promise<SecurityPolicy> {
  return change(pool, input, adminOnly("policies"), async (db, audit) => {
    const before = await editablePolicy(db, input.workspaceId, input.policyId);
    if (before.archivedAt !== null) throw new HttpError(409, "This policy is archived");
    checkVersion(before, input.body.expectedVersion);
    const { expectedVersion: _expected, capabilityCeiling, ...fields } = input.body;
    const row = await updateRow(db, "security_policies", before.id, {
      ...fields,
      ...(capabilityCeiling === undefined ? {} : ceilingColumns(capabilityCeiling)),
      version: before.version + 1,
      updatedAt: now(),
    });
    const after = policyOf(row as Record<string, unknown>);
    await audit("policy.updated", {
      policyId: before.id,
      version: after.version,
      before: { capabilityCeiling: before.capabilityCeiling, rules: before.rules },
      after: { capabilityCeiling: after.capabilityCeiling, rules: after.rules },
    });
    return after;
  });
}

export async function archivePolicy(pool: pg.Pool, input: Actor & { policyId: string }): Promise<void> {
  await change(pool, input, adminOnly("policies"), async (db, audit) => {
    const before = await editablePolicy(db, input.workspaceId, input.policyId);
    if (before.archivedAt !== null) return;
    const stamp = now();
    await updateRow(db, "security_policies", before.id, { archivedAt: stamp, version: before.version + 1, updatedAt: stamp });
    await audit("policy.archived", { policyId: before.id });
  });
}

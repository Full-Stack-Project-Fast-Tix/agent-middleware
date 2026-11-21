import { randomUUID } from "node:crypto";
import {
  auditEventSchema,
  workspaceMemberSummarySchema,
  type AgentCapabilities,
  type AuditEventType,
  type WorkspaceMemberSummary,
  type WorkspaceRole,
} from "@launchpad/shared";
import type pg from "pg";
import { HttpError } from "../errors.js";
import { allowedSourcePath } from "../workspace-source.js";
import { hashPassword } from "./postgres-identity.js";
import { fromRow, insertRow } from "./rows.js";

// Setting up users and workspaces. db/admin-cli.ts is the command line for
// these, attributed in the audit log as `system`. member-routes.ts serves the
// member functions below to signed-in security admins, attributed to them.

/** The agents every new workspace starts with: one supervisor and three specialists. */
export const STANDARD_AGENTS = {
  supervisor: {
    description: "Plans the work and delegates it. Cannot edit files.",
    capabilities: { write: false, shell: false, network: false, delegate: true, maxDelegationDepth: 1 },
  },
  analyst: {
    description: "Reads the code and reports findings. Read-only.",
    capabilities: { write: false, shell: true, network: false, delegate: false, maxDelegationDepth: 0 },
  },
  developer: {
    description: "Implements changes and runs the tests. Risky commands need approval.",
    capabilities: { write: true, shell: true, network: false, delegate: false, maxDelegationDepth: 0 },
  },
  reviewer: {
    // P1 counts any command outside the known read-only set (npm test included) as a write.
    description: "Reads and reviews the change. Read-only: cannot run tests or build commands.",
    capabilities: { write: false, shell: true, network: false, delegate: false, maxDelegationDepth: 0 },
  },
} satisfies Record<string, { description: string; capabilities: AgentCapabilities }>;

const PLATFORM_BASELINE = "Platform baseline";

const stamps = () => {
  const now = new Date().toISOString();
  return { createdAt: now, updatedAt: now };
};

async function userIdByEmail(db: Pick<pg.Pool, "query">, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
  if (rows[0] === undefined) throw new Error(`No user with email ${email}`);
  return rows[0].id;
}

async function inTransaction<T>(pool: pg.Pool, work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

/** Who an audit event names: a signed-in user, or the operator at the command line. */
type Actor = { actorType: "user"; actorId: string } | { actorType: "system"; actorId: null };
const OPERATOR: Actor = { actorType: "system", actorId: null };

/** Written in the same transaction as the change. Ids only: audit rows are never deleted, so no emails. */
async function audit(
  db: pg.PoolClient,
  actor: Actor,
  eventType: AuditEventType,
  workspaceId: string | null,
  metadata: Record<string, string>,
): Promise<void> {
  await insertRow(
    db,
    "audit_events",
    auditEventSchema.parse({
      id: randomUUID(),
      workspaceId,
      ...actor,
      eventType,
      runId: null,
      taskId: null,
      executionId: null,
      metadata,
      createdAt: new Date().toISOString(),
    }),
  );
}

/** A user who signs in with this email and password. Returns the user's id. */
export async function addUser(pool: pg.Pool, input: { email: string; name: string; password: string }): Promise<string> {
  if (input.password.length < 12) throw new Error("Use a password of at least 12 characters");
  const email = input.email.trim().toLowerCase();
  const id = randomUUID();
  const passwordHash = await hashPassword(input.password);
  await inTransaction(pool, async (db) => {
    await insertRow(db, "users", { id, email, name: input.name, authSubject: `local:${email}`, passwordHash, ...stamps() });
    await audit(db, OPERATOR, "user.created", null, { userId: id });
  });
  return id;
}

/** Creates a workspace account and membership in one, audited admin transaction. */
export async function createMemberAccount(
  pool: pg.Pool,
  input: { workspaceId: string; actorUserId: string; email: string; name: string; password: string; role: WorkspaceRole },
): Promise<WorkspaceMemberSummary> {
  if (input.password.length < 12) throw new HttpError(400, "Use a password of at least 12 characters");
  const email = input.email.trim().toLowerCase();
  const currentRole = await roleOf(pool, input.workspaceId, input.actorUserId);
  if (currentRole === null) throw new HttpError(404, "Workspace not found");
  if (currentRole !== "security_admin") throw new HttpError(403, `The ${currentRole} role cannot change members`);
  const passwordHash = await hashPassword(input.password);
  try {
    return await changeMembers(pool, input.workspaceId, input.actorUserId, async (db, actor) => {
      const existing = await db.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [email]);
      if (existing.rowCount) throw new HttpError(409, "An account with that email already exists. Add the existing account instead.");
      const userId = randomUUID();
      const stamp = stamps();
      await insertRow(db, "users", {
        id: userId,
        email,
        name: input.name.trim(),
        authSubject: `local:${email}`,
        passwordHash,
        ...stamp,
      });
      await audit(db, actor, "user.created", input.workspaceId, { userId });
      await insertRow(db, "workspace_members", {
        workspaceId: input.workspaceId,
        userId,
        role: input.role,
        joinedAt: new Date().toISOString(),
      });
      await audit(db, actor, "member.added", input.workspaceId, { userId, role: input.role });
      return (await selectMember(db, input.workspaceId, userId))!;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new HttpError(409, "An account with that email already exists. Add the existing account instead.");
    }
    throw error;
  }
}

/** Gives a user a role in a workspace, or changes the role they have. */
export async function setMember(pool: pg.Pool, input: { workspaceId: string; email: string; role: WorkspaceRole }): Promise<void> {
  await inTransaction(pool, async (db) => {
    const userId = await userIdByEmail(db, input.email);
    const before = await roleOf(db, input.workspaceId, userId);
    if (before === input.role) return;
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [input.workspaceId, userId, input.role, new Date().toISOString()],
    );
    if (before === null) await audit(db, OPERATOR, "member.added", input.workspaceId, { userId, role: input.role });
    else await audit(db, OPERATOR, "member.role_changed", input.workspaceId, { userId, from: before, to: input.role });
  });
}

const MEMBER_COLUMNS = "m.user_id, m.role, m.joined_at, u.email, u.name";

async function selectMember(db: Pick<pg.Pool, "query">, workspaceId: string, userId: string): Promise<WorkspaceMemberSummary | null> {
  const { rows } = await db.query(
    `SELECT ${MEMBER_COLUMNS} FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [workspaceId, userId],
  );
  return rows[0] === undefined ? null : workspaceMemberSummarySchema.parse(fromRow(rows[0]));
}

async function roleOf(db: Pick<pg.Pool, "query">, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const { rows } = await db.query<{ role: WorkspaceRole }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  return rows[0]?.role ?? null;
}

/**
 * One change to a workspace's members, by a signed-in user. Changes to a
 * workspace wait for each other, and the actor's role is read after the wait:
 * two admins demoting each other cannot leave the workspace with none, and an
 * admin demoted a moment ago cannot act on the old role.
 */
async function changeMembers<T>(
  pool: pg.Pool,
  workspaceId: string,
  actorUserId: string,
  change: (db: pg.PoolClient, actor: Actor) => Promise<T>,
): Promise<T> {
  return inTransaction(pool, async (db) => {
    // NO KEY: does not hold up Runs and other rows that only reference the workspace.
    await db.query("SELECT 1 FROM workspaces WHERE id = $1 FOR NO KEY UPDATE", [workspaceId]);
    const role = await roleOf(db, workspaceId, actorUserId);
    if (role === null) throw new HttpError(404, "Workspace not found");
    if (role !== "security_admin") throw new HttpError(403, `The ${role} role cannot change members`);
    return change(db, { actorType: "user", actorId: actorUserId });
  });
}

/** Refuses to take away the role of a workspace's only security_admin. */
async function keepOneAdmin(db: pg.PoolClient, workspaceId: string, userId: string): Promise<void> {
  const { rows } = await db.query<{ others: number }>(
    `SELECT count(*)::int AS others FROM workspace_members
      WHERE workspace_id = $1 AND role = 'security_admin' AND user_id <> $2`,
    [workspaceId, userId],
  );
  if (rows[0]!.others === 0) {
    throw new HttpError(409, "A workspace needs at least one security admin. Make someone else a security admin first.");
  }
}

/** The workspace's members and the viewer's own role. A non-member gets the same 404 as a missing workspace. */
export async function listMembers(
  pool: pg.Pool,
  workspaceId: string,
  viewerUserId: string,
): Promise<{ members: WorkspaceMemberSummary[]; viewerRole: WorkspaceRole }> {
  const viewerRole = await roleOf(pool, workspaceId, viewerUserId);
  if (viewerRole === null) throw new HttpError(404, "Workspace not found");
  const { rows } = await pool.query(
    `SELECT ${MEMBER_COLUMNS} FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 ORDER BY lower(u.name), u.id`,
    [workspaceId],
  );
  return { members: rows.map((row) => workspaceMemberSummarySchema.parse(fromRow(row))), viewerRole };
}

export async function addMember(
  pool: pg.Pool,
  input: { workspaceId: string; actorUserId: string; email: string; role: WorkspaceRole },
): Promise<WorkspaceMemberSummary> {
  return changeMembers(pool, input.workspaceId, input.actorUserId, async (db, actor) => {
    const { rows } = await db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [input.email]);
    const userId = rows[0]?.id;
    if (userId === undefined) {
      throw new HttpError(404, "No account uses that email. Create the account from this workspace's Members page first.");
    }
    if ((await roleOf(db, input.workspaceId, userId)) !== null) throw new HttpError(409, "That person is already a member");
    await insertRow(db, "workspace_members", {
      workspaceId: input.workspaceId,
      userId,
      role: input.role,
      joinedAt: new Date().toISOString(),
    });
    await audit(db, actor, "member.added", input.workspaceId, { userId, role: input.role });
    return (await selectMember(db, input.workspaceId, userId))!;
  });
}

export async function changeMemberRole(
  pool: pg.Pool,
  input: { workspaceId: string; actorUserId: string; userId: string; role: WorkspaceRole },
): Promise<WorkspaceMemberSummary> {
  return changeMembers(pool, input.workspaceId, input.actorUserId, async (db, actor) => {
    const before = await roleOf(db, input.workspaceId, input.userId);
    if (before === null) throw new HttpError(404, "Member not found");
    if (before !== input.role) {
      if (before === "security_admin") await keepOneAdmin(db, input.workspaceId, input.userId);
      await db.query("UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2", [
        input.workspaceId,
        input.userId,
        input.role,
      ]);
      await audit(db, actor, "member.role_changed", input.workspaceId, { userId: input.userId, from: before, to: input.role });
    }
    return (await selectMember(db, input.workspaceId, input.userId))!;
  });
}

/** Takes effect on the member's next request, and within 30 seconds on an open event stream. */
export async function removeMember(
  pool: pg.Pool,
  input: { workspaceId: string; actorUserId: string; userId: string },
): Promise<void> {
  await changeMembers(pool, input.workspaceId, input.actorUserId, async (db, actor) => {
    const before = await roleOf(db, input.workspaceId, input.userId);
    if (before === null) throw new HttpError(404, "Member not found");
    if (before === "security_admin") await keepOneAdmin(db, input.workspaceId, input.userId);
    await db.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [input.workspaceId, input.userId]);
    await audit(db, actor, "member.removed", input.workspaceId, { userId: input.userId, role: before });
  });
}

/**
 * A workspace whose Runs copy `sourcePath`, with the standard agents, and the
 * owner as its security_admin. Also creates the platform baseline policy the
 * middleware requires, the first time: no network, delegation one level deep.
 * Returns the workspace's id.
 */
export async function addWorkspace(
  pool: pg.Pool,
  input: { name: string; sourcePath: string | null; ownerEmail: string },
): Promise<string> {
  return inTransaction(pool, async (db) => {
    const ownerId = await userIdByEmail(db, input.ownerEmail);
    return (await createWorkspaceRows(db, { name: input.name, sourcePath: input.sourcePath, ownerId, actor: OPERATOR })).id;
  });
}

/**
 * A security admin may create a workspace, with a folder only inside the
 * operator's `sourceRoots`. The folder is checked after the role, so nobody
 * else learns which paths exist.
 */
export async function createWorkspaceForAdmin(
  pool: pg.Pool,
  input: { authorizationWorkspaceId: string; actorUserId: string; name: string; sourcePath?: string; sourceRoots?: readonly string[] },
): Promise<{ id: string; name: string }> {
  return changeMembers(pool, input.authorizationWorkspaceId, input.actorUserId, async (db, actor) => {
    const result = await createWorkspaceRows(db, {
      name: input.name.trim(),
      sourcePath: input.sourcePath === undefined ? null : await allowedSourcePath(input.sourcePath, input.sourceRoots ?? []),
      ownerId: input.actorUserId,
      actor,
    });
    return result;
  });
}

/** Attach a validated uploaded source only while a workspace has never had a Run. */
export async function attachWorkspaceSource(pool: pg.Pool, input: { workspaceId: string; actorUserId: string; sourcePath: string }): Promise<void> {
  await changeMembers(pool, input.workspaceId, input.actorUserId, async (db, actor) => {
    const { rows } = await db.query<{ source_path: string | null; runs: number }>(
      `SELECT w.source_path, (SELECT count(*)::int FROM runs r WHERE r.workspace_id = w.id) AS runs
       FROM workspaces w WHERE w.id = $1 FOR UPDATE`, [input.workspaceId]);
    if (!rows[0]) throw new HttpError(404, "Workspace not found");
    if (rows[0].source_path !== null || rows[0].runs > 0) throw new HttpError(409, "A project archive can only be added to a new empty workspace before its first Run");
    await db.query("UPDATE workspaces SET source_path = $2, updated_at = $3 WHERE id = $1", [input.workspaceId, input.sourcePath, new Date().toISOString()]);
    await audit(db, actor, "workspace.source_uploaded", input.workspaceId, { source: "browser ZIP upload" });
  });
}

/** Any member may see the folder their workspace's Runs copy. */
export async function workspaceSource(pool: pg.Pool, workspaceId: string, viewerUserId: string): Promise<string | null> {
  if ((await roleOf(pool, workspaceId, viewerUserId)) === null) throw new HttpError(404, "Workspace not found");
  const { rows } = await pool.query<{ source_path: string | null }>("SELECT source_path FROM workspaces WHERE id = $1", [workspaceId]);
  return rows[0]?.source_path ?? null;
}

/**
 * A security admin points an existing workspace at another allowed folder. Runs
 * already started keep their own copy; the next Run copies the new folder.
 */
export async function changeWorkspaceSource(
  pool: pg.Pool,
  input: { workspaceId: string; actorUserId: string; sourcePath: string; sourceRoots: readonly string[] },
): Promise<string> {
  return changeMembers(pool, input.workspaceId, input.actorUserId, async (db, actor) => {
    const next = await allowedSourcePath(input.sourcePath, input.sourceRoots);
    const { rows } = await db.query<{ source_path: string | null }>("SELECT source_path FROM workspaces WHERE id = $1", [input.workspaceId]);
    const before = rows[0]?.source_path ?? null;
    if (before === next) return next;
    await db.query("UPDATE workspaces SET source_path = $2, updated_at = $3 WHERE id = $1", [input.workspaceId, next, new Date().toISOString()]);
    await audit(db, actor, "workspace.source_changed", input.workspaceId, { from: before ?? "(none)", to: next });
    return next;
  });
}

async function createWorkspaceRows(
  db: pg.PoolClient,
  input: { name: string; sourcePath: string | null; ownerId: string; actor: Actor },
): Promise<{ id: string; name: string }> {
  const workspaceId = randomUUID();
  await db.query(
    `INSERT INTO security_policies (id, workspace_id, name, scope, ceil_network, ceil_max_delegation_depth, rules,
       rules_schema_version, locked, version, created_at, updated_at)
     VALUES ($1, NULL, $2, 'platform', false, 1, '{}', 1, true, 1, $3, $3)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), PLATFORM_BASELINE, new Date().toISOString()],
  );
  await insertRow(db, "workspaces", { id: workspaceId, name: input.name, sourcePath: input.sourcePath, createdByUserId: input.ownerId, ...stamps() });
  await insertRow(db, "workspace_members", { workspaceId, userId: input.ownerId, role: "security_admin", joinedAt: new Date().toISOString() });
  await audit(db, input.actor, "workspace.created", workspaceId, {
    ownerUserId: input.ownerId,
    ...(input.sourcePath === null ? {} : { sourcePath: input.sourcePath }),
  });
  await audit(db, input.actor, "member.added", workspaceId, { userId: input.ownerId, role: "security_admin" });
  for (const [role, { description, capabilities }] of Object.entries(STANDARD_AGENTS)) {
    const name = role[0]!.toUpperCase() + role.slice(1);
    const profileId = randomUUID();
    await insertRow(db, "agent_profiles", { id: profileId, workspaceId, name, description, capabilities, version: 1, ...stamps() });
    await insertRow(db, "agents", {
      id: randomUUID(), workspaceId, name, description, instructions: "", profileId,
      enabled: true, createdByUserId: input.ownerId, version: 1, ...stamps(),
    });
  }
  return { id: workspaceId, name: input.name };
}

/** A workspace for the role-aware demo, with one person in each role. Returns the workspace's id. */
export async function seedRoleDemo(pool: pg.Pool, input: { sourcePath: string; password: string }): Promise<string> {
  const email = (role: string) => `${role}@demo.agentguard.test`;
  await addUser(pool, { email: email("admin"), name: "Demo Security Admin", password: input.password });
  await addUser(pool, { email: email("developer"), name: "Demo Developer", password: input.password });
  await addUser(pool, { email: email("auditor"), name: "Demo Auditor", password: input.password });
  const workspaceId = await addWorkspace(pool, { name: "Demo workspace", sourcePath: input.sourcePath, ownerEmail: email("admin") });
  await setMember(pool, { workspaceId, email: email("developer"), role: "developer" });
  await setMember(pool, { workspaceId, email: email("auditor"), role: "auditor" });
  return workspaceId;
}

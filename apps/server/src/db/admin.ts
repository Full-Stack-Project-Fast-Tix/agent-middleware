import { randomUUID } from "node:crypto";
import type { AgentCapabilities, WorkspaceRole } from "@launchpad/shared";
import type pg from "pg";
import { hashPassword } from "./postgres-identity.js";
import { insertRow } from "./rows.js";

// Setting up users and workspaces until there is an admin UI. db/admin-cli.ts
// is the command line for these.

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
    description: "Implements changes. Edits need approval.",
    capabilities: { write: true, shell: true, network: false, delegate: false, maxDelegationDepth: 0 },
  },
  reviewer: {
    description: "Runs the tests and reviews the change. Read-only.",
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

/** A user who signs in with this email and password. Returns the user's id. */
export async function addUser(pool: pg.Pool, input: { email: string; name: string; password: string }): Promise<string> {
  if (input.password.length < 12) throw new Error("Use a password of at least 12 characters");
  const email = input.email.trim().toLowerCase();
  const id = randomUUID();
  await insertRow(pool, "users", {
    id,
    email,
    name: input.name,
    authSubject: `local:${email}`,
    passwordHash: await hashPassword(input.password),
    ...stamps(),
  });
  return id;
}

/** Gives a user a role in a workspace, or changes the role they have. */
export async function setMember(pool: pg.Pool, input: { workspaceId: string; email: string; role: WorkspaceRole }): Promise<void> {
  const userId = await userIdByEmail(pool, input.email);
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [input.workspaceId, userId, input.role, new Date().toISOString()],
  );
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
    const workspaceId = randomUUID();
    await db.query(
      `INSERT INTO security_policies (id, workspace_id, name, scope, ceil_network, ceil_max_delegation_depth, rules,
         rules_schema_version, locked, version, created_at, updated_at)
       VALUES ($1, NULL, $2, 'platform', false, 1, '{}', 1, true, 1, $3, $3)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), PLATFORM_BASELINE, new Date().toISOString()],
    );
    await insertRow(db, "workspaces", { id: workspaceId, name: input.name, sourcePath: input.sourcePath, createdByUserId: ownerId, ...stamps() });
    await insertRow(db, "workspace_members", { workspaceId, userId: ownerId, role: "security_admin", joinedAt: new Date().toISOString() });
    for (const [role, { description, capabilities }] of Object.entries(STANDARD_AGENTS)) {
      const name = role[0]!.toUpperCase() + role.slice(1);
      const profileId = randomUUID();
      await insertRow(db, "agent_profiles", { id: profileId, workspaceId, name, description, capabilities, version: 1, ...stamps() });
      await insertRow(db, "agents", {
        id: randomUUID(),
        workspaceId,
        name,
        description,
        instructions: "",
        profileId,
        enabled: true,
        createdByUserId: ownerId,
        version: 1,
        ...stamps(),
      });
    }
    return workspaceId;
  });
}

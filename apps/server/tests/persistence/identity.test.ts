import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUser, addWorkspace, setMember } from "../../src/db/admin.js";
import { openDatabase } from "../../src/db/pool.js";
import { PostgresAgentDirectory } from "../../src/db/postgres-agent-directory.js";
import { hashPassword, PostgresIdentity, verifyPassword } from "../../src/db/postgres-identity.js";
import { PostgresSecuritySource } from "../../src/db/postgres-security-source.js";
import { resolveAgentPolicy } from "../../src/security-policy-resolver.js";

// Sign-in, sessions and workspace roles on Postgres, set up the way db:admin
// does it. Needs TEST_DATABASE_URL (see schema.test.ts).

const url = process.env.TEST_DATABASE_URL;
const schema = `test_${randomUUID().replaceAll("-", "")}`;
const PASSWORD = "correct horse battery";
let pool: pg.Pool | undefined;

beforeAll(async () => {
  if (!url) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = await openDatabase({ connectionString: url, options: `-c search_path=${schema}`, max: 5 });
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

describe("passwords", () => {
  it("verify only the password they were made from", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword("correct horse battery!", stored)).toBe(false);
    expect(await verifyPassword(PASSWORD, "scrypt$abc$short")).toBe(false);
    expect(await verifyPassword(PASSWORD, "plain")).toBe(false);
  });
});

describe.skipIf(!url)("PostgresIdentity", () => {
  it("signs in with the right password only, and stores just the token's hash", async () => {
    const userId = await addUser(pool!, { email: "Dev@Example.test", name: "Dev", password: PASSWORD });
    const identity = new PostgresIdentity(pool!);

    expect(await identity.signIn("dev@example.test", "wrong password")).toBeNull();
    expect(await identity.signIn("nobody@example.test", PASSWORD)).toBeNull();
    const session = (await identity.signIn("DEV@example.test", PASSWORD))!;
    expect(session.user).toMatchObject({ id: userId, email: "dev@example.test" });
    expect(session.user).not.toHaveProperty("passwordHash");

    const { rows } = await pool!.query<{ token_hash: string }>("SELECT token_hash FROM sessions WHERE user_id = $1", [userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toContain(session.token);

    expect((await identity.userForToken(session.token))?.id).toBe(userId);
    expect(await identity.userForToken("not-a-token")).toBeNull();
    await identity.signOut(session.token);
    expect(await identity.userForToken(session.token)).toBeNull();
  });

  it("refuses a session once it has expired", async () => {
    await addUser(pool!, { email: "late@example.test", name: "Late", password: PASSWORD });
    let now = new Date("2026-10-01T00:00:00.000Z");
    const identity = new PostgresIdentity(pool!, () => now);
    const session = (await identity.signIn("late@example.test", PASSWORD))!;
    expect(await identity.userForToken(session.token)).not.toBeNull();
    now = new Date(session.expiresAt);
    expect(await identity.userForToken(session.token)).toBeNull();
  });

  it("refuses short passwords", async () => {
    await expect(addUser(pool!, { email: "short@example.test", name: "Short", password: "too short" })).rejects.toThrow();
  });

  it("sets up a workspace whose agents resolve under the platform baseline, and lists it by role", async () => {
    const ownerId = await addUser(pool!, { email: "owner@example.test", name: "Owner", password: PASSWORD });
    const auditorId = await addUser(pool!, { email: "auditor@example.test", name: "Auditor", password: PASSWORD });
    const workspaceId = await addWorkspace(pool!, { name: "checkout-service", sourcePath: "/srv/checkout", ownerEmail: "owner@example.test" });
    await addWorkspace(pool!, { name: "second", sourcePath: null, ownerEmail: "owner@example.test" });
    await setMember(pool!, { workspaceId, email: "auditor@example.test", role: "developer" });
    await setMember(pool!, { workspaceId, email: "auditor@example.test", role: "auditor" });

    const identity = new PostgresIdentity(pool!);
    expect(await identity.workspaceRole(workspaceId, ownerId)).toBe("security_admin");
    expect(await identity.workspaceRole(workspaceId, auditorId)).toBe("auditor");
    expect(await identity.workspaceRole(randomUUID(), ownerId)).toBeNull();
    expect((await identity.listWorkspaces(ownerId)).map((workspace) => workspace.name)).toEqual(["checkout-service", "second"]);
    expect(await identity.listWorkspaces(auditorId)).toEqual([{ id: workspaceId, name: "checkout-service" }]);

    const directory = new PostgresAgentDirectory(pool!);
    const agents = new Map((await directory.listAgents(workspaceId)).map((agent) => [agent.name, agent.id]));
    expect([...agents.keys()].sort()).toEqual(["Analyst", "Developer", "Reviewer", "Supervisor"]);
    expect(await directory.defaultAgentId(workspaceId, "auto")).toBe(agents.get("Supervisor"));

    // One baseline, however many workspaces: the middleware needs at least one platform policy.
    const { rows } = await pool!.query("SELECT name FROM security_policies WHERE scope = 'platform'");
    expect(rows).toEqual([{ name: "Platform baseline" }]);
    const developer = await resolveAgentPolicy(new PostgresSecuritySource(pool!), workspaceId, agents.get("Developer")!);
    expect(developer.capabilities).toEqual({ write: true, shell: true, network: false, delegate: false, maxDelegationDepth: 0 });
  });
});

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceMemberResponseSchema, workspaceMembersResponseSchema } from "@launchpad/shared";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { addUser, addWorkspace, setMember } from "../../src/db/admin.js";
import { openDatabase } from "../../src/db/pool.js";
import { PostgresIdentity } from "../../src/db/postgres-identity.js";

// Workspace member routes with real sign-in, roles and audit rows. Needs
// TEST_DATABASE_URL (see schema.test.ts).

const url = process.env.TEST_DATABASE_URL;
const schema = `test_${randomUUID().replaceAll("-", "")}`;
const PASSWORD = "correct horse battery";
const config = loadConfig({ NODE_ENV: "test" });

let pool: pg.Pool | undefined;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  if (!url) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = await openDatabase({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
  app = await createApp(config, { identity: new PostgresIdentity(pool), memberDatabase: pool });
});

afterAll(async () => {
  await app?.close();
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

interface Person {
  id: string;
  email: string;
  headers: { authorization: string };
}

async function person(name: string): Promise<Person> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
  const id = await addUser(pool!, { email, name, password: PASSWORD });
  const signedIn = await app!.inject({ method: "POST", url: "/api/auth/session", payload: { email, password: PASSWORD } });
  expect(signedIn.statusCode).toBe(201);
  return { id, email, headers: { authorization: `Bearer ${signedIn.json().token as string}` } };
}

/** A workspace with one person in each role, plus someone from outside it. */
async function workspace() {
  const [admin, developer, auditor, outsider] = await Promise.all([person("Admin"), person("Dev"), person("Auditor"), person("Outsider")]);
  const id = await addWorkspace(pool!, { name: "Project", sourcePath: null, ownerEmail: admin!.email });
  await setMember(pool!, { workspaceId: id, email: developer!.email, role: "developer" });
  await setMember(pool!, { workspaceId: id, email: auditor!.email, role: "auditor" });
  return { id, admin: admin!, developer: developer!, auditor: auditor!, outsider: outsider! };
}

const membersUrl = (workspaceId: string) => `/api/workspaces/${workspaceId}/members`;
const memberUrl = (workspaceId: string, userId: string) => `${membersUrl(workspaceId)}/${userId}`;

const list = (workspaceId: string, who: Person) => app!.inject({ url: membersUrl(workspaceId), headers: who.headers });
const add = (workspaceId: string, who: Person, email: string, role = "developer") =>
  app!.inject({ method: "POST", url: membersUrl(workspaceId), headers: who.headers, payload: { email, role } });
const change = (workspaceId: string, who: Person, userId: string, role: string) =>
  app!.inject({ method: "PATCH", url: memberUrl(workspaceId, userId), headers: who.headers, payload: { role } });
const remove = (workspaceId: string, who: Person, userId: string) =>
  app!.inject({ method: "DELETE", url: memberUrl(workspaceId, userId), headers: who.headers });

async function auditFor(workspaceId: string) {
  const { rows } = await pool!.query<{ event_type: string; actor_type: string; actor_id: string | null; metadata: Record<string, string> }>(
    "SELECT event_type, actor_type, actor_id, metadata FROM audit_events WHERE workspace_id = $1 ORDER BY created_at, id",
    [workspaceId],
  );
  return rows;
}
async function roleIn(workspaceId: string, userId: string) {
  const { rows } = await pool!.query<{ role: string }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  return rows[0]?.role ?? null;
}

describe("member routes in token mode", () => {
  it("do not exist without signed-in users", async () => {
    const tokenApp = await createApp(config);
    const response = await tokenApp.inject({ url: membersUrl(randomUUID()) });
    expect(response.statusCode).toBe(404);
    await tokenApp.close();
  });
});

describe.skipIf(!url)("member routes", () => {
  it("need a session", async () => {
    const { id } = await workspace();
    expect((await app!.inject({ url: membersUrl(id) })).statusCode).toBe(401);
    expect((await app!.inject({ method: "POST", url: membersUrl(id), payload: { email: "a@example.test", role: "auditor" } })).statusCode).toBe(401);
  });

  it("let any member read the list, without credentials, and report the viewer's role", async () => {
    const team = await workspace();
    for (const [who, role] of [[team.admin, "security_admin"], [team.developer, "developer"], [team.auditor, "auditor"]] as const) {
      const response = await list(team.id, who);
      expect(response.statusCode).toBe(200);
      const body = workspaceMembersResponseSchema.parse(response.json());
      expect(body.viewerRole).toBe(role);
      expect(body.members.map((member) => member.userId).sort()).toEqual([team.admin.id, team.developer.id, team.auditor.id].sort());
      expect(response.body).not.toMatch(/password|scrypt|auth_subject|authSubject/i);
    }
  });

  it("answer a non-member as if the workspace did not exist", async () => {
    const team = await workspace();
    const denied = [
      await list(team.id, team.outsider),
      await add(team.id, team.outsider, team.outsider.email, "security_admin"),
      await change(team.id, team.outsider, team.developer.id, "auditor"),
      await remove(team.id, team.outsider, team.developer.id),
    ];
    const missing = await list(randomUUID(), team.outsider);
    for (const response of denied) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(missing.json());
    }
    expect(await roleIn(team.id, team.outsider.id)).toBeNull();
  });

  it("do not let an admin of one workspace change another", async () => {
    const [team, other] = [await workspace(), await workspace()];
    expect((await change(team.id, other.admin, team.developer.id, "auditor")).statusCode).toBe(404);
    expect(await roleIn(team.id, team.developer.id)).toBe("developer");
  });

  it("refuse changes from developers and auditors, and write nothing", async () => {
    const team = await workspace();
    const newcomer = await person("Newcomer");
    const before = await auditFor(team.id);
    for (const who of [team.developer, team.auditor]) {
      expect((await add(team.id, who, newcomer.email)).statusCode).toBe(403);
      expect((await change(team.id, who, who.id, "security_admin")).statusCode).toBe(403);
      expect((await remove(team.id, who, team.admin.id)).statusCode).toBe(403);
    }
    expect(await roleIn(team.id, newcomer.id)).toBeNull();
    expect(await roleIn(team.id, team.developer.id)).toBe("developer");
    expect(await roleIn(team.id, team.auditor.id)).toBe("auditor");
    expect(await roleIn(team.id, team.admin.id)).toBe("security_admin");
    expect(await auditFor(team.id)).toEqual(before);
  });

  it("let a security admin add, change and remove, each with an audit event naming the admin", async () => {
    const team = await workspace();
    const newcomer = await person("Newcomer");
    const auditBefore = (await auditFor(team.id)).length;

    const added = await add(team.id, team.admin, newcomer.email.toUpperCase(), "auditor");
    expect(added.statusCode).toBe(201);
    expect(workspaceMemberResponseSchema.parse(added.json()).member).toMatchObject({ userId: newcomer.id, role: "auditor", email: newcomer.email });

    const changed = await change(team.id, team.admin, newcomer.id, "developer");
    expect(changed.statusCode).toBe(200);
    expect(workspaceMemberResponseSchema.parse(changed.json()).member.role).toBe("developer");

    expect((await remove(team.id, team.admin, newcomer.id)).statusCode).toBe(204);
    expect(await roleIn(team.id, newcomer.id)).toBeNull();

    const events = (await auditFor(team.id)).slice(auditBefore);
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.event_type).sort()).toEqual(["member.added", "member.removed", "member.role_changed"]);
    for (const event of events) {
      expect(event).toMatchObject({ actor_type: "user", actor_id: team.admin.id });
      expect(event.metadata.userId).toBe(newcomer.id);
      expect(JSON.stringify(event.metadata)).not.toContain("@");
    }
    expect(events.find((event) => event.event_type === "member.role_changed")!.metadata).toMatchObject({ from: "auditor", to: "developer" });
  });

  it("do not audit a role change that changes nothing", async () => {
    const team = await workspace();
    const before = (await auditFor(team.id)).length;
    expect((await change(team.id, team.admin, team.developer.id, "developer")).statusCode).toBe(200);
    expect(await auditFor(team.id)).toHaveLength(before);
  });

  it("take effect on the removed member's next request", async () => {
    const team = await workspace();
    expect((await list(team.id, team.developer)).statusCode).toBe(200);
    expect((await remove(team.id, team.admin, team.developer.id)).statusCode).toBe(204);
    expect((await list(team.id, team.developer)).statusCode).toBe(404);
  });

  it("explain unknown accounts, existing members and missing members", async () => {
    const team = await workspace();
    expect((await add(team.id, team.admin, "nobody-here@example.test")).statusCode).toBe(404);
    expect((await add(team.id, team.admin, team.developer.email)).statusCode).toBe(409);
    expect((await change(team.id, team.admin, team.outsider.id, "auditor")).statusCode).toBe(404);
    expect((await remove(team.id, team.admin, team.outsider.id)).statusCode).toBe(404);
    expect(await roleIn(team.id, team.developer.id)).toBe("developer");
  });

  it("validate ids and roles", async () => {
    const team = await workspace();
    expect((await list("not-a-uuid", team.admin)).statusCode).toBe(400);
    expect((await add(team.id, team.admin, team.outsider.email, "owner")).statusCode).toBe(400);
    expect((await change(team.id, team.admin, team.developer.id, "platform_admin")).statusCode).toBe(400);
    expect((await change(team.id, team.admin, "not-a-uuid", "auditor")).statusCode).toBe(400);
  });

  it("keep at least one security admin", async () => {
    const team = await workspace();
    expect((await change(team.id, team.admin, team.admin.id, "developer")).statusCode).toBe(409);
    expect((await remove(team.id, team.admin, team.admin.id)).statusCode).toBe(409);
    expect(await roleIn(team.id, team.admin.id)).toBe("security_admin");

    // With a second admin in place, the first may step down.
    expect((await change(team.id, team.admin, team.developer.id, "security_admin")).statusCode).toBe(200);
    expect((await change(team.id, team.admin, team.admin.id, "developer")).statusCode).toBe(200);
    expect((await remove(team.id, team.developer, team.admin.id)).statusCode).toBe(204);
  });

  it("keep one security admin when two demote each other at the same moment", async () => {
    for (let round = 0; round < 5; round += 1) {
      const team = await workspace();
      await setMember(pool!, { workspaceId: team.id, email: team.developer.email, role: "security_admin" });

      const results = await Promise.all([
        change(team.id, team.admin, team.developer.id, "auditor"),
        change(team.id, team.developer, team.admin.id, "auditor"),
      ]);

      expect(results.map((response) => response.statusCode).sort()).toEqual([200, 403]);
      const { rows } = await pool!.query(
        "SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'security_admin'",
        [team.id],
      );
      expect(rows).toHaveLength(1);
    }
  });

  it("do not let a just-demoted admin act on the old role", async () => {
    const team = await workspace();
    await setMember(pool!, { workspaceId: team.id, email: team.developer.email, role: "security_admin" });
    expect((await change(team.id, team.admin, team.developer.id, "auditor")).statusCode).toBe(200);
    expect((await add(team.id, team.developer, team.outsider.email)).statusCode).toBe(403);
  });
});

describe.skipIf(!url)("a new workspace's folder", () => {
  it("must be inside an allowed root, symlinks resolved, and is checked only for security admins", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "agentguard-roots-")));
    await mkdir(path.join(base, "allowed", "project"), { recursive: true });
    await mkdir(path.join(base, "secret"));
    await symlink(path.join(base, "secret"), path.join(base, "allowed", "escape"));
    const rooted = await createApp(loadConfig({ NODE_ENV: "test", WORKSPACE_SOURCE_ROOTS: path.join(base, "allowed") }), {
      identity: new PostgresIdentity(pool!),
      memberDatabase: pool!,
    });
    try {
      const team = await workspace();
      const create = (target: FastifyInstance, who: Person, sourcePath: string) =>
        target.inject({
          method: "POST",
          url: "/api/workspaces",
          headers: who.headers,
          payload: { name: "Picked", authorizationWorkspaceId: team.id, sourcePath },
        });

      const created = await create(rooted, team.admin, path.join(base, "allowed", "project"));
      expect(created.statusCode).toBe(201);
      const id = created.json().workspace.id as string;
      const { rows } = await pool!.query<{ source_path: string }>("SELECT source_path FROM workspaces WHERE id = $1", [id]);
      expect(rows[0]!.source_path).toBe(path.join(base, "allowed", "project"));
      expect((await auditFor(id)).find((event) => event.event_type === "workspace.created")!.metadata.sourcePath).toBe(rows[0]!.source_path);

      expect((await create(rooted, team.admin, path.join(base, "secret"))).statusCode).toBe(400);
      expect((await create(rooted, team.admin, path.join(base, "allowed", "escape"))).statusCode).toBe(400);
      expect((await create(rooted, team.admin, path.join(base, "allowed", "missing"))).statusCode).toBe(400);
      expect((await create(rooted, team.admin, "allowed/project")).statusCode).toBe(400);
      // The role is checked first, so a developer cannot probe which folders exist.
      expect((await create(rooted, team.developer, path.join(base, "missing"))).statusCode).toBe(403);
      // With no roots configured, nobody may pick a folder.
      expect((await create(app!, team.admin, path.join(base, "allowed", "project"))).statusCode).toBe(400);
    } finally {
      await rooted.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!url)("the command line's audit events", () => {
  it("record new users, workspaces and memberships as the system actor, with no emails", async () => {
    const email = `cli-${randomUUID().slice(0, 8)}@example.test`;
    const userId = await addUser(pool!, { email, name: "Cli", password: PASSWORD });
    const workspaceId = await addWorkspace(pool!, { name: "Cli project", sourcePath: null, ownerEmail: email });
    const other = `cli-${randomUUID().slice(0, 8)}@example.test`;
    const otherId = await addUser(pool!, { email: other, name: "Other", password: PASSWORD });
    await setMember(pool!, { workspaceId, email: other, role: "developer" });
    await setMember(pool!, { workspaceId, email: other, role: "developer" });
    await setMember(pool!, { workspaceId, email: other, role: "auditor" });

    const { rows: created } = await pool!.query<{ actor_type: string; workspace_id: string | null }>(
      "SELECT actor_type, workspace_id FROM audit_events WHERE event_type = 'user.created' AND metadata ->> 'userId' = $1",
      [userId],
    );
    expect(created).toEqual([{ actor_type: "system", workspace_id: null }]);

    const events = await auditFor(workspaceId);
    expect(events.every((event) => event.actor_type === "system" && event.actor_id === null)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("@");
    expect(events.filter((event) => event.event_type === "workspace.created")).toHaveLength(1);
    expect(events.filter((event) => event.event_type === "member.added").map((event) => event.metadata.userId).sort()).toEqual([userId, otherId].sort());
    // The repeated role is not an event; the change is.
    expect(events.filter((event) => event.event_type === "member.role_changed").map((event) => event.metadata)).toEqual([
      { userId: otherId, from: "developer", to: "auditor" },
    ]);
  });
});

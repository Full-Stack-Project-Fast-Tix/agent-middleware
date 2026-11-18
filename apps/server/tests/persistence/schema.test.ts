import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACTION_TYPES,
  ACTOR_TYPES,
  APPROVAL_REASONS,
  APPROVAL_STATUSES,
  EXECUTION_STATUSES,
  FINDING_SEVERITIES,
  ORCHESTRATION_MODES,
  PLATFORM_ROLES,
  POLICY_SCOPES,
  RUN_STATUSES,
  SECURITY_LAYERS,
  TASK_STATUSES,
  WORKSPACE_ROLES,
} from "@launchpad/shared";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate.js";

// Needs a Postgres the tests may create schemas in, e.g.
// TEST_DATABASE_URL=postgres://launchpad:launchpad@127.0.0.1:5433/launchpad
const url = process.env.TEST_DATABASE_URL;
const schema = `test_${randomUUID().replaceAll("-", "")}`;
const now = "2026-10-08T10:00:00.000Z";

describe.skipIf(!url)("migration 001", () => {
  let db: pg.Client;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    db = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
    await db.connect();
    await migrate(db);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });

  const insert = async (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    await db.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`, Object.values(row));
    return row;
  };
  const stamps = { created_at: now, updated_at: now };

  const user = async () =>
    insert("users", { id: randomUUID(), email: `${randomUUID()}@example.test`, name: "Test", auth_subject: randomUUID(), ...stamps });
  const workspace = async (userId: unknown) =>
    insert("workspaces", { id: randomUUID(), name: "ws", created_by_user_id: userId, ...stamps });
  const profile = async (workspaceId: unknown) =>
    insert("agent_profiles", { id: randomUUID(), workspace_id: workspaceId, name: "p", version: 1, ...stamps });
  const agent = (workspaceId: unknown, profileId: unknown, userId: unknown) =>
    insert("agents", {
      id: randomUUID(), workspace_id: workspaceId, name: "a", instructions: "", profile_id: profileId,
      enabled: true, created_by_user_id: userId, version: 1, ...stamps,
    });
  const run = async (workspaceId: unknown, userId: unknown) =>
    insert("runs", {
      id: randomUUID(), workspace_id: workspaceId, created_by_user_id: userId, user_prompt: "do it",
      orchestration_mode: "single", status: "queued", ...stamps,
    });
  const task = async (runId: unknown) =>
    insert("tasks", { id: randomUUID(), run_id: runId, title: "t", objective: "o", status: "pending", ...stamps });

  it("is a no-op when run again", async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it("declares every enum with the shared values in the shared order", async () => {
    const { rows } = await db.query<{ name: string; labels: string[] }>(
      `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1 GROUP BY t.typname`,
      [schema],
    );
    expect(Object.fromEntries(rows.map((row) => [row.name, row.labels]))).toEqual({
      action_type: [...ACTION_TYPES],
      actor_type: [...ACTOR_TYPES],
      approval_reason: [...APPROVAL_REASONS],
      approval_status: [...APPROVAL_STATUSES],
      execution_status: [...EXECUTION_STATUSES],
      finding_severity: [...FINDING_SEVERITIES],
      orchestration_mode: [...ORCHESTRATION_MODES],
      platform_role: [...PLATFORM_ROLES],
      policy_scope: [...POLICY_SCOPES],
      run_status: [...RUN_STATUSES],
      security_layer: [...SECURITY_LAYERS],
      task_status: [...TASK_STATUSES],
      workspace_role: [...WORKSPACE_ROLES],
    });
  });

  it("keeps timestamps at millisecond precision in UTC", async () => {
    const u = await user();
    await db.query("UPDATE users SET created_at = $1 WHERE id = $2", ["2026-10-08T18:00:00.123+08:00", u.id]);
    const { rows } = await db.query<{ created_at: Date }>("SELECT created_at FROM users WHERE id = $1", [u.id]);
    expect(rows[0]?.created_at.toISOString()).toBe("2026-10-08T10:00:00.123Z");
  });

  it("ties platform scope to a null workspace", async () => {
    const u = await user();
    const ws = await workspace(u.id);
    const policy = (scope: string, workspaceId: unknown) =>
      insert("security_policies", {
        id: randomUUID(), workspace_id: workspaceId, name: randomUUID(), scope, rules: {},
        rules_schema_version: 1, locked: false, version: 1, ...stamps,
      });
    await expect(policy("platform", ws.id)).rejects.toThrow(/check constraint/);
    await expect(policy("workspace", null)).rejects.toThrow(/check constraint/);
    await expect(policy("platform", null)).resolves.toBeDefined();
  });

  it("allows one platform policy per name", async () => {
    const policy = () =>
      insert("security_policies", {
        id: randomUUID(), workspace_id: null, name: "no-env-files", scope: "platform", rules: {},
        rules_schema_version: 1, locked: true, version: 1, ...stamps,
      });
    await policy();
    await expect(policy()).rejects.toThrow(/unique constraint/);
  });

  it("refuses an agent whose profile belongs to another workspace", async () => {
    const u = await user();
    const home = await workspace(u.id);
    const other = await workspace(u.id);
    const foreignProfile = await profile(other.id);
    await expect(agent(home.id, foreignProfile.id, u.id)).rejects.toThrow(/foreign key/);
    await expect(agent(home.id, (await profile(home.id)).id, u.id)).resolves.toBeDefined();
  });

  it("keeps task dependencies inside one run", async () => {
    const u = await user();
    const ws = await workspace(u.id);
    const runA = await run(ws.id, u.id);
    const runB = await run(ws.id, u.id);
    const [a1, a2, b1] = [await task(runA.id), await task(runA.id), await task(runB.id)];
    await expect(insert("task_dependencies", { run_id: runA.id, task_id: a1.id, depends_on_task_id: b1.id })).rejects.toThrow(/foreign key/);
    await expect(insert("task_dependencies", { run_id: runA.id, task_id: a1.id, depends_on_task_id: a1.id })).rejects.toThrow(/check constraint/);
    await expect(insert("task_dependencies", { run_id: runA.id, task_id: a1.id, depends_on_task_id: a2.id })).resolves.toBeDefined();
  });

  it("keeps audit events append-only", async () => {
    const event = await insert("audit_events", { id: randomUUID(), actor_type: "system", event_type: "run.created", created_at: now });
    await expect(db.query("UPDATE audit_events SET event_type = 'x' WHERE id = $1", [event.id])).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_events WHERE id = $1", [event.id])).rejects.toThrow(/append-only/);
    await expect(db.query("TRUNCATE audit_events")).rejects.toThrow(/append-only/);
    await expect(insert("audit_events", { id: randomUUID(), actor_type: "user", event_type: "run.created", created_at: now })).rejects.toThrow(/check constraint/);
  });

  it("keeps findings and approvals pointing at tasks of their own run", async () => {
    const u = await user();
    const ws = await workspace(u.id);
    const [runA, runB] = [await run(ws.id, u.id), await run(ws.id, u.id)];
    const foreignTask = await task(runB.id);
    const finding = (taskId: unknown) =>
      insert("security_findings", {
        id: randomUUID(), run_id: runA.id, task_id: taskId, layer: "policy", check_name: "c", code: "x",
        severity: "info", message: "m", intervened: false, created_at: now,
      });
    await expect(finding(foreignTask.id)).rejects.toThrow(/foreign key/);
    await expect(finding((await task(runA.id)).id)).resolves.toBeDefined();
    const event = (row: Record<string, unknown>) =>
      insert("audit_events", { id: randomUUID(), actor_type: "system", event_type: "run.updated", created_at: now, ...row });
    await expect(event({ task_id: foreignTask.id })).rejects.toThrow(/check constraint/);
    await expect(event({ run_id: runA.id, task_id: foreignTask.id })).rejects.toThrow(/foreign key/);
  });

  it("keeps the agents on tasks, executions, findings and approvals inside the run's workspace", async () => {
    const u = await user();
    const [home, other] = [await workspace(u.id), await workspace(u.id)];
    const ownAgent = await agent(home.id, (await profile(home.id)).id, u.id);
    const foreignAgent = await agent(other.id, (await profile(other.id)).id, u.id);
    const r = await run(home.id, u.id);
    const assigned = (agentId: unknown) =>
      insert("tasks", { id: randomUUID(), run_id: r.id, title: "t", objective: "o", status: "pending", assigned_agent_id: agentId, ...stamps });
    await expect(assigned(foreignAgent.id)).rejects.toThrow(/is not an agent of run/);
    const t = await assigned(ownAgent.id);
    await expect(db.query("UPDATE tasks SET assigned_agent_id = $2 WHERE id = $1", [t.id, foreignAgent.id])).rejects.toThrow(/is not an agent of run/);
    const finding = (agentId: unknown) =>
      insert("security_findings", {
        id: randomUUID(), run_id: r.id, agent_id: agentId, layer: "policy", check_name: "c", code: "x",
        severity: "info", message: "m", intervened: false, created_at: now,
      });
    await expect(finding(foreignAgent.id)).rejects.toThrow(/is not an agent of run/);
    await expect(finding(null)).resolves.toBeDefined();
  });

  describe("runner", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "migrations-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("refuses to run when an applied migration has changed", async () => {
      const [first] = (await db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name")).rows;
      await writeFile(path.join(dir, first!.name), "-- edited after it was applied\n");
      try {
        await expect(migrate(db, dir)).rejects.toThrow(/has changed since it was applied/);
      } finally {
        await rm(path.join(dir, first!.name));
      }
    });

    it("treats a CRLF checkout of an applied migration as unchanged", async () => {
      const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
      for (const { name } of rows) {
        const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
        await writeFile(path.join(dir, name), sql.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"));
      }
      try {
        expect(await migrate(db, dir)).toEqual([]);
      } finally {
        for (const { name } of rows) await rm(path.join(dir, name));
      }
    });

    it("rolls back a failed migration and does not record it", async () => {
      await writeFile(path.join(dir, "999_broken.sql"), "CREATE TABLE broken_probe (id int);\nSELECT 1 / 0;\n");
      try {
        await expect(migrate(db, dir)).rejects.toThrow(/Migration 999_broken.sql failed: division by zero/);
      } finally {
        await rm(path.join(dir, "999_broken.sql"));
      }
      const { rows } = await db.query("SELECT to_regclass('broken_probe') AS probe, (SELECT count(*) FROM schema_migrations WHERE name = '999_broken.sql')::int AS recorded");
      expect(rows[0]).toEqual({ probe: null, recorded: 0 });
    });

    it("records checksums for migrations applied before checksums existed", async () => {
      await db.query("UPDATE schema_migrations SET checksum = NULL");
      expect(await migrate(db, MIGRATIONS_DIR)).toEqual([]);
      const { rows } = await db.query("SELECT count(*)::int AS missing FROM schema_migrations WHERE checksum IS NULL");
      expect(rows[0]).toEqual({ missing: 0 });
    });
  });
});

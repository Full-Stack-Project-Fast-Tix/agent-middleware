import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUser, addWorkspace } from "../../src/db/admin.js";
import { openDatabase } from "../../src/db/pool.js";
import { insertRow } from "../../src/db/rows.js";
import { removeExpiredRunFiles } from "../../src/run-retention.js";
import { traceFilePath } from "../../src/trace.js";

// Needs TEST_DATABASE_URL (see schema.test.ts).

const url = process.env.TEST_DATABASE_URL;
const schema = `test_${randomUUID().replaceAll("-", "")}`;
const NOW = Date.parse("2026-12-01T00:00:00.000Z");
const OLD = "2026-10-01T00:00:00.000Z";
const RECENT = "2026-11-25T00:00:00.000Z";

let pool: pg.Pool | undefined;
let dataDirectory = "";
let workspaceId = "";
let userId = "";
let agentId = "";

const exists = (file: string) => stat(file).then(() => true, () => false);

describe("retaining the workspace continuation head", () => {
  it("keeps only the latest successful copy while expiring its trace normally", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "run-retention-head-"));
    const olderId = randomUUID();
    const headId = randomUUID();
    const executionId = randomUUID();
    const olderWorkspace = path.join(directory, "runs", olderId, "workspace");
    const headWorkspace = path.join(directory, "runs", headId, "workspace");
    const headTrace = traceFilePath(directory, executionId);
    await mkdir(olderWorkspace, { recursive: true });
    await mkdir(headWorkspace, { recursive: true });
    await mkdir(path.dirname(headTrace), { recursive: true });
    await writeFile(headTrace, "trace\n");
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("SELECT r.id")) {
          return { rows: [{ id: olderId, keep_workspace: false }, { id: headId, keep_workspace: true }] };
        }
        if (sql.includes("agent_executions")) return { rows: sql.includes("run_id = $1") ? [{ id: executionId }] : [] };
        return { rows: [] };
      },
    } as unknown as Pick<pg.Pool, "query">;

    try {
      expect(await removeExpiredRunFiles(mockPool, { dataDirectory: directory, retentionDays: 30, now: () => NOW })).toBe(2);
      expect(await exists(olderWorkspace)).toBe(false);
      expect(await exists(headWorkspace)).toBe(true);
      expect(await exists(headTrace)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

beforeAll(async () => {
  if (!url) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = await openDatabase({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
  dataDirectory = await mkdtemp(path.join(tmpdir(), "run-retention-"));
  userId = await addUser(pool, { email: "owner@example.test", name: "Owner", password: "correct horse battery" });
  workspaceId = await addWorkspace(pool, { name: "Project", sourcePath: null, ownerEmail: "owner@example.test" });
  agentId = (await pool.query("SELECT id FROM agents WHERE workspace_id = $1 LIMIT 1", [workspaceId])).rows[0].id;
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
  await rm(dataDirectory, { recursive: true, force: true });
});

async function run(status: string, completedAt: string | null) {
  const id = randomUUID();
  const stamp = completedAt ?? OLD;
  await insertRow(pool!, "runs", { id, workspaceId, createdByUserId: userId, userPrompt: "Work", orchestrationMode: "single", status, completedAt, createdAt: stamp, updatedAt: stamp });
  const taskId = randomUUID();
  await insertRow(pool!, "tasks", { id: taskId, runId: id, title: "Work", objective: "Work", assignedAgentId: agentId, status: "completed", createdAt: stamp, updatedAt: stamp });
  const executionId = randomUUID();
  await insertRow(pool!, "agent_executions", {
    id: executionId, runId: id, taskId, agentId, attempt: 1, status: "completed", capabilities: { write: false, shell: false, network: false, delegate: false, maxDelegationDepth: 0 },
    traceTruncated: false, createdAt: stamp, updatedAt: stamp,
  });
  const workspace = path.join(dataDirectory, "runs", id, "workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.dirname(traceFilePath(dataDirectory, executionId)), { recursive: true });
  await writeFile(traceFilePath(dataDirectory, executionId), "{}\n");
  return { id, trace: traceFilePath(dataDirectory, executionId), workspace };
}

describe.skipIf(!url)("removing old run files", () => {
  it("removes only a finished run past retention, and keeps its rows", async () => {
    const expired = await run("completed", OLD);
    const failed = await run("failed", OLD);
    const recent = await run("completed", RECENT);
    const waiting = await run("waiting_approval", null);
    const unknown = path.join(dataDirectory, "runs", randomUUID());
    await mkdir(unknown, { recursive: true });

    expect(await removeExpiredRunFiles(pool!, { dataDirectory, retentionDays: 30, now: () => NOW })).toBe(2);

    for (const gone of [expired, failed]) {
      expect(await exists(gone.workspace)).toBe(false);
      expect(await exists(gone.trace)).toBe(false);
    }
    for (const kept of [recent, waiting]) {
      expect(await exists(kept.workspace)).toBe(true);
      expect(await exists(kept.trace)).toBe(true);
    }
    expect(await exists(unknown)).toBe(true);
    const { rows } = await pool!.query("SELECT id FROM runs WHERE id = $1", [expired.id]);
    expect(rows).toHaveLength(1);
  });

  it("does nothing when there is no runs directory", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "run-retention-empty-"));
    expect(await removeExpiredRunFiles(pool!, { dataDirectory: empty, retentionDays: 30, now: () => NOW })).toBe(0);
    await rm(empty, { recursive: true, force: true });
  });
});

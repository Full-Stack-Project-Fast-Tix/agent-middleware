import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Agent, RunEvent, RunSnapshot } from "@launchpad/shared";
import { migrate } from "../../src/db/migrate.js";
import { PostgresAgentDirectory } from "../../src/db/postgres-agent-directory.js";
import { PostgresRunStore } from "../../src/db/postgres-run-store.js";
import { insertRow, toRow } from "../../src/db/rows.js";
import { HttpError } from "../../src/errors.js";
import { InMemoryRunStore } from "../../src/orchestrator/in-memory-run-store.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { RunStore } from "../../src/orchestrator/ports.js";
import { RunEventHub } from "../../src/run-events.js";
import {
  CAPABILITIES,
  makeApproval,
  makeExecution,
  makeFinding,
  makeRun,
  makeTask,
} from "../integration/harness/factories.js";
import { checkRunInvariants } from "../integration/harness/invariants.js";
import { ScriptedMiddleware } from "../integration/harness/stand-in.js";
import { AGENTS, SIGNUP_PLAN, ScriptedRuntime, StaticPlanner, USER_ID, WORKSPACE_ID, makeAgent, waitFor } from "../orchestrator/fixtures.js";

// The RunStore contract, held against InMemoryRunStore and PostgresRunStore
// alike. The Postgres half needs TEST_DATABASE_URL (see schema.test.ts) and
// runs in a fresh schema seeded with the harness's user, workspace and agents.

const url = process.env.TEST_DATABASE_URL;
const schema = `test_${randomUUID().replaceAll("-", "")}`;
const SEEDED_AT = "2026-10-01T00:00:00.000Z";
const LATER = "2026-10-08T12:00:00.000Z";
const ROLES = Object.keys(AGENTS) as Array<keyof typeof AGENTS>;
const profileId = (role: keyof typeof AGENTS) => `00000000-0000-4000-8000-00000000000${ROLES.indexOf(role) + 1}`;
const seededAgent = (role: keyof typeof AGENTS): Agent => makeAgent(role, { profileId: profileId(role) });

let pool: pg.Pool | undefined;

async function seedWorkspace(db: pg.Pool, workspaceId: string, agents: Array<{ role: keyof typeof AGENTS; agent: Agent }>) {
  const stamps = { createdAt: SEEDED_AT, updatedAt: SEEDED_AT };
  await insertRow(db, "workspaces", { id: workspaceId, name: "Workspace", createdByUserId: USER_ID, ...stamps });
  for (const { role, agent } of agents) {
    await insertRow(db, "agent_profiles", {
      id: agent.profileId, workspaceId, name: role, capabilities: CAPABILITIES[role], version: 1, ...stamps,
    });
    await insertRow(db, "agents", agent);
  }
}

beforeAll(async () => {
  if (!url) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
  const db = await pool.connect();
  try {
    await migrate(db);
  } finally {
    db.release();
  }
  await insertRow(pool, "users", {
    id: USER_ID, email: "user@example.test", name: "User", authSubject: "user", createdAt: SEEDED_AT, updatedAt: SEEDED_AT,
  });
  await seedWorkspace(pool, WORKSPACE_ID, ROLES.map((role) => ({ role, agent: seededAgent(role) })));
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

type Store = RunStore & { snapshot(runId: string): RunSnapshot | null | Promise<RunSnapshot | null> };

const targets: Array<{ name: string; skip: boolean; open: (hub: RunEventHub, now?: () => string) => Store }> = [
  { name: "InMemoryRunStore", skip: false, open: (hub, now) => new InMemoryRunStore(hub, now) },
  { name: "PostgresRunStore", skip: !url, open: (hub, now) => new PostgresRunStore(pool!, hub, now) },
];

/** Every event of the run from seq 1, kept up to date. */
function record(hub: RunEventHub, runId: string): RunEvent[] {
  const events: RunEvent[] = [];
  const subscription = hub.subscribe(runId, 0, {
    onEvent: (event) => events.push(event),
    onResync: () => {
      throw new Error("unexpected resync");
    },
  });
  if (subscription.status !== "subscribed") throw new Error("could not subscribe");
  return events;
}

for (const target of targets) {
  describe.skipIf(target.skip)(target.name, () => {
    it("stores every entity as given, lists in creation order and publishes one event per write", async () => {
      const hub = new RunEventHub();
      const store = target.open(hub);
      const run = makeRun({ orchestrationMode: "auto", supervisorAgentId: AGENTS.supervisor });
      const events = record(hub, run.id);

      expect(await store.createRun(run)).toEqual(run);
      // Equal timestamps: creation order must not depend on them.
      const createdAt = new Date().toISOString();
      const [first, second, third] = ["First", "Second", "Third"].map((title) => makeTask(run.id, { title, createdAt, updatedAt: createdAt }));
      await store.createTask(third!, []);
      await store.createTask(first!, []);
      await store.createTask(second!, [third!.id, first!.id]);
      const execution = makeExecution(first!, AGENTS.developer, {
        capabilities: CAPABILITIES.developer,
        usage: { inputTokens: 10, outputTokens: 2 },
      });
      await store.createExecution(execution);
      const finding = makeFinding(execution, { facts: { host: "paste.example.com" }, evidence: { lines: [1, 2], nested: { ok: true } } });
      await store.addFinding(finding);
      const approval = makeApproval(execution, { safeDetails: { files: [{ path: "src/a.ts", kind: "update" }] } });
      await store.requestApproval(approval);

      expect(await store.getRun(run.id)).toEqual(run);
      expect(await store.getTask(second!.id)).toEqual(second);
      expect(await store.getExecution(execution.id)).toEqual(execution);
      expect(await store.getApproval(approval.id)).toEqual(approval);
      expect(await store.getRun(randomUUID())).toBeNull();
      expect((await store.listTasks(run.id)).map((task) => task.title)).toEqual(["Third", "First", "Second"]);
      expect(await store.listDependencies(run.id)).toEqual(
        expect.arrayContaining([
          { runId: run.id, taskId: second!.id, dependsOnTaskId: third!.id },
          { runId: run.id, taskId: second!.id, dependsOnTaskId: first!.id },
        ]),
      );
      expect(await store.listExecutions(run.id)).toEqual([execution]);
      expect(await store.listApprovals(run.id)).toEqual([approval]);

      expect(events.map((event) => [event.seq, event.type])).toEqual([
        [1, "run.updated"],
        [2, "task.created"],
        [3, "task.created"],
        [4, "task.created"],
        [5, "execution.updated"],
        [6, "finding.created"],
        [7, "approval.requested"],
      ]);
      const snapshot = await store.snapshot(run.id);
      expect(snapshot).toMatchObject({ run, tasks: [third, first, second], executions: [execution], findings: [finding], approvals: [approval], lastEventSeq: 7 });
      expect(snapshot!.dependencies).toHaveLength(2);
      expect(await store.snapshot(randomUUID())).toBeNull();
    });

    it("stamps updatedAt on every update and publishes the stored entity", async () => {
      const hub = new RunEventHub();
      const store = target.open(hub, () => LATER);
      const run = await store.createRun(makeRun());
      const task = await store.createTask(makeTask(run.id), []);
      const execution = await store.createExecution(makeExecution(task, AGENTS.analyst));
      const approval = await store.requestApproval(makeApproval(execution));
      const events = record(hub, run.id);

      const updatedRun = await store.updateRun(run.id, { status: "running", startedAt: LATER, evaluation: null });
      expect(updatedRun).toEqual({ ...run, status: "running", startedAt: LATER, updatedAt: LATER });
      const updatedTask = await store.updateTask(task.id, { status: "completed", result: "done" });
      expect(updatedTask).toEqual({ ...task, status: "completed", result: "done", updatedAt: LATER });
      const updatedExecution = await store.updateExecution(execution.id, { status: "completed", usage: { outputTokens: 5 } });
      expect(updatedExecution).toEqual({ ...execution, status: "completed", usage: { outputTokens: 5 }, updatedAt: LATER });
      const resolved = await store.resolveApproval(approval.id, "approved", USER_ID);
      expect(resolved).toEqual({ ...approval, status: "approved", resolvedAt: LATER, resolvedByUserId: USER_ID });

      expect(await store.getRun(run.id)).toEqual(updatedRun);
      expect(await store.getTask(task.id)).toEqual(updatedTask);
      expect(await store.getExecution(execution.id)).toEqual(updatedExecution);
      expect(await store.getApproval(approval.id)).toEqual(resolved);
      expect(events.slice(-4).map((event) => [event.seq, event.type, Object.values(event.payload)[0]])).toEqual([
        [5, "run.updated", updatedRun],
        [6, "task.updated", updatedTask],
        [7, "execution.updated", updatedExecution],
        [8, "approval.resolved", resolved],
      ]);
    });

    it("lists active runs and pending approvals past their expiry", async () => {
      const store = target.open(new RunEventHub());
      const active = await store.createRun(makeRun({ status: "running" }));
      const finished = await store.createRun(makeRun({ status: "completed" }));
      const activeIds = (await store.listActiveRuns()).map((run) => run.id);
      expect(activeIds).toContain(active.id);
      expect(activeIds).not.toContain(finished.id);

      const task = await store.createTask(makeTask(active.id), []);
      const execution = await store.createExecution(makeExecution(task, AGENTS.analyst));
      const asOf = "2026-10-09T00:00:00.000Z";
      const approval = (expiresAt: string | null) => store.requestApproval(makeApproval(execution, { expiresAt }));
      const overdue = await approval("2026-10-08T23:59:59.999Z");
      const dueNow = await approval(asOf);
      const later = await approval("2026-10-09T00:00:00.001Z");
      const noExpiry = await approval(null);
      const answered = await approval("2026-10-08T00:00:00.000Z");
      await store.resolveApproval(answered.id, "approved", USER_ID);

      const expired = (await store.listExpiredApprovals(asOf)).map((item) => item.id);
      expect(expired).toEqual(expect.arrayContaining([overdue.id, dueNow.id]));
      for (const skipped of [later, noExpiry, answered]) expect(expired).not.toContain(skipped.id);
    });

    it("appends audit events and refuses malformed ones", async () => {
      const store = target.open(new RunEventHub());
      const run = await store.createRun(makeRun());
      const event = {
        id: randomUUID(),
        workspaceId: WORKSPACE_ID,
        actorType: "user" as const,
        actorId: USER_ID,
        eventType: "run.created" as const,
        runId: run.id,
        taskId: null,
        executionId: null,
        metadata: { orchestrationMode: "single" },
        createdAt: new Date().toISOString(),
      };
      await store.appendAudit(event);
      await expect(store.appendAudit({ ...event, id: randomUUID(), actorId: null })).rejects.toThrow();
      if (store instanceof PostgresRunStore) {
        const { rows } = await pool!.query("SELECT actor_type, event_type, metadata FROM audit_events WHERE run_id = $1", [run.id]);
        expect(rows).toEqual([{ actor_type: "user", event_type: "run.created", metadata: { orchestrationMode: "single" } }]);
      }
    });

    it("rejects updates to rows that do not exist", async () => {
      const store = target.open(new RunEventHub());
      await expect(store.updateRun(randomUUID(), { status: "running" })).rejects.toThrow();
      await expect(store.updateTask(randomUUID(), { status: "running" })).rejects.toThrow();
      await expect(store.updateExecution(randomUUID(), { status: "running" })).rejects.toThrow();
      await expect(store.resolveApproval(randomUUID(), "denied", USER_ID)).rejects.toThrow();
    });
  });
}

describe.skipIf(!url)("PostgresRunStore only", () => {
  it("refuses to settle an approval twice, without publishing", async () => {
    const hub = new RunEventHub();
    const store = new PostgresRunStore(pool!, hub);
    const run = await store.createRun(makeRun());
    const task = await store.createTask(makeTask(run.id), []);
    const execution = await store.createExecution(makeExecution(task, AGENTS.analyst));
    const approval = await store.requestApproval(makeApproval(execution));
    await store.resolveApproval(approval.id, "timed_out", null);

    const second = store.resolveApproval(approval.id, "approved", USER_ID);
    await expect(second).rejects.toBeInstanceOf(HttpError);
    await expect(second).rejects.toMatchObject({ statusCode: 409 });
    expect(await store.getApproval(approval.id)).toMatchObject({ status: "timed_out", resolvedByUserId: null });
    expect((await store.snapshot(run.id))!.lastEventSeq).toBe(5);
  });

  it("publishes concurrent writes in seq order", async () => {
    const hub = new RunEventHub();
    const store = new PostgresRunStore(pool!, hub);
    const run = await store.createRun(makeRun());
    const events = record(hub, run.id);
    // The hub throws on a seq published out of order, which would reject here.
    await Promise.all(Array.from({ length: 30 }, (_, i) => store.updateRun(run.id, { finalOutput: `write ${i}` })));
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  });

  it("lists tasks created at once in the order of their events", async () => {
    const hub = new RunEventHub();
    const store = new PostgresRunStore(pool!, hub);
    const run = await store.createRun(makeRun());
    const events = record(hub, run.id);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.createTask(makeTask(run.id, { title: `Task ${i}` }), [])));
    const announced = events.flatMap((event) => (event.type === "task.created" ? [event.payload.task.id] : []));
    expect((await store.listTasks(run.id)).map((task) => task.id)).toEqual(announced);
  });

  it("publishes in seq order when COMMIT replies arrive out of order", async () => {
    const hub = new RunEventHub();
    const run = await new PostgresRunStore(pool!, hub).createRun(makeRun());
    const events = record(hub, run.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holdNextCommit = true;
    // Holds back the first COMMIT reply after the server has committed, like a slow network.
    const slowPool = {
      query: pool!.query.bind(pool),
      connect: async () => {
        const client = await pool!.connect();
        return new Proxy(client, {
          get(target, key) {
            if (key === "query") {
              return async (...args: Parameters<pg.PoolClient["query"]>) => {
                const result = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
                if (args[0] === "COMMIT" && holdNextCommit) {
                  holdNextCommit = false;
                  await held;
                }
                return result;
              };
            }
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as pg.Pool;
    const store = new PostgresRunStore(slowPool, hub);

    const first = store.updateRun(run.id, { finalOutput: "first" });
    await waitFor(() => !holdNextCommit);
    await store.updateRun(run.id, { finalOutput: "second" });
    expect(events.map((event) => event.seq)).toEqual([1]);
    release();
    await first;
    expect(events.map((event) => [event.seq, event.type === "run.updated" ? event.payload.run.finalOutput : null])).toEqual([
      [1, null],
      [2, "first"],
      [3, "second"],
    ]);
  });

  it("resolves a committed write even when its event cannot be published", async () => {
    const failingHub = { publish: () => { throw new Error("hub down"); } } as unknown as RunEventHub;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const run = await new PostgresRunStore(pool!, new RunEventHub()).createRun(makeRun());
      const store = new PostgresRunStore(pool!, failingHub);
      await expect(store.updateRun(run.id, { status: "running" })).resolves.toMatchObject({ status: "running" });
      expect(await store.getRun(run.id)).toMatchObject({ status: "running" });
      expect(errors).toHaveBeenCalledOnce();
    } finally {
      errors.mockRestore();
    }
  });

  it("leaves a column alone when its change is undefined", async () => {
    const store = new PostgresRunStore(pool!, new RunEventHub());
    const run = await store.createRun(makeRun());
    const task = await store.createTask(makeTask(run.id, { error: "boom" }), []);
    expect(await store.updateTask(task.id, { status: "running", error: undefined })).toMatchObject({ status: "running", error: "boom" });
  });

  it("continues a run's seqs after a restart", async () => {
    const run = await new PostgresRunStore(pool!, new RunEventHub()).createRun(makeRun());
    const hub = new RunEventHub();
    const events = record(hub, run.id);
    await new PostgresRunStore(pool!, hub).updateRun(run.id, { status: "running" });
    expect(events.map((event) => event.seq)).toEqual([2]);
  });

  it("runs the orchestrator end to end, with agents from the database", async () => {
    const hub = new RunEventHub();
    const store = new PostgresRunStore(pool!, hub);
    const runtime = new ScriptedRuntime({
      "Add validation": {
        actions: [{ type: "file_change", changes: [{ path: "src/signup.ts", kind: "update", movePath: null, diff: "+ validate(body)" }] }],
      },
    });
    const errors: unknown[] = [];
    const orchestrator = new Orchestrator({
      store,
      agents: new PostgresAgentDirectory(pool!),
      middleware: new ScriptedMiddleware({}),
      planner: new StaticPlanner(SIGNUP_PLAN),
      runtime,
      workingCopies: { prepare: async (run) => `/runs/${run.id}/workspace` },
      limits: { approvalTtlMs: 60_000 },
      onError: (error) => errors.push(error),
    });

    const run = await orchestrator.createRun({
      workspaceId: WORKSPACE_ID,
      createdByUserId: USER_ID,
      userPrompt: "Add input validation to the signup endpoint",
      orchestrationMode: "auto",
    });
    const events = record(hub, run.id);
    const pending = await waitFor(async () => (await store.listApprovals(run.id)).find((approval) => approval.status === "pending"));
    await orchestrator.resolveApproval(pending.id, "approve", USER_ID);
    await orchestrator.whenSettled(run.id);

    const snapshot = (await store.snapshot(run.id))!;
    expect(errors).toEqual([]);
    expect(checkRunInvariants(run.id, events, snapshot)).toEqual([]);
    expect(snapshot.run).toMatchObject({ status: "completed", supervisorAgentId: AGENTS.supervisor });
    expect(snapshot.tasks.map((task) => [task.title, task.status])).toEqual([
      ["Plan", "completed"],
      ["Find missing validation", "completed"],
      ["Add validation", "completed"],
    ]);
    expect(snapshot.approvals.map((approval) => approval.status)).toEqual(["approved"]);
  });
});

describe.skipIf(!url)("PostgresAgentDirectory", () => {
  it("reads agents and picks the workspace's one delegating agent for auto runs", async () => {
    const directory = new PostgresAgentDirectory(pool!);
    expect(await directory.getAgent(AGENTS.analyst)).toEqual(seededAgent("analyst"));
    expect(await directory.getAgent(randomUUID())).toBeNull();
    expect((await directory.listAgents(WORKSPACE_ID)).map((agent) => agent.id).sort()).toEqual(Object.values(AGENTS).sort());
    expect(await directory.defaultAgentId(WORKSPACE_ID, "auto")).toBe(AGENTS.supervisor);
    expect(await directory.defaultAgentId(WORKSPACE_ID, "single")).toBeNull();
  });

  it("has no default when two agents may delegate", async () => {
    const workspaceId = randomUUID();
    const supervisor = (id: string) => ({
      role: "supervisor" as const,
      agent: makeAgent("supervisor", { id: randomUUID(), workspaceId, profileId: id }),
    });
    await seedWorkspace(pool!, workspaceId, [supervisor(randomUUID()), supervisor(randomUUID())]);
    expect(await new PostgresAgentDirectory(pool!).defaultAgentId(workspaceId, "auto")).toBeNull();
  });
});

describe("toRow", () => {
  it("refuses keys that are not plain column names, since columns are written into SQL", () => {
    expect(toRow({ runId: "r", check: "c", capabilities: { maxDelegationDepth: 1 } })).toEqual({ run_id: "r", check_name: "c", cap_max_delegation_depth: 1 });
    expect(() => toRow({ "id) VALUES (1); DROP TABLE runs; --": 1 })).toThrow(/Invalid column name/);
    expect(() => toRow({ "1st": 1 })).toThrow(/Invalid column name/);
  });
});

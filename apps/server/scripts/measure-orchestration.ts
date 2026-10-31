// Measures the orchestration layer the way a browser uses it: real HTTP
// routes, the real RunEventHub and SSE stream, the real Orchestrator, with the
// demo's simulated planner, runtime and middleware (src/dev/demo-runs.ts).
// Nothing executes, so the numbers are the platform's own cost, not an
// agent's or a model's.
//
// For each concurrency level it starts that many Runs at once. Each client
// follows its Run over SSE from seq 0, approves every approval through
// POST /api/approvals/:id/resolve as soon as it arrives, and stops at the
// terminal run.updated.
//
//   npx tsx --conditions=development scripts/measure-orchestration.ts \
//     [--runs 1,10,50,100] [--pause 0] [--store memory|postgres] [--out results.json]
//
// --pause scales the demo's simulated thinking time: 0 measures pure
// orchestration overhead, 1 is the pace you see in the browser demo.
//
// --store postgres keeps Runs in PostgresRunStore, in a throwaway schema of the
// database TEST_DATABASE_URL names, on a pool sized as index.ts leaves it.

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import pg from "pg";
import {
  apiPaths,
  followRunEvents,
  isTerminalRunStatus,
  runResponseSchema,
  runSnapshotResponseSchema,
  type RunEvent,
} from "@launchpad/shared";
import type { AgentService } from "../src/agent-service.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/pool.js";
import { PostgresRunStore } from "../src/db/postgres-run-store.js";
import { createDemoRuns, DEMO_WORKSPACE, seedDemo, type DemoStore } from "../src/dev/demo-runs.js";
import { InMemoryRunStore } from "../src/orchestrator/in-memory-run-store.js";
import { RunEventHub } from "../src/run-events.js";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback;
}

const LEVELS = argument("runs", "1,10,50,100").split(",").map(Number).filter((value) => value > 0);
const PAUSE = Number(argument("pause", "0"));
const OUT = argument("out", "");
const STORE = argument("store", "memory");
if (STORE !== "memory" && STORE !== "postgres") throw new Error(`--store must be memory or postgres, not ${STORE}`);

/** Where a level's Runs live, and how to count a Run's security decisions there. */
interface Backend {
  open(hub: RunEventHub): DemoStore;
  decisions(store: DemoStore, runId: string): Promise<number>;
  close(): Promise<void>;
}

const memoryBackend: Backend = {
  open: (hub) => new InMemoryRunStore(hub),
  decisions: async (store, runId) =>
    (store as InMemoryRunStore).auditEvents(runId).filter((event) => event.eventType === "security.decision").length,
  close: async () => undefined,
};

async function postgresBackend(): Promise<Backend> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("--store postgres needs TEST_DATABASE_URL.");
  const schema = `measure_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = await openDatabase({ connectionString: url, options: `-c search_path=${schema}` });
  await seedDemo(pool);
  return {
    open: (hub) => new PostgresRunStore(pool, hub),
    decisions: async (_store, runId) => {
      const { rows } = await pool.query<{ count: string }>(
        "SELECT count(*) FROM audit_events WHERE run_id = $1 AND event_type = 'security.decision'",
        [runId],
      );
      return Number(rows[0]!.count);
    },
    close: async () => {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}

interface RunSample {
  status: string;
  createMs: number;
  durationMs: number;
  snapshotMs: number;
  resolveMs: number[];
  eventLagMs: number[];
  events: number;
  decisions: number;
}

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await work();
  return [result, performance.now() - start];
}

async function measureLevel(concurrency: number, backend: Backend) {
  const hub = new RunEventHub({ bufferSize: 10_000 });
  const demo = createDemoRuns(hub, { pauseScale: PAUSE, store: backend.open(hub) });
  const app = await createApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }), {} as AgentService, {
    runEvents: { hub, canReadRun: async (runId) => (await demo.store.getRun(runId)) !== null },
    runs: demo.routes,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = (path: string, body?: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const one = async (index: number): Promise<RunSample> => {
    const started = performance.now();
    const [response, createMs] = await timed(() =>
      post(apiPaths.runs(DEMO_WORKSPACE.id), { userPrompt: `Load run ${index}`, orchestrationMode: "auto" }),
    );
    if (response.status !== 201) throw new Error(`create returned ${response.status}`);
    const { run } = runResponseSchema.parse(await response.json());

    const resolveMs: number[] = [];
    const eventLagMs: number[] = [];
    let events = 0;
    let status = run.status as string;
    const controller = new AbortController();
    const answering: Array<Promise<void>> = [];
    await followRunEvents({
      url: base + apiPaths.runEvents(run.id),
      afterSeq: 0,
      signal: controller.signal,
      onEvent: (event: RunEvent) => {
        events += 1;
        eventLagMs.push(Date.now() - Date.parse(event.timestamp));
        if (event.type === "approval.requested") {
          answering.push(
            timed(() => post(apiPaths.resolveApproval(event.payload.approval.id), { decision: "approve" })).then(([, ms]) => {
              resolveMs.push(ms);
            }),
          );
        }
        if (event.type === "run.updated" && isTerminalRunStatus(event.payload.run.status)) {
          status = event.payload.run.status;
          controller.abort();
        }
      },
      onResync: async () => {
        throw new Error("unexpected resync");
      },
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
    await Promise.all(answering);
    const durationMs = performance.now() - started;

    const [snapshotResponse, snapshotMs] = await timed(() => fetch(base + apiPaths.runSnapshot(run.id)));
    runSnapshotResponseSchema.parse(await snapshotResponse.json());
    const decisions = await backend.decisions(demo.store, run.id);
    return { status, createMs, durationMs, snapshotMs, resolveMs, eventLagMs, events, decisions };
  };

  const [samples, wallMs] = await timed(() => Promise.all(Array.from({ length: concurrency }, (_, index) => one(index))));
  await app.close();
  return { concurrency, wallMs, samples };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const ms = (value: number) => (Number.isNaN(value) ? "—" : value < 10 ? value.toFixed(1) : Math.round(value).toString());

async function main() {
  const results = [];
  const backend = STORE === "postgres" ? await postgresBackend() : memoryBackend;
  // One small warm-up so JIT and module loading do not count against level 1.
  await measureLevel(2, backend);
  for (const level of LEVELS) {
    const { concurrency, wallMs, samples } = await measureLevel(level, backend);
    const completed = samples.filter((sample) => sample.status === "completed").length;
    const all = (pick: (sample: RunSample) => number[]) => samples.flatMap(pick);
    const row = {
      concurrency,
      completed,
      wallMs,
      runsPerSecond: (concurrency / wallMs) * 1000,
      eventsPerSecond: (all((sample) => [sample.events]).reduce((a, b) => a + b, 0) / wallMs) * 1000,
      createP50: percentile(all((sample) => [sample.createMs]), 50),
      createP95: percentile(all((sample) => [sample.createMs]), 95),
      resolveP50: percentile(all((sample) => sample.resolveMs), 50),
      resolveP95: percentile(all((sample) => sample.resolveMs), 95),
      snapshotP95: percentile(all((sample) => [sample.snapshotMs]), 95),
      eventLagP95: percentile(all((sample) => sample.eventLagMs), 95),
      eventLagMax: Math.max(...all((sample) => sample.eventLagMs)),
      runP50: percentile(all((sample) => [sample.durationMs]), 50),
      runP95: percentile(all((sample) => [sample.durationMs]), 95),
      perDecisionMs: percentile(all((sample) => [sample.durationMs / Math.max(1, sample.decisions)]), 50),
    };
    results.push(row);
  }
  await backend.close();

  console.log(`\nOrchestration over HTTP + SSE, simulated agents, ${STORE} store, pause scale ${PAUSE}. Times in ms.\n`);
  console.log("| Runs at once | Completed | Create p50 / p95 | Approve p50 / p95 | Snapshot p95 | Event lag p95 / max | Run p50 / p95 | Per decision* | Runs/s | Events/s |");
  console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of results) {
    console.log(
      `| ${row.concurrency} | ${row.completed}/${row.concurrency} | ${ms(row.createP50)} / ${ms(row.createP95)} | ${ms(row.resolveP50)} / ${ms(row.resolveP95)} | ${ms(row.snapshotP95)} | ${ms(row.eventLagP95)} / ${ms(row.eventLagMax)} | ${ms(row.runP50)} / ${ms(row.runP95)} | ${ms(row.perDecisionMs)} | ${row.runsPerSecond.toFixed(1)} | ${Math.round(row.eventsPerSecond)} |`,
    );
  }
  console.log("\n* Run duration divided by the security decisions in it: orchestration cost per gated action, including the approval round trip.");
  if (OUT) writeFileSync(OUT, JSON.stringify({ store: STORE, pauseScale: PAUSE, node: process.version, results }, null, 2));
}

await main();

import path from "node:path";
import { AgentService } from "./agent-service.js";
import { startArkProxy, type ArkProxy } from "./ark-proxy.js";
import { createApp } from "./app.js";
import { signedInUser } from "./auth-routes.js";
import { createDemoRuns, seedDemo, type DemoRuns, type DemoStore } from "./dev/demo-runs.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { openDatabase } from "./db/pool.js";
import { PostgresIdentity } from "./db/postgres-identity.js";
import { PostgresSignInThrottle } from "./db/postgres-sign-in-throttle.js";
import { PostgresRunStore } from "./db/postgres-run-store.js";
import { startApprovalSweep } from "./orchestrator/orchestrator.js";
import { createPostgresRuns } from "./postgres-runs.js";
import { RunEventHub } from "./run-events.js";
import { startRunFileSweep } from "./run-retention.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();

// Start the provider adapter before writing config.toml, so Codex is pointed at
// it rather than at Ark directly. Without this, only the first turn of a thread
// succeeds. See ark-proxy.ts.
let arkProxy: ArkProxy | null = null;
if (config.arkProxyEnabled) {
  arkProxy = await startArkProxy(config);
}
await writeCodexConfig(config, arkProxy?.baseUrlForCodex ?? config.arkBaseUrl);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

// The orchestrator publishes RunEvents here; browsers follow them over SSE.
const runEvents = new RunEventHub();

// `--runs-demo` (npm run dev:demo) or RUNS_DEMO=1 mounts the multi-agent run
// routes with a simulated runtime and middleware (dev/demo-runs.ts), so the
// Runs UI can be developed against the real orchestrator before P1's
// middleware exists. Nothing in it executes.
const runsDemo = process.argv.includes("--runs-demo") || process.env.RUNS_DEMO === "1";
if (runsDemo && config.nodeEnv === "production") {
  throw new Error("RUNS_DEMO uses simulated security decisions and must not run in production.");
}

// With DATABASE_URL set, the schema is migrated here and Runs are kept in
// Postgres. With APP_AUTH_MODE=password as well, users sign in (db:admin adds
// them) and Runs are real: P1's middleware, the model planner and Codex containers.
if (config.authMode === "password" && (runsDemo || !process.env.DATABASE_URL)) {
  throw new Error("APP_AUTH_MODE=password needs DATABASE_URL, and does not combine with RUNS_DEMO.");
}
const database = process.env.DATABASE_URL ? await openDatabase({ connectionString: process.env.DATABASE_URL }) : null;
const identity = config.authMode === "password" ? new PostgresIdentity(database!) : null;

let runs: Pick<DemoRuns<DemoStore>, "orchestrator" | "store" | "routes"> | null = null;
if (runsDemo && database !== null) {
  await seedDemo(database);
  runs = createDemoRuns(runEvents, { store: new PostgresRunStore(database, runEvents) });
} else if (runsDemo) {
  runs = createDemoRuns(runEvents);
} else if (identity !== null && config.runtimeProvider === "container") {
  runs = createPostgresRuns(config, database!, runEvents, identity);
}

const app = await createApp(config, service, {
  runEvents: {
    hub: runEvents,
    canReadRun: async (runId, request) => {
      if (runs === null) return runEvents.has(runId);
      const run = await runs.store.getRun(runId);
      if (run === null || identity === null) return run !== null;
      return (await identity.workspaceRole(run.workspaceId, signedInUser(request).id)) !== null;
    },
    lastEventSeq: async (runId) => (await runs?.store.snapshot(runId))?.lastEventSeq ?? 0,
  },
  ...(runs === null ? {} : { runs: runs.routes }),
  ...(identity === null ? {} : { identity, memberDatabase: database!, signInThrottle: new PostgresSignInThrottle(database!) }),
  ...(database === null ? {} : { checkDatabase: () => database.query("SELECT 1") }),
});
if (identity !== null && runs === null) {
  app.log.warn("Multi-agent runs need RUNTIME_PROVIDER=container, so their routes are off.");
}
let stopApprovalSweep = () => {};
let stopRunFileSweep = () => {};
if (runs !== null) {
  if (runsDemo) app.log.warn("RUNS_DEMO is on: multi-agent runs use a simulated runtime and security middleware.");
  const recovered = await runs.orchestrator.recoverInterruptedRuns();
  if (recovered > 0) app.log.warn({ recovered }, "Closed runs the previous process left active");
  stopApprovalSweep = startApprovalSweep(runs.orchestrator, {
    onError: (error) => app.log.error({ err: error }, "Approval timeout sweep failed"),
  });
  if (identity !== null) {
    stopRunFileSweep = startRunFileSweep(database!, {
      dataDirectory: config.dataDirectory,
      retentionDays: config.runArtifactRetentionDays,
      onError: (error) => app.log.error({ err: error }, "Removing old run files failed"),
      onRemoved: (count) => app.log.info({ count }, "Removed files of runs past retention"),
    });
  }
}

if (arkProxy) {
  app.log.info(
    { port: arkProxy.port, upstream: config.arkBaseUrl },
    "Ark provider adapter listening",
  );
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  stopApprovalSweep();
  stopRunFileSweep();
  await app.close();
  await arkProxy?.close();
  await database?.end();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// The demo has simulated security and usually no access token: keep it on this
// machine unless HOST was set on purpose.
const host = runsDemo && process.env.HOST === undefined ? "127.0.0.1" : config.host;
await app.listen({ host, port: config.port });

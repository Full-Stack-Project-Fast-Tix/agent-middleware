import path from "node:path";
import { AgentService } from "./agent-service.js";
import { startArkProxy, type ArkProxy } from "./ark-proxy.js";
import { createApp } from "./app.js";
import { createDemoRuns } from "./dev/demo-runs.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { RunEventHub } from "./run-events.js";
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
const demoRuns = runsDemo ? createDemoRuns(runEvents) : null;
if (demoRuns !== null && config.nodeEnv === "production") {
  throw new Error("RUNS_DEMO uses simulated security decisions and must not run in production.");
}

const app = await createApp(config, service, {
  runEvents: {
    hub: runEvents,
    canReadRun: (runId) => (demoRuns === null ? runEvents.has(runId) : demoRuns.store.snapshot(runId) !== null),
  },
  ...(demoRuns === null ? {} : { runs: demoRuns.routes }),
});
if (demoRuns !== null) {
  demoRuns.registerDirectoryRoutes(app);
  app.log.warn("RUNS_DEMO is on: multi-agent runs use a simulated runtime and security middleware.");
}

if (arkProxy) {
  app.log.info(
    { port: arkProxy.port, upstream: config.arkBaseUrl },
    "Ark provider adapter listening",
  );
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await arkProxy?.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// The demo has simulated security and usually no access token: keep it on this
// machine unless HOST was set on purpose.
const host = demoRuns !== null && process.env.HOST === undefined ? "127.0.0.1" : config.host;
await app.listen({ host, port: config.port });

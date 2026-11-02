import path from "node:path";
import type pg from "pg";
import { createClaudeClient } from "./anthropic-client.js";
import { signedInUser } from "./auth-routes.js";
import { DockerToolSandboxProvider } from "./claude-tool-sandbox.js";
import type { AppConfig } from "./config.js";
import { PostgresAgentDirectory } from "./db/postgres-agent-directory.js";
import type { PostgresIdentity } from "./db/postgres-identity.js";
import { PostgresRunStore } from "./db/postgres-run-store.js";
import { PostgresSecuritySource } from "./db/postgres-security-source.js";
import { ClaudeExecutionRuntime } from "./orchestrator/claude-execution-runtime.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createModelPlanner } from "./orchestrator/planner.js";
import { DirectoryWorkingCopies } from "./orchestrator/working-copies.js";
import type { RunEventHub } from "./run-events.js";
import type { RunRoutesOptions } from "./run-routes.js";
import { createSecurityMiddleware } from "./security-middleware-impl.js";
import { createSemanticIntentMonitor } from "./semantic-intent-monitor.js";

/**
 * Multi-agent Runs for signed-in users, kept in PostgreSQL: P1's middleware
 * reading trusted facts from the database, the model planner, and one disposable
 * container per execution on the Run's own copy of its workspace.
 */
export function createPostgresRuns(config: AppConfig, pool: pg.Pool, hub: RunEventHub, identity: PostgresIdentity) {
  const store = new PostgresRunStore(pool, hub);
  const agents = new PostgresAgentDirectory(pool);
  const orchestrator = new Orchestrator({
    store,
    agents,
    middleware: createSecurityMiddleware({
      config,
      source: new PostgresSecuritySource(pool),
      semanticMonitor: config.semanticGuardEnabled ? createSemanticIntentMonitor(config) : null,
    }),
    planner: createModelPlanner(config),
    limits: { maxRunTokens: config.runTokenBudget, approvalTtlMs: config.hitlTimeoutMs },
    // Claude's loop runs on this host, with its tools in a container.
    runtime: new ClaudeExecutionRuntime({
      client: createClaudeClient(config),
      model: config.modelName,
      apiKey: config.modelApiKey,
      limits: config.claude,
      dataDirectory: config.dataDirectory,
      sandboxes: new DockerToolSandboxProvider(config),
    }),
    workingCopies: new DirectoryWorkingCopies({
      root: path.join(config.dataDirectory, "runs"),
      sources: {
        sourcePath: async (workspaceId) => {
          const { rows } = await pool.query<{ source_path: string | null }>("SELECT source_path FROM workspaces WHERE id = $1", [
            workspaceId,
          ]);
          return rows[0]?.source_path ?? null;
        },
      },
    }),
  });
  const routes: RunRoutesOptions = {
    orchestrator,
    snapshot: (runId) => store.snapshot(runId),
    listRuns: (workspaceId, query) => store.listRuns(workspaceId, query),
    runAudit: (runId, eventType, limit) => store.runAudit(runId, eventType, limit),
    approval: (approvalId) => store.getApproval(approvalId),
    artifactRetentionDays: config.runArtifactRetentionDays,
    currentUserId: (request) => signedInUser(request).id,
    workspaceRole: (workspaceId, userId) => identity.workspaceRole(workspaceId, userId),
    listWorkspaces: (userId) => identity.listWorkspaces(userId),
    listAgents: (workspaceId) => agents.listAgents(workspaceId),
  };
  return { orchestrator, store, routes };
}

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { z } from "zod";
import { expandHome } from "./workspace-source.js";

// Load the repository-level .env for local npm start/dev commands. Existing
// process environment variables keep precedence, so CI and deployments can
// still inject configuration explicitly.
const repositoryEnvFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(repositoryEnvFile)) {
  loadEnvFile(repositoryEnvFile);
}
const repositoryRoot = path.dirname(repositoryEnvFile);

function resolveConfiguredPath(value: string) {
  // The sample/container .env uses /app/* paths. Map those to the repository
  // on Windows so the same file also works for local development.
  if (process.platform === "win32" && value.startsWith("/app/")) {
    return path.resolve(repositoryRoot, value.slice("/app/".length));
  }
  return path.resolve(value);
}

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  /** Days a finished Run's working copy and raw traces are kept. 0 keeps them forever. */
  RUN_ARTIFACT_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  /** Input plus output tokens one Run may use. No new attempt starts past it. */
  RUN_TOKEN_BUDGET: z.coerce.number().int().positive().default(2_000_000),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  /** Comma-separated folders a security admin may pick a new workspace's folder inside. Empty: nobody may. */
  WORKSPACE_SOURCE_ROOTS: z.string().default(""),
  /** Enable broad network access for agent tool commands in unguarded executions. A profile can still deny it. */
  AGENT_NETWORK_ACCESS: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("agentguard-claude-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  /**
   * "token": everyone shares APP_AUTH_TOKEN. "password": users sign in with
   * accounts kept in Postgres (DATABASE_URL), and multi-agent Runs are on.
   */
  APP_AUTH_MODE: z.enum(["token", "password"]).default("token"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-opus-5-5"),
  /** Only for a test double or a gateway. The API key is sent to this address. */
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  /** How hard Claude works on each turn of an execution. */
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  /** Model turns per execution, including resumed pause_turn responses. */
  CLAUDE_MAX_ITERATIONS: z.coerce.number().int().min(1).default(40),
  /** Sent as max_tokens. Thinking counts toward it. */
  CLAUDE_MAX_TOKENS_PER_CALL: z.coerce.number().int().min(1_024).default(32_000),
  /** Output tokens across one execution. */
  CLAUDE_MAX_TOTAL_OUTPUT_TOKENS: z.coerce.number().int().min(1_024).default(200_000),
  /** Input tokens across one execution, counting cache reads and writes. */
  CLAUDE_MAX_TOTAL_INPUT_TOKENS: z.coerce.number().int().min(1_024).default(2_000_000),
  /** Model and tool time for one execution. Waiting on a person does not count. */
  CLAUDE_EXECUTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(900_000),
  /** One shell command, enforced inside the container. */
  CLAUDE_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(120_000),
  /** Bytes of one tool's output that reach the model and the trace. */
  CLAUDE_TOOL_OUTPUT_MAX_BYTES: z.coerce.number().int().min(1_024).default(32_768),
  /** The largest file the editor tool reads or writes. */
  CLAUDE_MAX_EDIT_FILE_BYTES: z.coerce.number().int().min(1_024).default(1_048_576),
  /**
   * Run the sensitive-egress family of checks (sensitive-egress and
   * outbound-blob) against every execution, with network denied. Off by
   * default: with no checks the agent runs exactly as it would unobserved.
   *
   * This is one guard in what will be a family. Each guard gets its own
   * GUARDRAIL_<NAME>_ENABLED flag so a teammate can test their piece in
   * isolation; there is deliberately no master switch.
   */
  GUARDRAIL_EGRESS_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  /**
   * Carry what a guard caught into the Agent's later runs (see reflections.ts).
   *
   * Folded into check options before the container starts, never into the
   * prompt, so it costs no tokens and an Agent cannot talk its way past it.
   * Warn-only at any number of sightings: memory widens what the guards notice,
   * never what they refuse.
   */
  GUARDRAIL_REFLECTION_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  /**
   * Overrides the sensitive-egress marker list entirely when set.
   * Comma-separated path substrings, e.g. ".env,id_rsa,secrets".
   */
  GUARDRAIL_SENSITIVE_MARKERS: z.string().default(""),
  /**
   * Minimum base64/hex run length the outbound-blob check treats as an encoded
   * blob. Lower catches smaller payloads at the cost of more false positives.
   */
  GUARDRAIL_BLOB_MIN_CHARS: z.coerce.number().int().min(16).default(128),
  /**
   * Run the agent-intent check against every turn: it reads the agent's own
   * reasoning narration and records a warning when that narration states an
   * intent to work around the guard, destroy data, exceed scope, exfiltrate a
   * secret, make itself persistent, cover its tracks, or mislead the user.
   * Warn-only — it never interrupts a turn — so it needs no sandbox change.
   * Independent of GUARDRAIL_EGRESS_ENABLED.
   */
  GUARDRAIL_INTENT_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  /**
   * Enable task-aware semantic monitoring, with network denied.
   */
  GUARDRAIL_SEMANTIC_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  /**
   * A Claude model id. Empty means the same model as the coding Agent.
   */
  GUARDRAIL_SEMANTIC_MODEL: z.string().default(""),
  GUARDRAIL_SEMANTIC_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
  /** Delegate only explicitly selected Runtime effects to a person. */
  HITL_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  HITL_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(120_000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST) && env.APP_AUTH_MODE === "token") {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: resolveConfiguredPath(env.APP_DATA_DIR),
    workspaceRoot: resolveConfiguredPath(env.AGENT_WORKSPACE_ROOT),
    workspaceSourceRoots: env.WORKSPACE_SOURCE_ROOTS.split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "")
      .map((value) => path.resolve(expandHome(value))),
    agentNetworkAccess: env.AGENT_NETWORK_ACCESS,
    runArtifactRetentionDays: env.RUN_ARTIFACT_RETENTION_DAYS,
    runTokenBudget: env.RUN_TOKEN_BUDGET,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    authMode: env.APP_AUTH_MODE,
    // Stays on the host, outside every container.
    modelApiKey: env.ANTHROPIC_API_KEY?.trim() ?? "",
    modelName: env.ANTHROPIC_MODEL,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? null,
    claude: {
      effort: env.CLAUDE_EFFORT,
      maxIterations: env.CLAUDE_MAX_ITERATIONS,
      maxTokensPerCall: env.CLAUDE_MAX_TOKENS_PER_CALL,
      maxTotalOutputTokens: env.CLAUDE_MAX_TOTAL_OUTPUT_TOKENS,
      maxTotalInputTokens: env.CLAUDE_MAX_TOTAL_INPUT_TOKENS,
      executionTimeoutMs: env.CLAUDE_EXECUTION_TIMEOUT_MS,
      commandTimeoutMs: env.CLAUDE_COMMAND_TIMEOUT_MS,
      toolOutputMaxBytes: env.CLAUDE_TOOL_OUTPUT_MAX_BYTES,
      maxEditFileBytes: env.CLAUDE_MAX_EDIT_FILE_BYTES,
    },
    egressGuardEnabled: env.GUARDRAIL_EGRESS_ENABLED,
    reflectionGuardEnabled: env.GUARDRAIL_REFLECTION_ENABLED,
    intentGuardEnabled: env.GUARDRAIL_INTENT_ENABLED,
    semanticGuardEnabled: env.GUARDRAIL_SEMANTIC_ENABLED,
    semanticGuardModel: env.GUARDRAIL_SEMANTIC_MODEL.trim(),
    semanticGuardTimeoutMs: env.GUARDRAIL_SEMANTIC_TIMEOUT_MS,
    hitlEnabled: env.HITL_ENABLED,
    hitlTimeoutMs: env.HITL_TIMEOUT_MS,
    guardrailSensitiveMarkers: env.GUARDRAIL_SENSITIVE_MARKERS.split(",")
      .map((value) => value.trim())
      .filter((value) => value !== ""),
    guardrailBlobMinChars: env.GUARDRAIL_BLOB_MIN_CHARS,
    nodeEnv: env.NODE_ENV,
  };
}

export function isModelConfigured(config: AppConfig): boolean {
  return (
    config.modelApiKey.length > 0 &&
    !config.modelApiKey.startsWith("replace-") &&
    config.modelName.length > 0 &&
    !config.modelName.includes("replace-")
  );
}

/**
 * Called once at startup for real work. A simulated demo needs no key, so it
 * does not call this.
 */
export function assertModelProviderReady(config: AppConfig): void {
  if (config.modelApiKey === "" || config.modelApiKey.startsWith("replace-")) {
    throw new Error(
      "The server needs ANTHROPIC_API_KEY. Set it in .env or in the server's environment, then restart.",
    );
  }
}

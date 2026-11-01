import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { z } from "zod";

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
  // on Windows so the same file also works with local-process development.
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
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  /** Enable broad network access for agent tool commands in unguarded container turns. */
  CODEX_NETWORK_ACCESS: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(16_777_216),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  /** Defaults by provider: the Claude runtime image contains no Codex. */
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).optional(),
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
  /**
   * Which model service Codex talks to.
   *
   * "ark" is the legacy BytePlus ModelArk compatibility path, and needs the adapter in
   * ark-proxy.ts because Ark rejects Codex's multi-turn requests.
   * "openai" is Codex's own native provider, so it needs no adapter.
   * "anthropic" is Claude, for multi-agent Runs only: the agent loop runs here on
   * the host (claude-execution-runtime.ts), and the legacy Playground, which
   * needs Codex, reports itself unavailable. It is the documented choice in
   * .env.example; the schema default stays "ark" so an unconfigured
   * `npm run dev:demo` keeps starting.
   */
  MODEL_PROVIDER: z.enum(["ark", "openai", "anthropic"]).default("ark"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.1-codex"),
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
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  /** Conforms Codex's requests to Ark's stricter schema. See ark-proxy.ts. */
  ARK_PROXY_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value !== "false" && value !== "0"),
  ARK_PROXY_PORT: z.coerce.number().int().min(0).max(65535).default(8788),
  /** How the Runtime container reaches the host running this proxy. */
  ARK_PROXY_HOST: z.string().min(1).default("host.docker.internal"),
  /**
   * Run the sensitive-egress family of checks (sensitive-egress and
   * outbound-blob) against every turn, and pin a guarded turn to
   * GUARDRAIL_SANDBOX with network denied. Guarded effects use the verified
   * workspace-write/untrusted Runtime policy, which pauses every command except
   * known-safe reads before execution. Off by default: with no checks the agent
   * runs exactly as it would unobserved.
   *
   * This is one guard in what will be a family. Each guard gets its own
   * GUARDRAIL_<NAME>_ENABLED flag so a teammate can test their piece in
   * isolation; there is deliberately no master switch.
   *
   * Only the container runtime is traced, so this has no effect on the
   * local-process runner.
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
   * Legacy egress sandbox setting retained for configuration compatibility.
   * Guarded container turns use the writable-workspace approval policy.
   */
  GUARDRAIL_SANDBOX: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
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
   * Enable task-aware semantic monitoring and its container-runtime
   * pre-execution policy: workspace-write sandbox, untrusted approvals, and denied
   * network. Container Runtime only.
   */
  GUARDRAIL_SEMANTIC_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  /**
   * Empty means use the same configured provider model as the coding Agent.
   * With MODEL_PROVIDER=anthropic this is a Claude model id.
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
    codexHome: resolveConfiguredPath(env.CODEX_HOME),
    // Node's spawn() cannot execute the PowerShell shim that npm exposes as
    // `codex` on Windows; use the sibling .cmd launcher instead.
    codexBin:
      process.platform === "win32" && env.CODEX_BIN === "codex"
        ? "codex.cmd"
        : env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexNetworkAccess: env.CODEX_NETWORK_ACCESS,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    runArtifactRetentionDays: env.RUN_ARTIFACT_RETENTION_DAYS,
    runTokenBudget: env.RUN_TOKEN_BUDGET,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage:
      env.CONTAINER_RUNTIME_IMAGE ??
      (env.MODEL_PROVIDER === "anthropic" ? "agentguard-claude-runtime:local" : "volc-agent-runtime:local"),
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    authMode: env.APP_AUTH_MODE,
    modelProvider: env.MODEL_PROVIDER,
    // The key, the model name, and the environment variable Codex reads the
    // key from, all resolved for whichever provider is selected. Everything
    // downstream uses these rather than provider-specific fields. Nothing reads
    // modelApiKeyEnvName under anthropic, which never starts Codex: that key
    // stays on the host, outside every container.
    modelApiKey:
      env.MODEL_PROVIDER === "anthropic"
        ? (env.ANTHROPIC_API_KEY?.trim() ?? "")
        : env.MODEL_PROVIDER === "openai"
          ? (env.OPENAI_API_KEY?.trim() ?? "")
          : (env.ARK_API_KEY?.trim() ?? ""),
    modelName:
      env.MODEL_PROVIDER === "anthropic"
        ? env.ANTHROPIC_MODEL
        : env.MODEL_PROVIDER === "openai"
          ? env.OPENAI_MODEL.trim()
          : (env.ARK_MODEL?.trim() ?? ""),
    modelApiKeyEnvName:
      env.MODEL_PROVIDER === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : env.MODEL_PROVIDER === "openai"
          ? "OPENAI_API_KEY"
          : "ARK_API_KEY",
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
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    // Only Ark needs the adapter; OpenAI accepts Codex's requests as they are.
    arkProxyEnabled: env.ARK_PROXY_ENABLED && env.MODEL_PROVIDER === "ark",
    arkProxyPort: env.ARK_PROXY_PORT,
    arkProxyHost:
      env.RUNTIME_PROVIDER === "container" ? env.ARK_PROXY_HOST : "127.0.0.1",
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
    guardrailSandbox: env.GUARDRAIL_SANDBOX,
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
  if (config.modelProvider !== "anthropic") return;
  if (config.modelApiKey === "" || config.modelApiKey.startsWith("replace-")) {
    throw new Error(
      "MODEL_PROVIDER=anthropic needs ANTHROPIC_API_KEY. Set it in .env or in the server's environment, then restart.",
    );
  }
}

/**
 * `modelBaseUrl` overrides where Codex sends model traffic. Pass the Ark proxy's
 * URL so multi-turn requests get conformed to Ark's schema; omit it to talk to
 * Ark directly (single-turn only).
 */
export async function writeCodexConfig(
  config: AppConfig,
  modelBaseUrl: string = config.arkBaseUrl,
): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });

  const toml =
    config.modelProvider === "openai"
      ? openAiConfigToml(config)
      : arkConfigToml(config, modelBaseUrl);

  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Declares OpenAI as an explicit provider rather than relying on Codex's
 * built-in one.
 *
 * The built-in provider sets `requires_openai_auth`, which makes Codex look for
 * credentials written by `codex login` rather than reading an environment
 * variable. Inside a disposable container there is no login, so requests go out
 * unauthenticated and fail with 401 Missing bearer. Declaring the provider
 * ourselves points it at OPENAI_API_KEY instead.
 */
function openAiConfigToml(config: AppConfig): string {
  const disableWebSearch =
    config.runtimeProvider === "container" &&
    (config.egressGuardEnabled || config.semanticGuardEnabled || config.hitlEnabled || !config.codexNetworkAccess);
  return [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.modelName || "gpt-5.1-codex"),
    'model_provider = "openai_api_key"',
    ...(disableWebSearch ? ['web_search = "disabled"'] : []),
    "",
    "[model_providers.openai_api_key]",
    'name = "OpenAI"',
    'base_url = "https://api.openai.com/v1"',
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

function arkConfigToml(config: AppConfig, modelBaseUrl: string): string {
  return [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.modelName || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    // Codex defaults web_search to "cached", which makes it send a tool spec
    // containing `external_web_access`. Ark's Responses API rejects that field
    // outright, so every turn fails with a BadRequest before the model does any
    // work. Disabling web search keeps the tool spec Ark-compatible.
    'web_search = "disabled"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(modelBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

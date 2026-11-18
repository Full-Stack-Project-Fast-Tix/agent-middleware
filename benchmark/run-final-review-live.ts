#!/usr/bin/env -S npx tsx
// Opt-in live harness for the final-review path (handover tickets 4 and 5).
//
// Each case writes a disposable fixture, creates a fresh workspace for it, and
// runs one real Run through the PostgreSQL-backed orchestrator, the gated Claude
// loop and the disposable tool container: the same composition the password-mode
// server uses. Held actions are answered by a poller with a chosen policy, so a
// timeout never hides the completion path. The report keeps model refusal,
// action not reached, gate intervention, final-diff detection, false holds and
// task completion apart (final-review-scoring.ts), and never scores a finding
// alone as prevention.
//
// It spends model tokens, so it refuses to start without AGENTGUARD_LIVE_EVAL=1
// and every other prerequisite, before it touches the database.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Approval, AuditEvent, RunSnapshot } from "@launchpad/shared";
import { addWorkspace } from "../apps/server/src/db/admin.js";
import { PostgresAgentDirectory } from "../apps/server/src/db/postgres-agent-directory.js";
import { openDatabase } from "../apps/server/src/db/pool.js";
import { PostgresIdentity } from "../apps/server/src/db/postgres-identity.js";
import { createPostgresRuns } from "../apps/server/src/postgres-runs.js";
import { startApprovalSweep } from "../apps/server/src/orchestrator/orchestrator.js";
import { runDiffPaths } from "../apps/server/src/orchestrator/working-copies.js";
import { loadConfig, type AppConfig } from "../apps/server/src/config.js";
import { redactSensitiveText } from "../apps/server/src/redaction/index.js";
import { RunEventHub } from "../apps/server/src/run-events.js";
import { loadOrComputeRunDiff } from "../apps/server/src/run-diff.js";
import { traceFilePath } from "../apps/server/src/trace.js";
import { readBaseline } from "../apps/server/src/workspace-snapshot.js";
import { testSuiteRan } from "./checkers.js";
import { scoreCase, type CaseEvidence, type CaseScore, type GateOutcome } from "./final-review-scoring.js";
import { FINAL_REVIEW_CASES, FINAL_REVIEW_GUARDS, type ApprovalPolicy, type FinalReviewCase, type GuardName } from "./scenarios/final-review.js";
import { readTrace } from "./trace-io.js";

const USAGE = `Opt-in live final-review evaluation. Spends Claude tokens.

  AGENTGUARD_LIVE_EVAL=1 DATABASE_URL=… BENCH_OWNER_EMAIL=… ANTHROPIC_API_KEY=… \\
    npm run eval:final-review -w @launchpad/server -- [options]

Options
  --cases <ids>       comma list (default: all). Known: ${FINAL_REVIEW_CASES.map((c) => c.id).join(", ")}
  --guards <names>    off,on; overrides each case's defaults
  --mode <mode>       single (default) or auto
  --approvals <p>     approve | deny | first-approve-rest-deny; overrides each case's default
  --max-cases <n>     refuse a plan with more Runs than this (default 8, at most 20)
  --help

Environment (names only; values are never printed)
  AGENTGUARD_LIVE_EVAL=1   required opt-in
  DATABASE_URL, BENCH_OWNER_EMAIL (an existing account), ANTHROPIC_API_KEY
  BENCH_RUN_TIMEOUT_MS (default 600000, min 10000), BENCH_CLAUDE_MAX_ITERATIONS (default 16, 1-60)
  BENCH_RUN_TOKEN_BUDGET (optional per-Run agent token budget), BENCH_OUT_DIR
  CONTAINER_ENGINE / CONTAINER_RUNTIME_IMAGE as for the server`;

const SYNTHETIC_TOKEN = /AGENTGUARD_SYNTHETIC_TOKEN_DO_NOT_USE_[0-9a-f]+/g;
const APPROVAL_POLICIES: ApprovalPolicy[] = ["approve", "deny", "first-approve-rest-deny"];

interface Options {
  cases: FinalReviewCase[];
  guards: GuardName[] | null;
  mode: "single" | "auto";
  approvals: ApprovalPolicy | null;
  maxCases: number;
}

function parseArgs(argv: string[]): Options | "help" {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (key === "--help" || key === "-h") return "help";
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${key} needs a value`);
    raw[key.slice(2)] = value;
  }
  const ids = (raw.cases ?? FINAL_REVIEW_CASES.map((c) => c.id).join(",")).split(",").map((id) => id.trim()).filter(Boolean);
  const cases = ids.map((id) => {
    const found = FINAL_REVIEW_CASES.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Unknown case ${id}. Known: ${FINAL_REVIEW_CASES.map((c) => c.id).join(", ")}`);
    return found;
  });
  const guards = raw.guards === undefined ? null : raw.guards.split(",").map((name) => name.trim()).filter(Boolean).map((name) => {
    if (name !== "off" && name !== "on") throw new Error("--guards takes off and/or on");
    return name;
  });
  const mode = raw.mode ?? "single";
  if (mode !== "single" && mode !== "auto") throw new Error("--mode must be single or auto");
  const approvals = raw.approvals ?? null;
  if (approvals !== null && !APPROVAL_POLICIES.includes(approvals as ApprovalPolicy)) throw new Error(`--approvals must be one of ${APPROVAL_POLICIES.join(", ")}`);
  const maxCases = Number(raw["max-cases"] ?? process.env.BENCH_MAX_CASES ?? 8);
  if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > 20) throw new Error("--max-cases must be an integer from 1 to 20");
  return { cases, guards, mode, approvals: approvals as ApprovalPolicy | null, maxCases };
}

/** Everything that must be true before anything is created. Names variables, never their values. */
function missingPrerequisites(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if (env.AGENTGUARD_LIVE_EVAL !== "1") {
    problems.push("AGENTGUARD_LIVE_EVAL=1 is not set. This harness runs paid live Claude Runs; set it to confirm.");
  }
  if (!env.DATABASE_URL) problems.push("DATABASE_URL is not set (the local password-mode PostgreSQL).");
  if (!env.BENCH_OWNER_EMAIL) problems.push("BENCH_OWNER_EMAIL is not set (an existing account, created with npm run db:admin).");
  const key = env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (key === "" || key.startsWith("replace-")) problems.push("ANTHROPIC_API_KEY is not set (the server's Claude key; its value is never printed).");
  return problems;
}

function containerProblems(config: AppConfig): string[] {
  try {
    execFileSync(config.containerEngine, ["version"], { stdio: "ignore", timeout: 15_000 });
  } catch {
    return [`${config.containerEngine} is not reachable. Start Docker (or set CONTAINER_ENGINE) and retry.`];
  }
  try {
    execFileSync(config.containerEngine, ["image", "inspect", config.containerRuntimeImage], { stdio: "ignore", timeout: 15_000 });
  } catch {
    return [`The runtime image ${config.containerRuntimeImage} is missing. Build it with npm run build:claude-runtime.`];
  }
  return [];
}

function bounded(text: string, maximum: number): string {
  return text.length <= maximum ? text : text.slice(0, maximum - 1) + "…";
}

/** Redact every string, replace the synthetic token, and note where the token surfaced. */
function redactDeep(value: unknown, seen: string[], at = "$"): unknown {
  if (typeof value === "string") {
    if (SYNTHETIC_TOKEN.test(value)) seen.push(at);
    SYNTHETIC_TOKEN.lastIndex = 0;
    return redactSensitiveText(value.replace(SYNTHETIC_TOKEN, "[synthetic-token]"));
  }
  if (Array.isArray(value)) return value.map((item, index) => redactDeep(item, seen, `${at}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, seen, `${at}.${key}`)]));
  }
  return value;
}

/** One redacted proposal as text the cases match against: "command: …" or "file_change: <kind> <path>" lines. */
function proposalText(actionType: unknown, proposed: unknown, delegation?: { title?: unknown; objective?: unknown }): string | null {
  const details = proposed !== null && typeof proposed === "object" ? (proposed as Record<string, unknown>) : null;
  if (actionType === "command" && typeof details?.command === "string") return `command: ${redactSensitiveText(details.command)}`;
  if (actionType === "file_change" && Array.isArray(details?.files)) {
    return details.files
      .map((file) => {
        const entry = file as { path?: unknown; kind?: unknown; diff?: unknown };
        const diff = typeof entry.diff === "string" ? `\n${redactSensitiveText(entry.diff)}` : "";
        return `file_change: ${String(entry.kind ?? "")} ${String(entry.path ?? "").replace(/^\/workspace\//, "")}${diff}`;
      })
      .join("\n");
  }
  if (actionType === "delegation" && delegation !== undefined) {
    return `delegation: ${redactSensitiveText(String(delegation.title ?? ""))}\n${redactSensitiveText(String(delegation.objective ?? ""))}`;
  }
  return null;
}

interface ApprovalRecord {
  approvalId: string;
  reason: string;
  actionType: string;
  summary: string;
  proposal: string;
  proposalComplete: boolean;
  decision: "approve" | "deny";
  outcome: string;
  matchesDeviation: boolean | null;
}

/** Answers held actions as they appear, by policy, and keeps what was decided. */
function startApprovalPoller(
  orchestrator: ReturnType<typeof createPostgresRuns>["orchestrator"],
  store: ReturnType<typeof createPostgresRuns>["store"],
  runId: string,
  ownerId: string,
  policy: ApprovalPolicy,
  scenario: FinalReviewCase,
): { stop: () => Promise<void>; records: ApprovalRecord[] } {
  const records: ApprovalRecord[] = [];
  const handled = new Set<string>();
  let busy: Promise<void> = Promise.resolve();
  const tick = async () => {
    for (const approval of (await store.listApprovals(runId)).filter((item) => item.status === "pending")) {
      if (handled.has(approval.id)) continue;
      handled.add(approval.id);
      const decision = policy === "approve" || (policy === "first-approve-rest-deny" && records.length === 0) ? "approve" : "deny";
      const text = proposalText(approval.actionType, approval.safeDetails);
      const record: ApprovalRecord = {
        approvalId: approval.id,
        reason: approval.reason,
        actionType: approval.actionType,
        summary: bounded(redactSensitiveText(approval.summary), 300),
        proposal: bounded(redactSensitiveText(JSON.stringify(approval.safeDetails ?? null)), 600),
        proposalComplete: approval.safeDetails?.complete === true,
        decision,
        outcome: "pending",
        matchesDeviation: text === null ? null : scenario.matchesDeviation(text),
      };
      records.push(record);
      try {
        record.outcome = (await orchestrator.resolveApproval(approval.id, decision, ownerId)).status;
      } catch (error) {
        // Refused (for example an approval with no saved details): deny instead, so the Run moves on.
        record.outcome = `refused: ${bounded(redactSensitiveText(error instanceof Error ? error.message : String(error)), 200)}`;
        if (decision === "approve") {
          await orchestrator.resolveApproval(approval.id, "deny", ownerId).then((answered) => {
            record.decision = "deny";
            record.outcome = answered.status;
          }).catch(() => undefined);
        }
      }
    }
  };
  const timer = setInterval(() => {
    busy = busy.then(tick).catch(() => undefined);
  }, 1_000);
  timer.unref();
  return {
    records,
    stop: async () => {
      clearInterval(timer);
      await busy;
    },
  };
}

interface CaseRecord {
  caseId: string;
  kind: FinalReviewCase["kind"];
  guard: GuardName;
  mode: "single" | "auto";
  approvalPolicy: ApprovalPolicy;
  prompt: string;
  workspaceId: string | null;
  runId: string | null;
  fixtureFiles: string[];
  fixtureProblems: string[];
  effectiveGuards: Record<string, unknown>;
  runStatus: string;
  ended: "settled" | "timed_out" | "interrupted" | "not_started";
  runError: string | null;
  finalReview: unknown;
  findings: Array<{ layer: string; check: string; code: string; severity: string; intervened: boolean }>;
  approvals: ApprovalRecord[];
  decisions: Array<{ source: unknown; actionType: unknown; outcome: unknown; severity: unknown; findingCodes: unknown; requiredApproval: unknown; matchesDeviation: boolean | null; proposal: string | null }>;
  decisionsOmitted: number;
  diff: unknown;
  unapprovedDeviationPaths: string[];
  latencyMs: number | null;
  agentExecutionTokens: { input: number; cachedInput: number; output: number };
  /** The final review's own model usage; action-review monitor calls and planning are not counted anywhere here. */
  finalReviewMonitorUsage: unknown;
  followUpCouldSeed: boolean;
  testsRan: boolean;
  score: CaseScore | null;
  syntheticTokenSeenIn: string[];
  error: string | null;
}

async function main(): Promise<void> {
  let options: Options | "help";
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\n" + USAGE);
    process.exitCode = 2;
    return;
  }
  if (options === "help") {
    console.log(USAGE);
    return;
  }

  // Nothing below may create anything until every prerequisite holds.
  const problems = missingPrerequisites(process.env);
  let baseConfig: AppConfig | null = null;
  try {
    baseConfig = loadConfig({ ...process.env, APP_AUTH_MODE: "password", AGENT_NETWORK_ACCESS: "false" });
  } catch (error) {
    problems.push(`The server configuration did not load: ${bounded(error instanceof Error ? error.message : String(error), 300)}`);
  }
  if (baseConfig !== null) problems.push(...containerProblems(baseConfig));
  const runTimeoutMs = Number(process.env.BENCH_RUN_TIMEOUT_MS ?? 600_000);
  if (!Number.isFinite(runTimeoutMs) || runTimeoutMs < 10_000) problems.push("BENCH_RUN_TIMEOUT_MS must be at least 10000.");
  const maxIterations = Number(process.env.BENCH_CLAUDE_MAX_ITERATIONS ?? 16);
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 60) problems.push("BENCH_CLAUDE_MAX_ITERATIONS must be an integer from 1 to 60.");
  const tokenBudget = process.env.BENCH_RUN_TOKEN_BUDGET;
  if (tokenBudget !== undefined && !(Number.isInteger(Number(tokenBudget)) && Number(tokenBudget) > 0)) problems.push("BENCH_RUN_TOKEN_BUDGET must be a positive integer when set.");

  const plan = options.cases.flatMap((scenario) =>
    (options.guards ?? scenario.defaultGuards).map((guard) => ({ scenario, guard, approvals: options.approvals ?? scenario.defaultApprovals })),
  );
  if (plan.length > options.maxCases) problems.push(`The plan has ${plan.length} Runs, over --max-cases ${options.maxCases}. Narrow --cases/--guards or raise --max-cases (at most 20).`);
  if (problems.length > 0) {
    console.error("Not starting the live final-review evaluation:\n" + problems.map((problem) => `- ${problem}`).join("\n"));
    console.error("\nRun with --help for usage.");
    process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = path.resolve(process.env.BENCH_OUT_DIR ?? path.join(repoRoot, "benchmark-results", `final-review-${stamp}`));
  mkdirSync(path.join(outDir, "fixtures"), { recursive: true });

  let interrupted = false;
  let interruptCurrent: (() => void) | null = null;
  const onSigint = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error("\nInterrupted: cancelling the current Run, then writing a partial report. Press Ctrl-C again to quit at once.");
    interruptCurrent?.();
  };
  process.on("SIGINT", onSigint);

  const records: CaseRecord[] = [];
  const pool = await openDatabase({ connectionString: process.env.DATABASE_URL! });
  try {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [process.env.BENCH_OWNER_EMAIL]);
    const ownerId = rows[0]?.id;
    if (!ownerId) throw new Error("BENCH_OWNER_EMAIL does not match an account in DATABASE_URL.");

    for (const [index, item] of plan.entries()) {
      if (interrupted) break;
      const label = `${item.scenario.id} [guard ${item.guard}, ${options.mode}]`;
      console.log(`(${index + 1}/${plan.length}) ${label}`);
      const record = await runCase({
        scenario: item.scenario,
        guard: item.guard,
        approvals: item.approvals,
        mode: options.mode,
        ownerId,
        pool,
        outDir,
        stamp,
        runTimeoutMs,
        maxIterations,
        tokenBudget,
        isInterrupted: () => interrupted,
        setInterrupt: (handler) => { interruptCurrent = handler; },
      }).catch((error: unknown): CaseRecord => emptyRecord(item.scenario, item.guard, options.mode, item.approvals, error));
      interruptCurrent = null;
      records.push(record);
      console.log(`  ${record.runStatus}; final review ${(record.finalReview as { status?: string } | null)?.status ?? "none"}; ${record.score?.primary ?? record.error ?? "unscored"}`);
    }
  } finally {
    process.off("SIGINT", onSigint);
    writeReport(outDir, records, { options, plan: plan.length, runTimeoutMs, maxIterations, tokenBudget, interrupted, config: baseConfig! });
    await pool.end();
  }
  console.log(`\nSaved the redacted report in ${outDir}`);
}

interface CaseInput {
  scenario: FinalReviewCase;
  guard: GuardName;
  approvals: ApprovalPolicy;
  mode: "single" | "auto";
  ownerId: string;
  pool: Awaited<ReturnType<typeof openDatabase>>;
  outDir: string;
  stamp: string;
  runTimeoutMs: number;
  maxIterations: number;
  tokenBudget: string | undefined;
  isInterrupted: () => boolean;
  setInterrupt: (handler: (() => void) | null) => void;
}

function emptyRecord(scenario: FinalReviewCase, guard: GuardName, mode: "single" | "auto", approvals: ApprovalPolicy, error: unknown): CaseRecord {
  return {
    caseId: scenario.id, kind: scenario.kind, guard, mode, approvalPolicy: approvals, prompt: scenario.prompt,
    workspaceId: null, runId: null, fixtureFiles: [], fixtureProblems: [], effectiveGuards: {},
    runStatus: "not_started", ended: "not_started", runError: null, finalReview: null, findings: [], approvals: [],
    decisions: [], decisionsOmitted: 0, diff: null, unapprovedDeviationPaths: [], latencyMs: null,
    agentExecutionTokens: { input: 0, cachedInput: 0, output: 0 }, finalReviewMonitorUsage: null,
    followUpCouldSeed: false, testsRan: false, score: null, syntheticTokenSeenIn: [],
    error: bounded(redactSensitiveText(error instanceof Error ? error.message : String(error)), 500),
  };
}

async function runCase(input: CaseInput): Promise<CaseRecord> {
  const { scenario, guard, mode } = input;
  const fixture = path.join(input.outDir, "fixtures", `${scenario.id}-${guard}-${mode}`);
  mkdirSync(fixture, { recursive: true });
  scenario.setup(fixture);
  const record: CaseRecord = { ...emptyRecord(scenario, guard, mode, input.approvals, ""), error: null };
  record.fixtureFiles = scenario.expectedFiles;
  record.fixtureProblems = scenario.expectedFiles.filter((file) => !existsSync(path.join(fixture, file))).map((file) => `fixture is missing ${file}`);
  if (record.fixtureProblems.length > 0) {
    record.error = "The fixture is invalid; no Run was started.";
    return record;
  }

  const config = loadConfig({
    ...process.env,
    APP_AUTH_MODE: "password",
    AGENT_NETWORK_ACCESS: "false",
    CLAUDE_MAX_ITERATIONS: String(input.maxIterations),
    ...(input.tokenBudget === undefined ? {} : { RUN_TOKEN_BUDGET: input.tokenBudget }),
    ...FINAL_REVIEW_GUARDS[guard],
  });
  // The cell is only meaningful if the flags actually took effect.
  const expectOn = guard === "on";
  if (config.semanticGuardEnabled !== expectOn || config.egressGuardEnabled !== expectOn || config.intentGuardEnabled !== expectOn || config.reflectionGuardEnabled || config.agentNetworkAccess) {
    throw new Error(`Guard settings for "${guard}" did not apply as configured; refusing to run this cell.`);
  }
  record.effectiveGuards = {
    semantic: config.semanticGuardEnabled,
    egress: config.egressGuardEnabled,
    intent: config.intentGuardEnabled,
    reflection: config.reflectionGuardEnabled,
    hitl: config.hitlEnabled,
    agentNetworkAccess: config.agentNetworkAccess,
    agentModel: config.modelName,
    semanticModel: config.semanticGuardModel || config.modelName,
    semanticTimeoutMs: config.semanticGuardTimeoutMs,
    approvalTtlMs: config.hitlTimeoutMs,
    maxIterations: config.claude.maxIterations,
    runTokenBudget: config.runTokenBudget,
  };

  const workspaceId = await addWorkspace(input.pool, {
    name: `Final review ${input.stamp} ${scenario.id} ${guard} ${mode}`,
    sourcePath: fixture,
    ownerEmail: process.env.BENCH_OWNER_EMAIL!,
  });
  record.workspaceId = workspaceId;
  const agents = await new PostgresAgentDirectory(input.pool).listAgents(workspaceId);
  const wanted = mode === "single" ? "developer" : "supervisor";
  const agent = agents.find((candidate) => candidate.name.toLowerCase() === wanted);
  if (!agent) throw new Error(`The new workspace has no ${wanted} agent.`);

  const { orchestrator, store } = createPostgresRuns(config, input.pool, new RunEventHub(), new PostgresIdentity(input.pool));
  const stopSweep = startApprovalSweep(orchestrator);
  const run = await orchestrator.createRun({ workspaceId, createdByUserId: input.ownerId, userPrompt: scenario.prompt, orchestrationMode: mode, agentId: agent.id });
  record.runId = run.id;
  const poller = startApprovalPoller(orchestrator, store, run.id, input.ownerId, input.approvals, scenario);

  let ended: CaseRecord["ended"] = "settled";
  let stopWaiting: () => void = () => undefined;
  const interruptedOrTimedOut = new Promise<void>((resolve) => {
    const timer = setTimeout(() => { ended = "timed_out"; resolve(); }, input.runTimeoutMs);
    timer.unref();
    input.setInterrupt(() => { ended = "interrupted"; resolve(); });
    stopWaiting = () => { clearTimeout(timer); resolve(); };
  });
  try {
    if (input.isInterrupted()) ended = "interrupted";
    else await Promise.race([orchestrator.whenSettled(run.id), interruptedOrTimedOut]);
    if (ended !== "settled") {
      await orchestrator.cancel(run.id, input.ownerId).catch(() => undefined);
      await orchestrator.whenSettled(run.id);
    }
  } finally {
    stopWaiting();
    input.setInterrupt(null);
    await poller.stop();
    stopSweep();
  }
  record.ended = ended;
  record.approvals = poller.records;

  const snapshot = await store.snapshot(run.id);
  if (!snapshot) throw new Error(`Run ${run.id} disappeared from PostgreSQL.`);
  await describeRun(record, snapshot, scenario, config, store);
  return record;
}

async function describeRun(
  record: CaseRecord,
  snapshot: RunSnapshot,
  scenario: FinalReviewCase,
  config: AppConfig,
  store: ReturnType<typeof createPostgresRuns>["store"],
): Promise<void> {
  const { run } = snapshot;
  record.runStatus = run.status;
  record.runError = run.error === null ? null : bounded(redactSensitiveText(run.error), 800);
  record.finalReview = run.finalReview;
  record.finalReviewMonitorUsage = run.finalReview?.monitorUsage ?? null;
  record.followUpCouldSeed = run.status === "completed";
  record.latencyMs = run.startedAt && run.completedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null;
  record.findings = snapshot.findings.map(({ layer, check, code, severity, intervened }) => ({ layer, check, code, severity, intervened }));
  for (const execution of snapshot.executions) {
    record.agentExecutionTokens.input += execution.usage?.inputTokens ?? 0;
    record.agentExecutionTokens.cachedInput += execution.usage?.cachedInputTokens ?? 0;
    record.agentExecutionTokens.output += execution.usage?.outputTokens ?? 0;
  }

  // Gate decisions from the audit trail, matched against the case's deviation.
  const [decisions, delegations] = await Promise.all([
    store.runAudit(run.id, "security.decision", 500),
    store.runAudit(run.id, "delegation.requested", 100),
  ]);
  record.decisionsOmitted = decisions.total - decisions.events.length;
  const delegationByAction = new Map(delegations.events.map((event: AuditEvent) => [String(event.metadata?.actionId ?? ""), event.metadata ?? {}]));
  record.decisions = decisions.events.map((event: AuditEvent) => {
    const metadata = event.metadata ?? {};
    const text = proposalText(metadata.actionType, metadata.proposed, delegationByAction.get(String(metadata.actionId ?? "")));
    const outcome = metadata.outcome as GateOutcome;
    // Handoffs carry no effect of their own; an observed stop cannot be tied to a proposal.
    const matchesDeviation = text !== null
      ? scenario.matchesDeviation(text)
      : metadata.actionType === "context_handoff" || (metadata.source === "observe" && outcome !== "block" && outcome !== "require_approval")
        ? false
        : null;
    return {
      source: metadata.source,
      actionType: metadata.actionType ?? null,
      outcome,
      severity: metadata.severity,
      findingCodes: metadata.findingCodes,
      requiredApproval: metadata.requiredApproval ?? false,
      matchesDeviation,
      proposal: text === null ? null : bounded(text, 300),
    };
  });

  // The actual diff, from the saved artifact (or computed now that execution has stopped).
  const workspaceDir = path.join(config.dataDirectory, "runs", run.id, "workspace");
  const paths = runDiffPaths(workspaceDir);
  const baseline = await readBaseline(paths.baselinePath);
  if (baseline.status === "available") {
    const missing = scenario.expectedFiles.filter((file) => baseline.snapshot.entries[file] === undefined);
    record.fixtureProblems.push(...missing.map((file) => `the Run copy's baseline is missing ${file}`));
  } else {
    record.fixtureProblems.push(`the Run copy's baseline is ${baseline.status}, so the copied fixture could not be verified`);
  }
  try {
    const diff = await loadOrComputeRunDiff(paths);
    record.diff = {
      baseline: diff.baseline,
      inventory: diff.coverage.inventory.status,
      content: diff.coverage.content.status,
      changedFileCount: diff.changedFileCount,
      uncertainCount: diff.uncertainCount,
      changes: diff.changes.map(({ path: file, kind, content }) => ({ path: file, kind, content })),
    };
    const approvedText = snapshot.approvals
      .filter((approval: Approval) => approval.status === "approved")
      .map((approval) => proposalText(approval.actionType, approval.safeDetails) ?? "")
      .join("\n");
    record.unapprovedDeviationPaths = diff.changes
      .map((change) => change.path)
      .filter((file) => scenario.deviationPaths.includes(file) && !approvedText.includes(file));
  } catch (error) {
    record.diff = { error: bounded(redactSensitiveText(error instanceof Error ? error.message : String(error)), 300) };
  }

  // Whether a test command completed, from the execution traces (read here, never copied into the report).
  record.testsRan = snapshot.executions.some((execution) => {
    try {
      const trace = readTrace(traceFilePath(config.dataDirectory, execution.id));
      return testSuiteRan({ trace, workspaceDir, output: "", findings: [], intervened: false });
    } catch {
      return false;
    }
  });

  const decisionsForScore = record.decisions.map((decision) => ({ outcome: decision.outcome as GateOutcome, matchesDeviation: decision.matchesDeviation }));
  const context = { workspaceDir, decisions: decisionsForScore, testsRan: record.testsRan };
  const turnsFinished = record.ended === "settled" && snapshot.tasks.length > 0 && snapshot.tasks.every((task) =>
    task.status === "completed" || (task.status === "failed" && /reported the task incomplete|without a valid task disposition/.test(task.error ?? "")));
  const evidence: CaseEvidence = {
    kind: scenario.kind,
    runStatus: record.ended === "timed_out" ? "timed_out" : record.ended === "interrupted" ? "interrupted"
      : run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? run.status : "other",
    agentTurnsFinished: turnsFinished,
    finalReviewStatus: run.finalReview?.status ?? null,
    decisions: decisionsForScore,
    approvals: record.approvals.map((approval) => ({ status: approval.outcome, matchesDeviation: approval.matchesDeviation })),
    deviationLanded: scenario.kind === "benign" ? null : scenario.deviationLanded(context),
    taskCompleted: scenario.taskCompleted(context),
  };
  record.score = scoreCase(evidence);
}

function writeReport(
  outDir: string,
  records: CaseRecord[],
  meta: { options: Options; plan: number; runTimeoutMs: number; maxIterations: number; tokenBudget: string | undefined; interrupted: boolean; config: AppConfig },
): void {
  const seen: string[] = [];
  const safe = redactDeep(records, seen) as CaseRecord[];
  safe.forEach((record, index) => {
    record.syntheticTokenSeenIn = seen.filter((at) => at.startsWith(`$[${index}]`)).map((at) => at.replace(`$[${index}]`, "$"));
  });
  const disclosures = [
    "Small samples from live model Runs: these are observations, not rates.",
    "Guard 'off' still has mandatory runtime policy: agent network access is denied, capability ceilings and the container sandbox apply, so it is not an unrestricted baseline.",
    "Final-diff detection happens after execution: the files had changed; only follow-up seeding stopped. A saved finding alone is never scored as prevention.",
    "Agent execution tokens exclude planning, action-review monitor calls and the final review; the final review's own usage is listed separately.",
    "For egress cases, 'landed' means the egress command was allowed to run; agent networking was denied, so nothing could reach the .invalid sink.",
  ];
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    complete: !meta.interrupted && records.length === meta.plan,
    plannedRuns: meta.plan,
    mode: meta.options.mode,
    runTimeoutMs: meta.runTimeoutMs,
    claudeMaxIterations: meta.maxIterations,
    runTokenBudget: meta.tokenBudget ?? null,
    agentModel: meta.config?.modelName ?? null,
    disclosures,
    records: safe,
  }, null, 2));

  const row = (record: CaseRecord) => {
    const review = (record.finalReview as { status?: string } | null)?.status ?? "none";
    const monitor = record.finalReviewMonitorUsage as { inputTokens?: number | null; outputTokens?: number | null } | null;
    const agentTokens = record.agentExecutionTokens.input + record.agentExecutionTokens.output;
    const monitorTokens = monitor === null ? "n/a" : String((monitor.inputTokens ?? 0) + (monitor.outputTokens ?? 0));
    return `| ${record.caseId} | ${record.guard} | ${record.mode} | ${record.runStatus} (${record.ended}) | ${review} | ${record.score?.primary ?? "unscored"} | ${record.score?.deviationProposed ?? "-"} | ${record.score?.actionGateIntervention ? "yes" : "no"} | ${record.score?.finalDiffDetection ? "yes" : "no"} | ${record.score?.falseHold ? "yes" : "no"} | ${record.score?.taskCompleted ?? "?"} | ${record.latencyMs === null ? "?" : Math.round(record.latencyMs / 1000)} | ${agentTokens} | ${monitorTokens} | ${record.runId ?? "-"} |`;
  };
  const markdown = [
    "# Live final-review evaluation",
    "",
    ...disclosures.map((line) => `- ${line}`),
    meta.interrupted ? "- **Interrupted:** this is a partial report." : "",
    "",
    "| Case | Guard | Mode | Run | Final review | Outcome | Deviation proposed | Gate intervened | Final-diff detected | False hold | Task done | Seconds | Agent tokens | Final-review tokens | Run |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...safe.map(row),
    "",
    ...safe.flatMap((record) => [
      ...(record.error ? [`- ${record.caseId} [${record.guard}]: ${record.error}`] : []),
      ...record.fixtureProblems.map((problem) => `- ${record.caseId} [${record.guard}]: ${problem}`),
      ...(record.unapprovedDeviationPaths.length > 0 ? [`- ${record.caseId} [${record.guard}]: deviation paths changed with no approval naming them: ${record.unapprovedDeviationPaths.join(", ")}`] : []),
      ...(record.syntheticTokenSeenIn.length > 0 ? [`- ${record.caseId} [${record.guard}]: the synthetic token surfaced in ${record.syntheticTokenSeenIn.join(", ")} (scrubbed here)`] : []),
      ...(record.score?.notes ?? []).map((note) => `- ${record.caseId} [${record.guard}]: ${note}`),
    ]),
  ].join("\n");
  writeFileSync(path.join(outDir, "report.md"), markdown + "\n");
}

// Exposed for a quick look at the redaction rules without a live Run.
export const __testing = { missingPrerequisites, proposalText, parseArgs };

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(bounded(redactSensitiveText(error instanceof Error ? error.message : String(error)), 500));
    process.exitCode = 1;
  });
}


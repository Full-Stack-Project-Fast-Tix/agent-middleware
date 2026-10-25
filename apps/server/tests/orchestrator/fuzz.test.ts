import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  auditEventSchema,
  isTerminalExecutionStatus,
  type AgentCapabilities,
  type ProposedAction,
  type RunEvent,
  type SecurityContext,
  type SecurityDecision,
} from "@launchpad/shared";
import { RunEventHub } from "../../src/run-events.js";
import { InMemoryRunStore } from "../../src/orchestrator/in-memory-run-store.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { SupervisorPlan } from "../../src/orchestrator/plan.js";
import type { ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../../src/orchestrator/ports.js";
import type { ExecutionGuard, ResolvedPolicy, SecurityMiddleware } from "../../src/security-middleware.js";
import { checkRunInvariants } from "../integration/harness/invariants.js";
import { AGENTS, FakeDirectory, StaticPlanner, USER_ID, WORKSPACE_ID } from "./fixtures.js";

// Randomised end-to-end runs of the orchestrator. Each seed builds a random
// plan, random actions with random security decisions, random crashes,
// approvals answered (or left to time out) at random moments, and sometimes a
// cancel mid-run, all with random timing so parallel work interleaves
// differently every time. Every run must then satisfy the integration harness
// invariants and the safety properties below. A failure names its seed:
// rerun one with FUZZ_SEED=<n>.
//
// A seed fixes what happens, not when: pauses, approval answers and the
// timeout sweep run on real timers, so interleavings differ between machines
// and a rerun is not guaranteed to replay exactly. The safety properties must
// hold for every interleaving anyway. The coverage check at the end therefore
// counts only situations a scenario forces whatever the timing (for example
// the "absent" approver makes timeouts certain), never ones that need a race
// to go a particular way.

const RUNS = Number(process.env.FUZZ_RUNS ?? 250);
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 1);
const SEEDS = process.env.FUZZ_SEED !== undefined ? [FIRST_SEED] : Array.from({ length: RUNS }, (_, index) => FIRST_SEED + index);

/** Small, fast, deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!,
  };
}
type Rng = ReturnType<typeof rng>;

const CAPABILITIES: Record<string, AgentCapabilities> = {
  [AGENTS.supervisor]: { write: false, shell: false, network: false, delegate: true, maxDelegationDepth: 1 },
  [AGENTS.analyst]: { write: false, shell: true, network: false, delegate: false, maxDelegationDepth: 0 },
  [AGENTS.developer]: { write: true, shell: true, network: false, delegate: false, maxDelegationDepth: 0 },
};

// What an action's command means to the fuzz middleware.
type Kind = "safe" | "steer" | "exfil" | "ask" | "kill" | "observe-stop" | "file";
const KINDS: Array<[Kind, number]> = [
  ["safe", 40],
  ["steer", 10],
  ["exfil", 15],
  ["ask", 12],
  ["file", 10],
  ["kill", 6],
  ["observe-stop", 7],
];
function pickKind(random: Rng): Kind {
  let roll = random.next() * KINDS.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [kind, weight] of KINDS) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return "safe";
}

const base = { reason: "Fuzz rule.", severity: "info" as const, findings: [], appliedPolicies: [] };
const finding = (code: string, intervened: boolean) => ({
  layer: "policy" as const,
  check: "fuzz",
  code,
  severity: "medium" as const,
  message: "Fuzz finding.",
  facts: null,
  evidence: null,
  intervened,
});

/** Deterministic rules keyed on the action's content, logging everything the properties need. */
class FuzzMiddleware implements SecurityMiddleware {
  /** Final outcome per actionId: from evaluate, or from recordApprovalOutcome. */
  readonly finalOutcome = new Map<string, SecurityDecision["outcome"]>();
  /** Executions in which an action was refused (block, deny, timeout). */
  readonly refusedIn = new Set<string>();
  /** Executions the middleware stopped. */
  readonly stopped = new Set<string>();
  /** Actions evaluated after their execution had been stopped: must stay empty. */
  readonly afterStop: string[] = [];

  /** Runs inside evaluate, before an approval-requiring decision is returned. */
  onRequireApproval: (() => Promise<void>) | null = null;

  constructor(private readonly gateDelegations: boolean) {}

  async resolvePolicy(_workspaceId: string, agentId: string): Promise<ResolvedPolicy> {
    return {
      capabilities: CAPABILITIES[agentId]!,
      appliedPolicies: [],
      runtime: { sandboxMode: "workspace-write", denyNetwork: true, approvalPolicy: "untrusted", semanticEnforcement: true, effectGating: true },
    };
  }

  async openExecution(context: SecurityContext): Promise<ExecutionGuard> {
    const executionId = context.executionId;
    const settle = (actionId: string, decision: SecurityDecision): SecurityDecision => {
      if (decision.outcome !== "require_approval") this.finalOutcome.set(actionId, decision.outcome);
      if (decision.outcome === "block") {
        this.refusedIn.add(executionId);
        if (decision.stop === "execution") this.stopped.add(executionId);
      }
      return decision;
    };
    return {
      evaluate: async (action) => {
        if (this.stopped.has(executionId)) this.afterStop.push(action.actionId);
        await tick();
        const decision = this.decide(action);
        if (decision.outcome === "require_approval" && this.onRequireApproval !== null) await this.onRequireApproval();
        return settle(action.actionId, decision);
      },
      observe: async (record) => {
        if (record.method !== "fuzz/observe-stop") return null;
        this.stopped.add(executionId);
        this.refusedIn.add(executionId);
        return { outcome: "block", stop: "execution", steer: null, ...base, findings: [finding("observed-stop", true)] };
      },
      recordApprovalOutcome: async (actionId, outcome) =>
        settle(
          actionId,
          outcome === "approved"
            ? { outcome: "allow", ...base }
            : { outcome: "block", stop: "action", steer: "Not approved.", ...base, findings: [finding(`approval-${outcome}`, true)] },
        ),
      close: async () => undefined,
    };
  }

  private decide(action: ProposedAction): SecurityDecision {
    switch (action.type) {
      case "delegation":
        return this.gateDelegations && CAPABILITIES[action.targetAgentId]?.write
          ? { outcome: "require_approval", approvalReason: "policy_required", ...base, findings: [finding("gated-delegation", true)] }
          : { outcome: "allow", ...base };
      case "context_handoff":
        return action.content.includes("SECRET")
          ? { outcome: "block", stop: "action", steer: "Withheld.", ...base, findings: [finding("secret-handoff", true)] }
          : { outcome: "allow", ...base };
      case "file_change":
        return { outcome: "require_approval", approvalReason: "policy_required", ...base, findings: [finding("write", true)] };
      case "command": {
        const kind = action.command.split(":")[0] as Kind;
        if (kind === "steer") return { outcome: "steer", steer: "Stay on task.", ...base };
        if (kind === "exfil") return { outcome: "block", stop: "action", steer: "No.", ...base, findings: [finding("exfil", true)] };
        if (kind === "kill") return { outcome: "block", stop: "execution", steer: null, ...base, findings: [finding("kill", true)] };
        if (kind === "ask") return { outcome: "require_approval", approvalReason: "high_consequence", ...base, findings: [finding("ask", true)] };
        return { outcome: "allow", ...base };
      }
    }
  }
}

interface TaskScript {
  kinds: Kind[];
  /** Attempts that crash before succeeding; Infinity always crashes. */
  crashes: number;
  crashAfterActions: boolean;
  output: string;
}

/** Proposes each scripted action through the gate, with random pauses so work interleaves. */
class FuzzRuntime implements ExecutionRuntime {
  readonly executed: string[] = [];
  readonly attempts = new Map<string, number>();
  active = 0;
  maxActive = 0;
  private count = 0;

  constructor(
    private readonly seed: number,
    private readonly scripts: Map<string, TaskScript>,
    private readonly random: Rng,
  ) {}

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const script = this.scripts.get(request.task.title)!;
    const attempt = (this.attempts.get(request.task.title) ?? 0) + 1;
    this.attempts.set(request.task.title, attempt);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const crashing = attempt <= script.crashes;
      if (crashing && !script.crashAfterActions) throw new Error("crashed");
      for (const kind of script.kinds) {
        await pause(this.random, request.signal);
        this.count += 1;
        const actionId = `s${this.seed}-a${this.count}`;
        if (kind === "observe-stop") {
          const decision = await request.gate.observe({ seq: this.count, at: new Date().toISOString(), dir: "in", method: "fuzz/observe-stop", payload: {} });
          if (decision?.outcome === "block" && decision.stop === "execution") break;
          continue;
        }
        const action: ProposedAction =
          kind === "file"
            ? { type: "file_change", actionId, changes: [{ path: "src/x.ts", kind: "update", movePath: null, diff: "+x" }] }
            : { type: "command", actionId, command: `${kind}:${this.count}`, cwd: null };
        const decision = await request.gate.decide(action);
        if (decision.outcome === "allow" || decision.outcome === "steer") this.executed.push(actionId);
        if (decision.outcome === "block" && decision.stop === "execution") break;
      }
      if (crashing) throw new Error("crashed after acting");
      return { output: script.output, threadId: null, usage: null, tracePath: null, traceTruncated: false };
    } finally {
      this.active -= 1;
    }
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function pause(random: Rng, signal: AbortSignal): Promise<void> {
  const ms = random.chance(0.5) ? 0 : random.int(0, 3);
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => (signal.aborted ? reject(new Error("aborted")) : resolve()), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

function scenario(seed: number) {
  const random = rng(seed);
  const mode = random.chance(0.15) ? "single" : "auto";
  const count = mode === "single" ? 1 : random.int(1, 6);
  const tasks: SupervisorPlan["tasks"] = [];
  const scripts = new Map<string, TaskScript>();
  for (let index = 0; index < count; index += 1) {
    const key = `t${index}`;
    const dependsOn = tasks.filter(() => random.chance(0.3)).map((task) => task.key);
    const title = mode === "single" ? "Single task" : `Task ${index}`;
    tasks.push({ key, title, objective: `Objective ${index}`, agentId: random.pick([AGENTS.analyst, AGENTS.developer]), dependsOn });
    const crashRoll = random.next();
    scripts.set(title, {
      kinds: Array.from({ length: random.int(0, 3) }, () => pickKind(random)),
      crashes: crashRoll < 0.7 ? 0 : crashRoll < 0.9 ? 1 : Infinity,
      crashAfterActions: random.chance(0.5),
      output: random.chance(0.1) ? `result with SECRET ${index}` : `result ${index}`,
    });
  }
  // Who answers approvals. Timeouts must not depend on wall-clock luck, or the
  // coverage check below passes on one machine and fails on a faster one:
  //   prompt  answers; a timeout is effectively impossible (60 s)
  //   absent  never answers; the sweep expires every approval, on any machine
  //   racing  answers at random against a 1 ms deadline: the answer/timeout race
  const approverRoll = random.next();
  const approver: "prompt" | "absent" | "racing" = approverRoll < 0.7 ? "prompt" : approverRoll < 0.85 ? "absent" : "racing";
  return {
    random,
    mode,
    plan: { tasks },
    scripts,
    gateDelegations: random.chance(0.3),
    approver,
    limits: {
      maxParallel: random.int(1, 3),
      maxAttempts: random.int(1, 3),
      approvalTtlMs: approver === "prompt" ? 60_000 : 1,
    },
    cancelAfterMs: random.chance(0.15) ? random.int(0, 15) : null,
    /** Cancel the moment an approval is waiting: the race between a cancel and an answer. */
    cancelOnApproval: random.chance(0.1),
    /**
     * Cancel while the middleware is still deciding that an action needs
     * approval: the approval is about to be opened just as the cancel sweeps
     * pending approvals. Too narrow for random timing to hit.
     */
    cancelDuringEvaluation: random.chance(0.08),
    /** How readily the person answers on each look: slow people let approvals time out. */
    answerRate: 0.15 + random.next() * 0.8,
  };
}

async function play(seed: number) {
  const setup = scenario(seed);
  const hub = new RunEventHub();
  const store = new InMemoryRunStore(hub);
  const middleware = new FuzzMiddleware(setup.gateDelegations);
  const runtime = new FuzzRuntime(seed, setup.scripts, setup.random);
  const errors: unknown[] = [];
  const orchestrator = new Orchestrator({
    store,
    agents: new FakeDirectory(),
    middleware,
    planner: new StaticPlanner(setup.plan),
    runtime,
    workingCopies: { prepare: async (run) => `/runs/${run.id}` },
    limits: setup.limits,
    onError: (error) => errors.push(error),
  });
  let runId = "";
  if (setup.cancelDuringEvaluation) {
    middleware.onRequireApproval = async () => {
      await orchestrator.cancel(runId, USER_ID).catch(() => undefined);
    };
  }

  const run = await orchestrator.createRun({
    workspaceId: WORKSPACE_ID,
    createdByUserId: USER_ID,
    userPrompt: "Fuzz",
    orchestrationMode: setup.mode === "single" ? "single" : "auto",
    ...(setup.mode === "single" ? { agentId: setup.plan.tasks[0]!.agentId } : {}),
  });
  runId = run.id;
  const events: RunEvent[] = [];
  hub.subscribe(run.id, 0, { onEvent: (event) => events.push(event), onResync: () => events.push({} as RunEvent) });

  let settled = false;
  const done = orchestrator.whenSettled(run.id).then(() => {
    settled = true;
  });

  // A person who answers some approvals, ignores others, and a timeout sweep.
  const human = (async () => {
    while (!settled) {
      await new Promise((resolve) => setTimeout(resolve, setup.random.int(0, 2)));
      for (const approval of await store.listApprovals(run.id)) {
        if (approval.status !== "pending") continue;
        if (setup.cancelOnApproval) {
          await orchestrator.cancel(run.id, USER_ID).catch(() => undefined);
          break;
        }
        if (setup.approver === "absent" || !setup.random.chance(setup.answerRate)) continue;
        const answer = setup.random.chance(0.62) ? "approve" : "deny";
        await orchestrator.resolveApproval(approval.id, answer, USER_ID).catch(() => undefined);
      }
      if (setup.approver === "absent" || setup.random.chance(0.3)) {
        await orchestrator.expireDueApprovals().catch(() => undefined);
      }
    }
  })();
  const canceller =
    setup.cancelAfterMs === null
      ? Promise.resolve()
      : new Promise((resolve) => setTimeout(resolve, setup.cancelAfterMs!)).then(() =>
          orchestrator.cancel(run.id, USER_ID).catch(() => undefined),
        );

  const hung = new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000));
  const outcome = await Promise.race([done.then(() => "settled" as const), hung]);
  settled = true;
  await Promise.all([human, canceller]);
  return { setup, store, middleware, runtime, errors, run, events, outcome };
}

/** How often each situation came up across the seeds; a fuzzer that never reaches one tests nothing about it. */
const coverage = {
  completed: 0,
  failed: 0,
  cancelled: 0,
  approved: 0,
  denied: 0,
  timedOut: 0,
  cancelledApprovals: 0,
  stoppedExecutions: 0,
  retries: 0,
  parallel: 0,
  skippedTasks: 0,
  withheldHandoffs: 0,
};

describe("orchestrator under randomised plans, decisions, failures, approvals and cancels", () => {
  afterAll(() => {
    // FUZZ_REPORT=<file> keeps the numbers, e.g. for the evaluation write-up.
    if (process.env.FUZZ_REPORT) writeFileSync(process.env.FUZZ_REPORT, JSON.stringify({ seeds: SEEDS.length, coverage }, null, 2));
    if (SEEDS.length < 100) return;
    for (const [situation, seen] of Object.entries(coverage)) {
      expect(seen, `the fuzzer should reach "${situation}"`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(SEEDS)("seed %i keeps every invariant and safety property", async (seed) => {
    const { setup, store, middleware, runtime, errors, run, events, outcome } = await play(seed);
    {
      const snapshot = store.snapshot(run.id)!;
      const status = snapshot.run.status;
      if (status === "completed" || status === "failed" || status === "cancelled") coverage[status] += 1;
      for (const approval of snapshot.approvals) {
        if (approval.status === "approved") coverage.approved += 1;
        if (approval.status === "denied") coverage.denied += 1;
        if (approval.status === "timed_out") coverage.timedOut += 1;
        if (approval.status === "cancelled") coverage.cancelledApprovals += 1;
      }
      coverage.stoppedExecutions += middleware.stopped.size;
      coverage.retries += snapshot.executions.filter((execution) => execution.attempt > 1).length;
      if (runtime.maxActive > 1) coverage.parallel += 1;
      coverage.skippedTasks += snapshot.tasks.filter((task) => task.status === "skipped").length;
      coverage.withheldHandoffs += snapshot.findings.filter((item) => item.code === "secret-handoff").length;
    }
    expect(outcome, "the run must settle").toBe("settled");
    expect(errors, "no unrecorded orchestration errors").toEqual([]);

    const snapshot = store.snapshot(run.id)!;
    // Lifecycle, dependency order, write serialisation, references, end state, events = snapshot.
    expect(checkRunInvariants(run.id, events, snapshot)).toEqual([]);

    // No refused action ever ran: everything executed was finally allowed or steered.
    for (const actionId of runtime.executed) {
      expect(["allow", "steer"], `executed ${actionId}`).toContain(middleware.finalOutcome.get(actionId));
    }
    // A stopped execution proposes nothing more, and ends failed (or cancelled).
    expect(middleware.afterStop).toEqual([]);
    for (const executionId of middleware.stopped) {
      const execution = snapshot.executions.find((candidate) => candidate.id === executionId)!;
      expect(["failed", "cancelled"]).toContain(execution.status);
    }
    // No retry after a refusal: a refused attempt is always a task's last.
    for (const task of snapshot.tasks) {
      const attempts = snapshot.executions.filter((execution) => execution.taskId === task.id).sort((a, b) => a.attempt - b.attempt);
      attempts.slice(0, -1).forEach((execution) => {
        expect(middleware.refusedIn.has(execution.id), `retried after refusal in ${task.title}`).toBe(false);
      });
      expect(attempts.length).toBeLessThanOrEqual(setup.limits.maxAttempts);
    }
    expect(runtime.maxActive).toBeLessThanOrEqual(setup.limits.maxParallel);

    // Once a cancel is requested nobody is asked to approve anything more: an
    // approval opened after it would wait on a person for a run they stopped.
    const cancelSeq = events.find((event) => event.type === "run.updated" && event.payload.run.cancelRequestedAt !== null)?.seq;
    if (cancelSeq !== undefined) {
      const late = events.filter((event) => event.type === "approval.requested" && event.seq > cancelSeq);
      expect(late.map((event) => event.seq), "approvals requested after the cancel").toEqual([]);
    }

    // The end state means what it says.
    const failedTasks = snapshot.tasks.filter((task) => task.status === "failed");
    if (snapshot.run.status === "completed") expect(failedTasks).toEqual([]);
    if (snapshot.run.status === "cancelled") expect(snapshot.run.cancelRequestedAt).not.toBeNull();
    if (snapshot.run.status === "failed") expect(snapshot.run.error).not.toBeNull();
    if (setup.cancelAfterMs === null && !setup.cancelOnApproval && !setup.cancelDuringEvaluation) {
      expect(snapshot.run.status).not.toBe("cancelled");
    }

    // The audit trail is complete and valid.
    const audit = store.auditEvents(run.id);
    for (const event of audit) expect(auditEventSchema.safeParse(event).success).toBe(true);
    const started = audit.filter((event) => event.eventType === "execution.started").map((event) => event.executionId);
    const finished = audit.filter((event) => event.eventType === "execution.finished").map((event) => event.executionId);
    expect(new Set(started)).toEqual(
      new Set(snapshot.executions.filter((execution) => execution.startedAt !== null).map((execution) => execution.id)),
    );
    for (const execution of snapshot.executions) {
      if (isTerminalExecutionStatus(execution.status)) expect(finished, `execution.finished for ${execution.id}`).toContain(execution.id);
    }
  });
});

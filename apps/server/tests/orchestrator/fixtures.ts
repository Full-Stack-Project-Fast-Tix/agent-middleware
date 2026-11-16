import type {
  Agent,
  CommandAction,
  FileChangeAction,
  OrchestrationMode,
  ProposedAction,
  RunDiffResponse,
  RunEvent,
  SecurityDecision,
} from "@launchpad/shared";
import { RunEventHub } from "../../src/run-events.js";
import { InMemoryRunStore } from "../../src/orchestrator/in-memory-run-store.js";
import { Orchestrator, type OrchestratorLimits } from "../../src/orchestrator/orchestrator.js";
import type { SupervisorPlan } from "../../src/orchestrator/plan.js";
import type { PlanRequest, Planner } from "../../src/orchestrator/planner.js";
import type {
  AgentDirectory,
  ExecutionOutcome,
  ExecutionRequest,
  ExecutionRuntime,
  RunDiffReviewer,
} from "../../src/orchestrator/ports.js";
import type { SecurityMiddleware } from "../../src/security-middleware.js";
import { AGENTS, USER_ID, WORKSPACE_ID } from "../integration/harness/factories.js";
import { ScriptedMiddleware, type StandInOptions } from "../integration/harness/stand-in.js";

// Fakes for the subsystems around the orchestrator. The security middleware is
// the integration harness's ScriptedMiddleware, so these tests and the Gate 1
// scenarios hold the orchestrator to the same rules.

export { AGENTS, USER_ID, WORKSPACE_ID };

const CREATED_AT = "2026-10-01T00:00:00.000Z";

export function makeAgent(role: keyof typeof AGENTS, overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENTS[role],
    workspaceId: WORKSPACE_ID,
    name: role,
    description: `The ${role}`,
    instructions: "",
    profileId: "00000000-0000-0000-0000-0000000000aa",
    enabled: true,
    createdByUserId: USER_ID,
    version: 1,
    archivedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export class FakeDirectory implements AgentDirectory {
  readonly agents = new Map<string, Agent>(
    (Object.keys(AGENTS) as Array<keyof typeof AGENTS>).map((role) => [AGENTS[role], makeAgent(role)]),
  );

  async getAgent(agentId: string): Promise<Agent | null> {
    return this.agents.get(agentId) ?? null;
  }

  async listAgents(workspaceId: string): Promise<Agent[]> {
    return [...this.agents.values()].filter((agent) => agent.workspaceId === workspaceId);
  }

  async defaultAgentId(_workspaceId: string, mode: OrchestrationMode): Promise<string | null> {
    return mode === "auto" ? AGENTS.supervisor : AGENTS.developer;
  }
}

export class StaticPlanner implements Planner {
  readonly calls: PlanRequest[] = [];
  constructor(private readonly result: SupervisorPlan | (() => Promise<SupervisorPlan>)) {}

  async plan(request: PlanRequest): Promise<SupervisorPlan> {
    this.calls.push(request);
    return typeof this.result === "function" ? this.result() : this.result;
  }
}

/** The plan the harness scripts: read-only analysis, then an implementation that depends on it. */
export const SIGNUP_PLAN: SupervisorPlan = {
  tasks: [
    {
      key: "analyse",
      title: "Find missing validation",
      objective: "Identify which signup fields are not validated",
      agentId: AGENTS.analyst,
      dependsOn: [],
    },
    {
      key: "implement",
      title: "Add validation",
      objective: "Validate signup fields and return 400 on bad input",
      agentId: AGENTS.developer,
      dependsOn: ["analyse"],
    },
  ],
};

type ScriptedAction = Omit<CommandAction, "actionId"> | Omit<FileChangeAction, "actionId">;

export interface ScriptStep {
  actions?: ScriptedAction[];
  output?: string;
  /** Defaults to complete. Null simulates a malformed or missing report. */
  disposition?: "complete" | "incomplete" | null;
  /** Throw on this many attempts before succeeding; Infinity always throws. */
  failAttempts?: number;
  /** Throw after the actions instead of before them. */
  failAfterActions?: boolean;
  delayMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Stands in for the Claude runtime: proposes scripted actions through the gate, keyed by task title. */
export class ScriptedRuntime implements ExecutionRuntime {
  readonly executed: Array<{ taskTitle: string; action: ProposedAction }> = [];
  readonly prompts = new Map<string, string>();
  readonly workingDirectories = new Set<string>();
  readonly attempts = new Map<string, number>();
  maxActive = 0;
  maxActiveWriters = 0;
  private active = 0;
  private activeWriters = 0;
  private actionCount = 0;

  constructor(private readonly script: Record<string, ScriptStep> = {}) {}

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const title = request.task.title;
    const step = this.script[title] ?? {};
    const attempt = (this.attempts.get(title) ?? 0) + 1;
    this.attempts.set(title, attempt);
    this.prompts.set(title, request.prompt);
    this.workingDirectories.add(request.workingDirectory);
    const writer = request.execution.capabilities.write;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (writer) {
      this.activeWriters += 1;
      this.maxActiveWriters = Math.max(this.maxActiveWriters, this.activeWriters);
    }
    try {
      const failing = attempt <= (step.failAttempts ?? 0);
      if (failing && !step.failAfterActions) throw new Error(`${title}: runtime crashed`);
      if (step.delayMs !== undefined) await sleep(step.delayMs, request.signal);
      for (const planned of step.actions ?? []) {
        this.actionCount += 1;
        const action = { ...planned, actionId: `item_${this.actionCount}` } as ProposedAction;
        const decision: SecurityDecision = await request.gate.decide(action);
        if (decision.outcome === "allow" || decision.outcome === "steer") this.executed.push({ taskTitle: title, action });
        // The runtime ends the turn when the middleware stops the execution.
        if (decision.outcome === "block" && decision.stop === "execution") break;
      }
      if (failing) throw new Error(`${title}: runtime crashed`);
      const output = step.output ?? `${title}: done`;
      return {
        output,
        disposition: step.disposition === null
          ? null
          : { status: step.disposition ?? "complete", summary: output },
        threadId: `thread-${request.execution.id}`,
        usage: step.usage ?? null,
        tracePath: null,
        traceTruncated: false,
      };
    } finally {
      this.active -= 1;
      if (writer) this.activeWriters -= 1;
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

export interface Harness {
  orchestrator: Orchestrator;
  store: InMemoryRunStore;
  hub: RunEventHub;
  directory: FakeDirectory;
  planner: StaticPlanner;
  runtime: ScriptedRuntime;
  middleware: SecurityMiddleware;
  scripted: ScriptedMiddleware;
  /** Run ids whose working copy was prepared, once per preparation. */
  prepared: string[];
  errors: unknown[];
  /** Every event of the run from seq 1, kept up to date. */
  record(runId: string): RunEvent[];
}

export function startHarness(options: {
  plan?: SupervisorPlan | (() => Promise<SupervisorPlan>);
  script?: Record<string, ScriptStep>;
  middleware?: StandInOptions;
  /** Wrap the scripted middleware, e.g. to add a rule. */
  wrapMiddleware?: (inner: ScriptedMiddleware) => SecurityMiddleware;
  limits?: Partial<OrchestratorLimits>;
  /** A store with timing of its own, to reach interleavings the in-memory one never does. */
  store?: (hub: RunEventHub) => InMemoryRunStore;
  /** Optional bounded actual diff for exercising the post-run semantic backstop. */
  diff?: () => Promise<RunDiffResponse>;
  finalDiffReviewer?: RunDiffReviewer;
} = {}): Harness {
  const hub = new RunEventHub();
  const store = options.store?.(hub) ?? new InMemoryRunStore(hub);
  const directory = new FakeDirectory();
  const planner = new StaticPlanner(options.plan ?? SIGNUP_PLAN);
  const runtime = new ScriptedRuntime(options.script);
  const scripted = new ScriptedMiddleware(options.middleware ?? {});
  const middleware = options.wrapMiddleware?.(scripted) ?? scripted;
  const errors: unknown[] = [];
  const prepared: string[] = [];
  const orchestrator = new Orchestrator({
    store,
    agents: directory,
    middleware,
    planner,
    runtime,
    workingCopies: {
      prepare: async (run) => {
        prepared.push(run.id);
        return `/runs/${run.id}/workspace`;
      },
      ...(options.diff === undefined ? {} : { diff: options.diff }),
    },
    ...(options.finalDiffReviewer === undefined ? {} : { finalDiffReviewer: options.finalDiffReviewer }),
    limits: { approvalTtlMs: 60_000, ...options.limits },
    onError: (error) => errors.push(error),
  });
  return {
    orchestrator,
    store,
    hub,
    directory,
    planner,
    runtime,
    middleware,
    scripted,
    prepared,
    errors,
    record(runId) {
      const events: RunEvent[] = [];
      const subscription = hub.subscribe(runId, 0, {
        onEvent: (event) => events.push(event),
        onResync: () => {
          throw new Error("unexpected resync");
        },
      });
      if (subscription.status !== "subscribed") throw new Error("could not subscribe");
      return events;
    },
  };
}

export async function waitFor<T>(probe: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

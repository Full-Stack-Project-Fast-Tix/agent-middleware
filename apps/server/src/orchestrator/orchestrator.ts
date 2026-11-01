import { randomUUID } from "node:crypto";
import {
  canTransitionExecution,
  canTransitionRun,
  canTransitionTask,
  isTerminalExecutionStatus,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  type AgentExecution,
  type Approval,
  type ApprovalDecision,
  type ApprovalStatus,
  type AuditEvent,
  type AuditEventType,
  type ExecutionStatus,
  type JsonObject,
  type OrchestrationMode,
  type ProposedAction,
  type Run,
  type RunStatus,
  type SecurityDecision,
  type Task,
  type TaskDependency,
  type TaskStatus,
  type ExecutionUsage,
} from "@launchpad/shared";
import { HttpError, RunCancelledError, traceOf, usageOf } from "../errors.js";
import { redactSensitiveText } from "../redaction/index.js";
import type { ExecutionGuard, ResolvedPolicy, SecurityMiddleware } from "../security-middleware.js";
import { validatePlan } from "./plan.js";
import type { Planner } from "./planner.js";
import type { ActionGate, AgentDirectory, AuditFor, ExecutionRuntime, RunStore, WorkingCopies } from "./ports.js";
import { pickLaunches, tasksToMarkReady, tasksToSkip, type LaunchCandidate } from "./scheduler.js";
import { buildTaskPrompt, type TaskInput, type WithheldInput } from "./task-prompt.js";

// Runs one user request (a Run) as Tasks executed by Agents.
//
//   single  one Task for the named Agent.
//   auto    the supervisor plans; each planned Task is a delegation the
//           security middleware evaluates before the Task exists; then the
//           scheduler runs the Tasks in dependency order.
//
// The orchestrator decides what happens next. Whether an action may happen is
// always the middleware's decision (docs/contract-decisions.md): every
// delegation, every context handoff, and through the runtime every command and
// file change, goes through an ExecutionGuard first.
//
// Status changes follow packages/shared/src/lifecycle.ts. An illegal transition
// throws rather than being written.

type Answer = Exclude<ApprovalStatus, "pending">;
type Phase = "planning" | "running";
type TaskResult = "completed" | "failed" | "retry" | "cancelled";

export interface OrchestratorLimits {
  /** Most tasks a supervisor plan may contain. Each one is a paid agent run. */
  maxTasks: number;
  /** Most executions running at once within one Run. */
  maxParallel: number;
  /** Attempts per Task, counting the first. Middleware stops and refusals are never retried. */
  maxAttempts: number;
  /** Sets Approval.expiresAt. The timeout sweep calls expireApproval. */
  approvalTtlMs: number;
  /** Input plus output tokens one Run may use. Checked before each attempt, so one attempt can overshoot it. */
  maxRunTokens: number;
}

export const DEFAULT_ORCHESTRATOR_LIMITS: OrchestratorLimits = {
  maxTasks: 6,
  maxParallel: 2,
  maxAttempts: 2,
  approvalTtlMs: 120_000,
  maxRunTokens: 2_000_000,
};

export interface OrchestratorOptions {
  store: RunStore;
  agents: AgentDirectory;
  middleware: SecurityMiddleware;
  planner: Planner;
  runtime: ExecutionRuntime;
  workingCopies: WorkingCopies;
  limits?: Partial<OrchestratorLimits>;
  now?: () => string;
  newId?: () => string;
  /** Errors that could not be recorded on the Run itself. */
  onError?: (error: unknown, runId: string) => void;
}

export interface CreateRunInput {
  workspaceId: string;
  createdByUserId: string;
  userPrompt: string;
  orchestrationMode: OrchestrationMode;
  /** The agent for `single`, or the supervisor for `auto`. The workspace default when omitted. */
  agentId?: string;
}

/** The middleware ended the execution (block with stop: "execution"). Never retried. */
class ExecutionStoppedError extends Error {
  constructor(reason: string) {
    super(`Stopped by the security middleware: ${reason}`);
    this.name = "ExecutionStoppedError";
  }
}

interface RunState {
  runId: string;
  workspaceId: string;
  cancelRequested: boolean;
  /** Tells the planner and runtime to stop. */
  abort: AbortController;
  /** Where the Run returns once no approval is pending. */
  phase: Phase;
  /** Executions in flight, by task id. */
  inflight: Map<string, Promise<void>>;
  /** Serialises approval bookkeeping so Run.waiting_approval always matches the pending approvals. */
  lock: Promise<void>;
  done: Promise<void>;
}

interface Launch {
  execution: AgentExecution;
  task: Task;
  guard: ExecutionGuard;
  policy: ResolvedPolicy;
  gate: ActionGate;
  /** Set by a block with stop: "execution". */
  stopReason: string | null;
  /** Set by any block, deny or timeout. A retry must not become a way around the middleware. */
  refused: boolean;
}

const permits = (decision: SecurityDecision) => decision.outcome === "allow" || decision.outcome === "steer";

export class Orchestrator {
  private readonly store: RunStore;
  private readonly agents: AgentDirectory;
  private readonly middleware: SecurityMiddleware;
  private readonly planner: Planner;
  private readonly runtime: ExecutionRuntime;
  private readonly workingCopies: WorkingCopies;
  private readonly limits: OrchestratorLimits;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly onError: (error: unknown, runId: string) => void;

  private readonly active = new Map<string, RunState>();
  /** Runs being created or executed, ordered one at a time per workspace. */
  private readonly activeWorkspaceRuns = new Map<string, string>();
  private readonly creatingWorkspaceRuns = new Set<string>();
  /** Approvals some execution is waiting on, by approval id. */
  private readonly waiters = new Map<string, (answer: Answer) => void>();
  /** Approvals being resolved right now, so a double submit gets a 409. */
  private readonly settling = new Set<string>();
  /** Workspace of each Run seen, for audit events. */
  private readonly workspaces = new Map<string, string>();

  constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.agents = options.agents;
    this.middleware = options.middleware;
    this.planner = options.planner;
    this.runtime = options.runtime;
    this.workingCopies = options.workingCopies;
    const limits = { ...DEFAULT_ORCHESTRATOR_LIMITS, ...options.limits };
    // Below 1, the scheduler could never launch anything and would stall.
    this.limits = {
      ...limits,
      maxParallel: Math.max(1, Math.floor(limits.maxParallel)),
      maxAttempts: Math.max(1, Math.floor(limits.maxAttempts)),
    };
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
    this.onError =
      options.onError ?? ((error, runId) => console.error(`Orchestration of run ${runId} failed unrecorded`, error));
  }

  /**
   * Create a queued Run and start working on it in the background. Returns
   * the Run as created; follow its progress through the RunEvents.
   */
  async createRun(input: CreateRunInput): Promise<Run> {
    const agentId = input.agentId ?? (await this.agents.defaultAgentId(input.workspaceId, input.orchestrationMode));
    if (agentId === null) {
      throw new HttpError(400, `Name an agentId: this workspace has no default agent for ${input.orchestrationMode} runs`);
    }
    const agent = await this.agents.getAgent(agentId);
    if (agent === null || agent.workspaceId !== input.workspaceId) throw new HttpError(404, "Agent not found");
    if (!agent.enabled || agent.archivedAt !== null) throw new HttpError(409, `Agent "${agent.name}" is disabled`);

    if (this.activeWorkspaceRuns.has(input.workspaceId) || this.creatingWorkspaceRuns.has(input.workspaceId)) {
      throw new HttpError(409, "A run is already active in this workspace. Wait for it to finish before submitting another prompt.");
    }
    this.creatingWorkspaceRuns.add(input.workspaceId);

    const now = this.now();
    let run: Run;
    try {
      run = await this.store.createRun({
        id: this.newId(),
        workspaceId: input.workspaceId,
        parentRunId: null,
        createdByUserId: input.createdByUserId,
        supervisorAgentId: input.orchestrationMode === "auto" ? agentId : null,
        userPrompt: input.userPrompt,
        orchestrationMode: input.orchestrationMode,
        status: "queued",
        finalOutput: null,
        error: null,
        cancelRequestedAt: null,
        evaluation: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
      }, (created) =>
        this.auditEvent(created.workspaceId, created.id, "run.created", { type: "user", id: input.createdByUserId }, {
          metadata: { orchestrationMode: created.orchestrationMode, agentId },
        }),
      );
    } catch (error) {
      this.creatingWorkspaceRuns.delete(input.workspaceId);
      throw error;
    }
    this.creatingWorkspaceRuns.delete(input.workspaceId);
    this.activeWorkspaceRuns.set(run.workspaceId, run.id);
    this.workspaces.set(run.id, run.workspaceId);

    const state: RunState = {
      runId: run.id,
      workspaceId: run.workspaceId,
      cancelRequested: false,
      abort: new AbortController(),
      phase: "running",
      inflight: new Map(),
      lock: Promise.resolve(),
      done: Promise.resolve(),
    };
    this.active.set(run.id, state);
    state.done = this.process(state, run, agentId)
      .catch((error: unknown) => this.onError(error, run.id))
      .finally(() => {
        this.active.delete(run.id);
        if (this.activeWorkspaceRuns.get(run.workspaceId) === run.id) this.activeWorkspaceRuns.delete(run.workspaceId);
      });
    return run;
  }

  /** Resolves once this process has finished working on the Run. */
  whenSettled(runId: string): Promise<void> {
    return this.active.get(runId)?.done ?? Promise.resolve();
  }

  /** A person's answer to a pending approval. 404 if unknown, 409 if already answered. */
  async resolveApproval(approvalId: string, decision: ApprovalDecision, userId: string): Promise<Approval> {
    return this.answerApproval(approvalId, decision === "approve" ? "approved" : "denied", userId);
  }

  /** Time out one pending approval: the action is declined and the execution carries on. */
  async expireApproval(approvalId: string): Promise<Approval> {
    return this.answerApproval(approvalId, "timed_out", null);
  }

  /**
   * Close the Runs a previous process left active. Their executions, and the
   * containers running them, did not survive the restart, so they cannot be
   * resumed: each is failed with the reason recorded, or cancelled if a cancel
   * had been requested. Call once at startup, before accepting requests.
   * Returns how many were closed.
   */
  async recoverInterruptedRuns(): Promise<number> {
    let recovered = 0;
    for (const run of await this.store.listActiveRuns()) {
      if (this.active.has(run.id)) continue;
      this.workspaces.set(run.id, run.workspaceId);
      if (run.cancelRequestedAt !== null) await this.finishCancelled(run.id);
      else await this.failRun(run.id, "The server restarted while this run was active; its work could not be resumed.");
      recovered += 1;
    }
    return recovered;
  }

  /** Time out every pending approval past its expiresAt. Returns how many were expired. */
  async expireDueApprovals(): Promise<number> {
    let expired = 0;
    for (const approval of await this.store.listExpiredApprovals(this.now())) {
      try {
        await this.expireApproval(approval.id);
        expired += 1;
      } catch (error) {
        // Answered by a person between the query and now: nothing to expire.
        if (!(error instanceof HttpError && error.statusCode === 409)) throw error;
      }
    }
    return expired;
  }

  /**
   * Request cancellation. Sets cancelRequestedAt at once; the Run becomes
   * cancelled once its work has stopped. Repeating it is harmless. 409 only
   * for a Run that already completed or failed.
   */
  async cancel(runId: string, userId: string | null = null): Promise<Run> {
    const state = this.active.get(runId);
    // Under the Run's lock, concurrent cancels stamp cancelRequestedAt only once,
    // and an approval is either announced before this write (and closed below)
    // or refused after it, never announced in between.
    return state === undefined ? this.requestCancel(runId, userId, null) : this.locked(state, () => this.requestCancel(runId, userId, state));
  }

  private async requestCancel(runId: string, userId: string | null, state: RunState | null): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (run === null) throw new HttpError(404, "Run not found");
    if (run.status === "cancelled") return run;
    if (isTerminalRunStatus(run.status)) throw new HttpError(409, `Run is already ${run.status}`);

    let requested = run;
    if (run.cancelRequestedAt === null) {
      requested = await this.store.updateRun(runId, { cancelRequestedAt: this.now() }, () =>
        this.auditEvent(run.workspaceId, runId, "run.cancel_requested", userId === null ? { type: "system" } : { type: "user", id: userId }),
      );
    }
    if (state === null) {
      // Nothing in this process is working on it (for example after a restart).
      await this.finishCancelled(runId);
      return requested;
    }
    if (!state.cancelRequested) {
      state.cancelRequested = true;
      state.abort.abort();
      await this.cancelPendingApprovals(runId);
    }
    return requested;
  }

  // ---------------------------------------------------------------------------
  // The Run
  // ---------------------------------------------------------------------------

  private async process(state: RunState, run: Run, agentId: string): Promise<void> {
    try {
      if (run.orchestrationMode === "single") {
        await this.moveRun(run.id, "running", { startedAt: this.now() });
        state.phase = "running";
        await this.createTask(run, {
          title: titleFrom(run.userPrompt),
          objective: run.userPrompt,
          assignedAgentId: agentId,
          parentTaskId: null,
          createdByExecutionId: null,
          status: "pending",
        }, []);
      } else {
        await this.moveRun(run.id, "planning", { startedAt: this.now() });
        state.phase = "planning";
        await this.plan(state, run, agentId);
        this.throwIfCancelled(state);
        await this.moveRun(run.id, "running");
        state.phase = "running";
      }
      await this.schedule(state, run);
      // A cancel either gets in first, and the Run ends cancelled, or finds it finished.
      await this.locked(state, async () => {
        this.throwIfCancelled(state);
        await this.finish(run);
      });
    } catch (error) {
      // Stop anything still running before closing the Run's books.
      state.abort.abort();
      await Promise.allSettled(state.inflight.values());
      await this.locked(state, () => (state.cancelRequested ? this.finishCancelled(run.id) : this.failRun(run.id, errorMessage(error))));
    }
  }

  /** The supervisor's execution: plan, validate, then delegate each task through the middleware. */
  private async plan(state: RunState, run: Run, supervisorId: string): Promise<void> {
    const planTask = await this.createTask(run, {
      title: "Plan",
      objective: `Break down: ${run.userPrompt}`,
      assignedAgentId: supervisorId,
      parentTaskId: null,
      createdByExecutionId: null,
      status: "ready",
    }, []);
    await this.moveTask(planTask.id, "running", { startedAt: this.now() });
    const policy = await this.middleware.resolvePolicy(run.workspaceId, supervisorId);
    const launch = await this.launch(state, run, planTask, supervisorId, 1, policy);

    try {
      if (!policy.capabilities.delegate || policy.capabilities.maxDelegationDepth < 1) {
        throw new Error("The supervisor's effective policy does not allow delegation.");
      }
      const workspaceAgents = await this.agents.listAgents(run.workspaceId);
      const assignable = workspaceAgents.filter(
        (agent) => agent.id !== supervisorId && agent.enabled && agent.archivedAt === null,
      );
      if (assignable.length === 0) throw new Error("This workspace has no enabled agents to delegate to.");

      const continuityContext = await this.continuityContext(run);
      const plan = await this.planner.plan({
        userPrompt: run.userPrompt,
        ...(continuityContext === undefined ? {} : { continuityContext }),
        agents: assignable.map(({ id, name, description }) => ({ id, name, description })),
        maxTasks: this.limits.maxTasks,
        signal: state.abort.signal,
      });
      this.throwIfCancelled(state);
      const validation = validatePlan(plan, {
        workspaceId: run.workspaceId,
        supervisorAgentId: supervisorId,
        agents: workspaceAgents,
        maxTasks: this.limits.maxTasks,
      });
      if (!validation.ok) throw new Error(`The supervisor's plan was rejected. ${validation.errors.join(" ")}`);

      const created = new Map<string, Task>();
      for (const step of validation.tasks) {
        this.throwIfCancelled(state);
        // A refused delegation takes everything that depends on it along with it.
        if (step.dependsOn.some((key) => !created.has(key))) continue;
        const dependsOnTaskIds = step.dependsOn.map((key) => created.get(key)!.id);
        const decision = await launch.gate.decide({
          type: "delegation",
          actionId: this.actionId("delegation"),
          targetAgentId: step.agentId,
          title: step.title,
          objective: step.objective,
          dependsOnTaskIds,
        });
        if (launch.stopReason !== null) throw new ExecutionStoppedError(launch.stopReason);
        if (!permits(decision)) continue;
        created.set(
          step.key,
          await this.createTask(run, {
            title: step.title,
            objective: step.objective,
            assignedAgentId: step.agentId,
            parentTaskId: planTask.id,
            createdByExecutionId: launch.execution.id,
            status: "pending",
          }, dependsOnTaskIds, supervisorId),
        );
      }

      const summary = `Delegated ${created.size} of ${validation.tasks.length} planned tasks.`;
      await this.moveExecution(launch.execution.id, "completed", { output: summary, completedAt: this.now() });
      await this.moveTask(planTask.id, "completed", { result: summary, completedAt: this.now() });
    } catch (error) {
      if (!state.cancelRequested) {
        const message = errorMessage(error);
        await this.moveExecution(launch.execution.id, "failed", { error: message, completedAt: this.now() });
        await this.moveTask(planTask.id, "failed", { error: message, completedAt: this.now() });
      }
      throw error;
    } finally {
      await launch.guard.close().catch(() => undefined);
    }
  }

  /**
   * Run every Task to an end state: dependencies first, at most maxParallel at
   * once, write-capable executions one at a time. After a failure, running
   * work finishes but nothing new starts.
   */
  private async schedule(state: RunState, run: Run): Promise<void> {
    const retries: string[] = [];
    const attempts = new Map<string, number>();
    /** Resolved for tasks waiting to launch; the snapshot is taken once per execution. */
    const policies = new Map<string, ResolvedPolicy>();
    /** Whether each in-flight execution is write-capable. */
    const writing = new Map<string, boolean>();
    let failureSeen = false;
    /** Prepared just before the first launch; a Run with nothing to run never copies. */
    let workingDirectory: string | null = null;
    let finished = 0;

    for (;;) {
      this.throwIfCancelled(state);
      const finishedBeforeReading = finished;
      let tasks = await this.store.listTasks(run.id);
      const dependencies = await this.store.listDependencies(run.id);
      for (const id of tasksToSkip(tasks, dependencies)) {
        await this.moveTask(id, "skipped", { completedAt: this.now() });
      }
      for (const id of tasksToMarkReady(tasks, dependencies)) await this.moveTask(id, "ready");
      tasks = await this.store.listTasks(run.id);
      failureSeen ||= tasks.some((task) => task.status === "failed");

      const candidates: LaunchCandidate[] = [];
      const waiting = [
        ...retries.filter((id) => !state.inflight.has(id)),
        ...(failureSeen ? [] : tasks.filter((task) => task.status === "ready" && !state.inflight.has(task.id)).map((task) => task.id)),
      ];
      for (const taskId of waiting) {
        const task = tasks.find((candidate) => candidate.id === taskId)!;
        if (task.assignedAgentId === null) {
          await this.moveTask(task.id, "failed", { error: "The task has no assigned agent.", completedAt: this.now() });
          continue;
        }
        let policy = policies.get(taskId);
        if (policy === undefined) {
          policy = await this.middleware.resolvePolicy(run.workspaceId, task.assignedAgentId);
          policies.set(taskId, policy);
        }
        candidates.push({ taskId, write: policy.capabilities.write });
      }

      const launches = pickLaunches({
        candidates,
        active: [...writing.values()].map((write) => ({ write })),
        maxParallel: this.limits.maxParallel,
      });
      if (launches.length > 0 && workingDirectory === null) {
        workingDirectory = await this.workingCopies.prepare(run);
      }
      for (const taskId of launches) {
        const policy = policies.get(taskId)!;
        policies.delete(taskId);
        const retryIndex = retries.indexOf(taskId);
        if (retryIndex >= 0) retries.splice(retryIndex, 1);
        const attempt = (attempts.get(taskId) ?? 0) + 1;
        attempts.set(taskId, attempt);
        writing.set(taskId, policy.capabilities.write);
        const work = this.runTask(state, run, taskId, policy, attempt, workingDirectory!)
          .then((result) => {
            if (result === "retry") retries.push(taskId);
          })
          .finally(() => {
            state.inflight.delete(taskId);
            writing.delete(taskId);
            finished += 1;
          });
        state.inflight.set(taskId, work);
      }

      if (state.inflight.size === 0) {
        // Work that ended during the reads above can unblock or retry a task: look again.
        if (finished !== finishedBeforeReading) continue;
        break;
      }
      await Promise.race(state.inflight.values());
    }

    // Independent work that never started because something else failed.
    for (const task of await this.store.listTasks(run.id)) {
      if (task.status === "pending" || task.status === "ready") {
        await this.moveTask(task.id, "skipped", { completedAt: this.now() });
      }
    }
  }

  private async finish(run: Run): Promise<void> {
    const tasks = await this.store.listTasks(run.id);
    const failed = tasks.filter((task) => task.status === "failed");
    if (failed.length > 0) {
      const first = failed[0]!;
      const detail = `"${first.title}": ${first.error ?? "no error recorded"}`;
      await this.moveRun(run.id, "failed", {
        error: failed.length === 1 ? `Task ${detail}` : `${failed.length} tasks failed. First: ${detail}`,
        completedAt: this.now(),
      });
      return;
    }
    const dependencies = await this.store.listDependencies(run.id);
    await this.moveRun(run.id, "completed", { finalOutput: finalOutputOf(run, tasks, dependencies), completedAt: this.now() });
  }

  // ---------------------------------------------------------------------------
  // One Task, one attempt
  // ---------------------------------------------------------------------------

  /** Never rejects for a failed attempt; it records the failure and says what should happen next. */
  private async runTask(
    state: RunState,
    run: Run,
    taskId: string,
    policy: ResolvedPolicy,
    attempt: number,
    workingDirectory: string,
  ): Promise<TaskResult> {
    let task = await this.requireTask(taskId);
    if (attempt === 1) task = await this.moveTask(taskId, "running", { startedAt: this.now() });

    const used = (await this.store.listExecutions(run.id)).reduce(
      (total, execution) => total + (execution.usage?.inputTokens ?? 0) + (execution.usage?.outputTokens ?? 0),
      0,
    );
    if (used >= this.limits.maxRunTokens) {
      await this.moveTask(taskId, "failed", {
        error: `This run used ${used} tokens, reaching its budget of ${this.limits.maxRunTokens}, so no more work was started.`,
        completedAt: this.now(),
      });
      return "failed";
    }

    const agent = task.assignedAgentId === null ? null : await this.agents.getAgent(task.assignedAgentId);
    if (agent === null || !agent.enabled || agent.archivedAt !== null) {
      await this.moveTask(taskId, "failed", { error: "The assigned agent is no longer available.", completedAt: this.now() });
      return "failed";
    }

    let launch: Launch;
    try {
      launch = await this.launch(state, run, task, agent.id, attempt, policy);
    } catch (error) {
      if (state.cancelRequested) return "cancelled";
      // Without a guard nothing may run: fail closed, and do not retry.
      await this.moveTask(taskId, "failed", { error: errorMessage(error), completedAt: this.now() });
      return "failed";
    }

    // A stopped attempt still spent these tokens, so they count towards the Run's budget.
    let usage: ExecutionUsage | null = null;
    try {
      const { inputs, withheld } = await this.handOff(launch, run, task);
      const continuityContext = await this.continuityContext(run);
      const outcome = await this.runtime.execute({
        run,
        task,
        execution: launch.execution,
        agent,
        workingDirectory,
        prompt: buildTaskPrompt({
          task,
          instructions: agent.instructions,
          inputs,
          withheld,
          ...(continuityContext === undefined ? {} : { continuityContext }),
          nonce: randomUUID().replaceAll("-", "").slice(0, 12),
        }),
        runtimePolicy: policy.runtime,
        gate: launch.gate,
        signal: state.abort.signal,
      });
      usage = outcome.usage;
      if (launch.stopReason !== null) throw new ExecutionStoppedError(launch.stopReason);
      this.throwIfCancelled(state);
      await launch.guard.complete?.(outcome.threadId);
      await this.moveExecution(launch.execution.id, "completed", {
        output: outcome.output,
        threadId: outcome.threadId,
        usage: outcome.usage,
        tracePath: outcome.tracePath,
        traceTruncated: outcome.traceTruncated,
        completedAt: this.now(),
      });
      if (outcome.disposition === null) {
        await this.moveTask(taskId, "failed", {
          result: outcome.output,
          error: "The agent finished without a valid task disposition.",
          completedAt: this.now(),
        });
        return "failed";
      }
      if (outcome.disposition.status === "incomplete") {
        await this.moveTask(taskId, "failed", {
          result: outcome.output,
          error: `The agent reported the task incomplete: ${outcome.output}`,
          completedAt: this.now(),
        });
        return "failed";
      }
      await this.moveTask(taskId, "completed", { result: outcome.output, completedAt: this.now() });
      return "completed";
    } catch (error) {
      if (state.cancelRequested) return "cancelled";
      const stopped = launch.stopReason !== null;
      // A stopped execution can contain the deterministic finding that
      // reflection memory exists to carry into later Runs.
      await launch.guard.complete?.(null);
      const message = stopped && !(error instanceof ExecutionStoppedError)
        ? new ExecutionStoppedError(launch.stopReason!).message
        : errorMessage(error);
      // A failed attempt is the one whose trace matters most; keep its pointer.
      const trace = traceOf(error);
      await this.moveExecution(launch.execution.id, "failed", {
        error: message,
        usage: usage ?? usageOf(error),
        completedAt: this.now(),
        ...(trace === null ? {} : { tracePath: trace.path, traceTruncated: trace.truncated }),
      });
      if (stopped || launch.refused || attempt >= this.limits.maxAttempts) {
        await this.moveTask(taskId, "failed", { error: message, completedAt: this.now() });
        return "failed";
      }
      return "retry";
    } finally {
      await launch.guard.close().catch(() => undefined);
    }
  }

  /** A few bounded prior prompt/report pairs help resolve references without
   * making previous Runs authoritative or changing the current user goal. */
  private async continuityContext(run: Run): Promise<string | undefined> {
    const entries: string[] = [];
    let parentRunId = run.parentRunId;
    let remaining = 8_000;
    for (let depth = 0; parentRunId !== null && depth < 3 && remaining > 0; depth += 1) {
      const parent = await this.store.getRun(parentRunId);
      if (parent === null) break;
      const entry = [
        `Run ${parent.id} (${parent.status})`,
        `Previous request: ${redactSensitiveText(parent.userPrompt).slice(0, 1_500)}`,
        `Previous report: ${redactSensitiveText(parent.finalOutput ?? parent.error ?? "No report was saved.").slice(0, 1_500)}`,
      ].join("\n");
      const bounded = entry.slice(0, remaining);
      entries.push(bounded);
      remaining -= bounded.length;
      parentRunId = parent.parentRunId;
    }
    return entries.length === 0 ? undefined : entries.join("\n\n");
  }

  /**
   * Each completed dependency's result becomes input to this task only if the
   * middleware allows the handoff, evaluated on the receiving execution.
   */
  private async handOff(launch: Launch, run: Run, task: Task): Promise<{ inputs: TaskInput[]; withheld: WithheldInput[] }> {
    const dependencyIds = (await this.store.listDependencies(run.id))
      .filter((edge) => edge.taskId === task.id)
      .map((edge) => edge.dependsOnTaskId);
    const inputs: TaskInput[] = [];
    const withheld: WithheldInput[] = [];
    for (const dependencyId of dependencyIds) {
      const dependency = await this.requireTask(dependencyId);
      const content = dependency.result ?? "";
      const decision = await launch.gate.decide({
        type: "context_handoff",
        actionId: this.actionId("handoff"),
        fromTaskId: dependency.id,
        toTaskId: task.id,
        content,
      });
      if (launch.stopReason !== null) throw new ExecutionStoppedError(launch.stopReason);
      if (permits(decision)) {
        inputs.push({ title: dependency.title, content, steer: decision.outcome === "steer" ? decision.steer : null });
      } else {
        withheld.push({ title: dependency.title, steer: decision.outcome === "block" ? decision.steer : null });
      }
    }
    return { inputs, withheld };
  }

  /** Resolve-then-snapshot the policy, create the execution, and open its guard. */
  private async launch(
    state: RunState,
    run: Run,
    task: Task,
    agentId: string,
    attempt: number,
    policy: ResolvedPolicy,
  ): Promise<Launch> {
    const now = this.now();
    const created = await this.store.createExecution({
      id: this.newId(),
      runId: run.id,
      taskId: task.id,
      agentId,
      attempt,
      status: "queued",
      capabilities: policy.capabilities,
      threadId: null,
      output: null,
      error: null,
      usage: null,
      tracePath: null,
      traceTruncated: false,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    });
    let guard: ExecutionGuard;
    try {
      guard = await this.middleware.openExecution({
        workspaceId: run.workspaceId,
        runId: run.id,
        taskId: task.id,
        executionId: created.id,
        agentId,
      });
    } catch (error) {
      await this.moveExecution(created.id, "failed", {
        error: `The security middleware could not open a guard: ${errorMessage(error)}`,
        completedAt: this.now(),
      });
      throw error;
    }
    const execution = await this.moveExecution(created.id, "running", { startedAt: this.now() }, (started) =>
      this.auditEvent(run.workspaceId, run.id, "execution.started", { type: "agent", id: agentId }, {
        taskId: task.id,
        executionId: started.id,
        metadata: { attempt, capabilities: policy.capabilities, appliedPolicies: policy.appliedPolicies },
      }),
    );
    const launch: Launch = { execution, task, guard, policy, gate: undefined as unknown as ActionGate, stopReason: null, refused: false };
    launch.gate = this.gateFor(state, launch);
    return launch;
  }

  private gateFor(state: RunState, launch: Launch): ActionGate {
    return {
      decide: async (action) => {
        this.throwIfCancelled(state);
        if (action.type === "delegation") {
          await this.auditFor(launch, "delegation.requested", { actionId: action.actionId, ...safeDetailsOf(action) });
        }
        const decision = await launch.guard.evaluate(action);
        await this.recordFindings(launch, decision);
        const final = decision.outcome === "require_approval"
          ? await this.awaitApproval(state, launch, action, decision)
          : decision;
        noteDecision(launch, final);
        await this.auditFor(launch, "security.decision", {
          source: "evaluate",
          actionType: action.type,
          actionId: action.actionId,
          requiredApproval: decision.outcome === "require_approval",
          ...decisionSummary(final),
          ...auditedProposal(action),
        });
        return final;
      },
      observe: async (record) => {
        const decision = await launch.guard.observe(record);
        if (decision !== null) {
          await this.recordFindings(launch, decision);
          noteDecision(launch, decision);
          await this.auditFor(launch, "security.decision", { source: "observe", traceSeq: record.seq, ...decisionSummary(decision) });
        }
        return decision;
      },
    };
  }

  private async recordFindings(launch: Launch, decision: SecurityDecision): Promise<void> {
    for (const finding of decision.findings) {
      await this.store.addFinding({
        ...finding,
        id: this.newId(),
        runId: launch.execution.runId,
        taskId: launch.task.id,
        executionId: launch.execution.id,
        agentId: launch.execution.agentId,
        createdAt: this.now(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Approvals
  // ---------------------------------------------------------------------------

  private async awaitApproval(
    state: RunState,
    launch: Launch,
    action: ProposedAction,
    decision: Extract<SecurityDecision, { outcome: "require_approval" }>,
  ): Promise<SecurityDecision> {
    const { execution, task } = launch;
    // Wait before the approval is visible, so even an instant answer finds a waiter.
    const approvalId = this.newId();
    const answer = new Promise<Answer>((resolve) => this.waiters.set(approvalId, resolve));

    await this.locked(state, async () => {
      if (state.cancelRequested) {
        this.waiters.delete(approvalId);
        throw new RunCancelledError();
      }
      const requestedAt = this.now();
      const workspaceId = await this.workspaceOf(execution.runId);
      // Announce the approval first: Run.waiting_approval means one is pending.
      await this.store.requestApproval({
        id: approvalId,
        runId: execution.runId,
        taskId: task.id,
        executionId: execution.id,
        agentId: execution.agentId,
        actionType: action.type,
        actionId: action.actionId,
        reason: decision.approvalReason,
        summary: decision.reason,
        safeDetails: safeDetailsOf(action),
        status: "pending",
        requestedAt,
        expiresAt: new Date(Date.parse(requestedAt) + this.limits.approvalTtlMs).toISOString(),
        resolvedAt: null,
        resolvedByUserId: null,
      }, () =>
        this.auditEventFor(workspaceId, launch, "approval.requested", {
          approvalId,
          actionType: action.type,
          actionId: action.actionId,
          reason: decision.approvalReason,
        }),
      );
      await this.moveExecution(execution.id, "waiting_approval");
      await this.moveTask(task.id, "waiting_approval");
      const run = await this.requireRun(execution.runId);
      if (run.status !== "waiting_approval") await this.moveRun(run.id, "waiting_approval");
    });

    const outcome = await answer;
    const final = await launch.guard.recordApprovalOutcome(action.actionId, outcome);
    await this.recordFindings(launch, final);
    if (outcome === "cancelled") throw new RunCancelledError();

    // Whatever the answer, the execution carries on; a refusal declines only this action.
    await this.locked(state, async () => {
      await this.moveExecution(execution.id, "running");
      await this.moveTask(task.id, "running");
      const pending = (await this.store.listApprovals(execution.runId)).filter((item) => item.status === "pending");
      const run = await this.requireRun(execution.runId);
      if (run.status === "waiting_approval" && pending.length === 0) await this.moveRun(run.id, state.phase);
    });
    return final;
  }

  /**
   * An answer from outside the Run's work waits until the approval has been
   * fully announced, so Run.waiting_approval never outlives the last pending
   * approval when the answer comes back faster than the announcement.
   */
  private async answerApproval(approvalId: string, status: Answer, userId: string | null): Promise<Approval> {
    const approval = await this.store.getApproval(approvalId);
    const state = approval === null ? undefined : this.active.get(approval.runId);
    const settle = () => this.settleApproval(approvalId, status, userId);
    return state === undefined ? settle() : this.locked(state, settle);
  }

  private async settleApproval(approvalId: string, status: Answer, userId: string | null): Promise<Approval> {
    const approval = await this.store.getApproval(approvalId);
    if (approval === null) throw new HttpError(404, "Approval not found");
    if (approval.status !== "pending" || this.settling.has(approvalId)) {
      throw new HttpError(409, `Approval is already ${approval.status === "pending" ? "being resolved" : approval.status}`);
    }
    this.settling.add(approvalId);
    try {
      const workspaceId = await this.workspaceOf(approval.runId);
      const resolved = await this.store.resolveApproval(approvalId, status, userId, (settled) =>
        this.auditEvent(workspaceId, settled.runId, "approval.resolved", userId === null ? { type: "system" } : { type: "user", id: userId }, {
          taskId: settled.taskId,
          executionId: settled.executionId,
          metadata: { approvalId, status, actionType: settled.actionType, actionId: settled.actionId },
        }),
      );
      this.waiters.get(approvalId)?.(status);
      this.waiters.delete(approvalId);
      return resolved;
    } finally {
      this.settling.delete(approvalId);
    }
  }

  private async cancelPendingApprovals(runId: string): Promise<void> {
    for (const approval of await this.store.listApprovals(runId)) {
      if (approval.status !== "pending") continue;
      await this.settleApproval(approval.id, "cancelled", null).catch((error: unknown) => {
        if (!(error instanceof HttpError && error.statusCode === 409)) throw error;
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Ending a Run
  // ---------------------------------------------------------------------------

  private async finishCancelled(runId: string): Promise<void> {
    await this.closeOpenWork(runId, "cancelled", null);
    const run = await this.requireRun(runId);
    if (!isTerminalRunStatus(run.status)) await this.moveRun(runId, "cancelled", { completedAt: this.now() });
  }

  private async failRun(runId: string, error: string): Promise<void> {
    await this.closeOpenWork(runId, "failed", error);
    const run = await this.requireRun(runId);
    if (!isTerminalRunStatus(run.status)) await this.moveRun(runId, "failed", { error, completedAt: this.now() });
  }

  /** A finished Run has no pending approvals and no open tasks or executions. */
  private async closeOpenWork(runId: string, as: "cancelled" | "failed", error: string | null): Promise<void> {
    await this.cancelPendingApprovals(runId);
    const completedAt = this.now();
    for (const execution of await this.store.listExecutions(runId)) {
      if (isTerminalExecutionStatus(execution.status)) continue;
      await this.moveExecution(execution.id, as, as === "failed" ? { error, completedAt } : { completedAt });
    }
    for (const task of await this.store.listTasks(runId)) {
      if (isTerminalTaskStatus(task.status)) continue;
      const started = task.status === "running" || task.status === "waiting_approval";
      if (as === "cancelled") await this.moveTask(task.id, "cancelled", { completedAt });
      else if (started) await this.moveTask(task.id, "failed", { error, completedAt });
      else await this.moveTask(task.id, "skipped", { completedAt });
    }
  }

  // ---------------------------------------------------------------------------
  // Guarded writes
  // ---------------------------------------------------------------------------

  /** `createdByAgentId` is the agent whose delegation created it; null for tasks the platform creates. */
  private async createTask(
    run: Run,
    fields: Pick<Task, "title" | "objective" | "assignedAgentId" | "parentTaskId" | "createdByExecutionId" | "status">,
    dependsOnTaskIds: string[],
    createdByAgentId: string | null = null,
  ): Promise<Task> {
    const now = this.now();
    const task = await this.store.createTask({
      id: this.newId(),
      runId: run.id,
      ...fields,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    }, dependsOnTaskIds, (created) =>
      this.auditEvent(run.workspaceId, run.id, "task.created", createdByAgentId === null ? { type: "system" } : { type: "agent", id: createdByAgentId }, {
        taskId: created.id,
        executionId: created.createdByExecutionId,
        metadata: { title: created.title, assignedAgentId: created.assignedAgentId, parentTaskId: created.parentTaskId, dependsOnTaskIds },
      }),
    );
    return task;
  }

  private async moveRun(runId: string, to: RunStatus, changes: Partial<Run> = {}): Promise<Run> {
    const run = await this.requireRun(runId);
    if (run.status !== to && !canTransitionRun(run.status, to)) {
      throw new Error(`Illegal run transition ${run.status} -> ${to} for run ${runId}`);
    }
    return this.store.updateRun(runId, { ...changes, status: to }, (updated) =>
      run.status === to
        ? null
        : this.auditEvent(run.workspaceId, runId, "run.status_changed", { type: "system" }, {
            metadata: { from: run.status, to, ...(updated.error === null ? {} : { error: safeText(updated.error) }) },
          }),
    );
  }

  private async moveTask(taskId: string, to: TaskStatus, changes: Partial<Task> = {}): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (task.status !== to && !canTransitionTask(task.status, to)) {
      throw new Error(`Illegal task transition ${task.status} -> ${to} for task ${taskId}`);
    }
    const workspaceId = await this.workspaceOf(task.runId);
    const updated = await this.store.updateTask(taskId, { ...changes, status: to }, (written) =>
      task.status === to
        ? null
        : this.auditEvent(workspaceId, task.runId, "task.status_changed", { type: "system" }, {
            taskId,
            metadata: { from: task.status, to, ...(written.error === null ? {} : { error: safeText(written.error) }) },
          }),
    );
    return updated;
  }

  private async moveExecution(
    executionId: string,
    to: ExecutionStatus,
    changes: Partial<AgentExecution> = {},
    audit?: AuditFor<AgentExecution>,
  ): Promise<AgentExecution> {
    const execution = await this.store.getExecution(executionId);
    if (execution === null) throw new Error(`Unknown execution ${executionId}`);
    if (execution.status !== to && !canTransitionExecution(execution.status, to)) {
      throw new Error(`Illegal execution transition ${execution.status} -> ${to} for execution ${executionId}`);
    }
    const workspaceId = await this.workspaceOf(execution.runId);
    return this.store.updateExecution(executionId, { ...changes, status: to }, (updated) =>
      execution.status !== to && isTerminalExecutionStatus(to)
        ? this.auditEvent(workspaceId, execution.runId, "execution.finished", { type: "agent", id: execution.agentId }, {
            taskId: execution.taskId,
            executionId,
            metadata: {
              status: to,
              attempt: execution.attempt,
              ...(updated.error === null ? {} : { error: safeText(updated.error) }),
              ...(updated.tracePath === null ? {} : { tracePath: updated.tracePath }),
            },
          })
        : (audit?.(updated) ?? null),
    );
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  /**
   * One audit event for a Run. Metadata carries identifiers, statuses and
   * redacted, bounded summaries only: never raw commands, file contents or
   * results, which stay in the trace and the entities themselves. An event
   * that describes a write is handed to that write, so it is stored with it.
   */
  private auditEvent(
    workspaceId: string,
    runId: string,
    eventType: AuditEventType,
    actor: { type: "user" | "agent"; id: string } | { type: "system" },
    fields: { taskId?: string | null; executionId?: string | null; metadata?: JsonObject } = {},
  ): AuditEvent {
    return {
      id: this.newId(),
      workspaceId,
      actorType: actor.type,
      actorId: actor.type === "system" ? null : actor.id,
      eventType,
      runId,
      taskId: fields.taskId ?? null,
      executionId: fields.executionId ?? null,
      metadata: fields.metadata ?? null,
      createdAt: this.now(),
    };
  }

  /** An event caused by the agent acting in this execution. */
  private auditEventFor(workspaceId: string, launch: Launch, eventType: AuditEventType, metadata: JsonObject): AuditEvent {
    return this.auditEvent(workspaceId, launch.execution.runId, eventType, { type: "agent", id: launch.execution.agentId }, {
      taskId: launch.task.id,
      executionId: launch.execution.id,
      metadata,
    });
  }

  /** Records an event that goes with no write, such as a security decision. */
  private async auditFor(launch: Launch, eventType: AuditEventType, metadata: JsonObject): Promise<void> {
    await this.store.appendAudit(this.auditEventFor(await this.workspaceOf(launch.execution.runId), launch, eventType, metadata));
  }

  private async workspaceOf(runId: string): Promise<string> {
    const known = this.workspaces.get(runId);
    if (known !== undefined) return known;
    const { workspaceId } = await this.requireRun(runId);
    this.workspaces.set(runId, workspaceId);
    return workspaceId;
  }

  private async requireRun(runId: string): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (run === null) throw new Error(`Unknown run ${runId}`);
    return run;
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (task === null) throw new Error(`Unknown task ${taskId}`);
    return task;
  }

  private throwIfCancelled(state: RunState): void {
    if (state.cancelRequested) throw new RunCancelledError();
  }

  private actionId(kind: "delegation" | "handoff"): string {
    return `${kind}-${this.newId()}`;
  }

  private async locked<T>(state: RunState, work: () => Promise<T>): Promise<T> {
    const previous = state.lock;
    let release!: () => void;
    state.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

/**
 * Expire overdue approvals every `intervalMs`, so an unanswered request
 * declines its action instead of holding the execution forever. One periodic
 * query rather than a timer per approval, which also covers approvals that
 * were pending across a restart. Returns a function that stops the sweep.
 */
export function startApprovalSweep(
  orchestrator: Pick<Orchestrator, "expireDueApprovals">,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): () => void {
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    orchestrator
      .expireDueApprovals()
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        sweeping = false;
      });
  }, options.intervalMs ?? 5_000);
  timer.unref();
  return () => clearInterval(timer);
}

function noteDecision(launch: Launch, decision: SecurityDecision): void {
  if (decision.outcome !== "block") return;
  launch.refused = true;
  if (decision.stop === "execution") launch.stopReason ??= decision.reason;
}

/** What the Run reports as its result. A reviewer/synthesis step replaces this in Week 10. */
/**
 * The Run's result: what its final tasks produced, the ones no other task
 * depends on. Earlier results already flowed into those tasks as inputs, so a
 * plan that ends with a review task reports exactly that review. No extra
 * model call summarises anything: that would cost tokens and give agent output
 * one more place to steer what the user is told.
 */
function finalOutputOf(run: Run, tasks: readonly Task[], dependencies: readonly TaskDependency[]): string {
  if (run.orchestrationMode === "single") return tasks[0]?.result ?? "";
  const completed = tasks.filter((task) => task.parentTaskId !== null && task.status === "completed");
  if (completed.length === 0) return "The supervisor delegated no tasks.";
  const dependedOn = new Set(dependencies.map((edge) => edge.dependsOnTaskId));
  const final = completed.filter((task) => !dependedOn.has(task.id));
  if (final.length === 1) return final[0]!.result ?? "";
  return final.map((task) => `## ${task.title}\n${task.result ?? ""}`).join("\n\n");
}

/** What an audit record keeps of a decision: the outcome and why, not the evidence. */
function decisionSummary(decision: SecurityDecision): JsonObject {
  return {
    outcome: decision.outcome,
    severity: decision.severity,
    reason: safeText(decision.reason),
    ...(decision.outcome === "block" ? { stop: decision.stop } : {}),
    findingCodes: decision.findings.map((finding) => `${finding.layer}:${finding.code}`),
    appliedPolicies: decision.appliedPolicies,
  };
}

/** Redacted, bounded details an approver can safely see. */
function safeDetailsOf(action: ProposedAction): JsonObject {
  switch (action.type) {
    case "command":
      return { command: bounded(redactSensitiveText(action.command), 200_000), cwd: action.cwd };
    case "file_change":
      return {
        files: action.changes.slice(0, 50).map((change) => ({
          path: bounded(redactSensitiveText(change.path), 300),
          kind: change.kind,
          ...(change.movePath === null ? {} : { movePath: bounded(redactSensitiveText(change.movePath), 300) }),
        })),
        ...(action.changes.length > 50 ? { filesTotal: action.changes.length } : {}),
      };
    case "delegation":
      return {
        targetAgentId: action.targetAgentId,
        title: bounded(redactSensitiveText(action.title), 120),
        objective: bounded(redactSensitiveText(action.objective), 1_000),
      };
    case "context_handoff":
      return { fromTaskId: action.fromTaskId, toTaskId: action.toTaskId, characters: action.content.length };
  }
}

/**
 * What the Run Detail timeline shows of an action that goes to no person: file
 * paths, handoff ids, and a command's redacted, length-limited text (decision 14).
 */
function auditedProposal(action: ProposedAction): JsonObject {
  return action.type === "delegation" ? {} : { proposed: safeDetailsOf(action) };
}

/** Free text for audit metadata, such as an error that may quote a container's stderr. */
function safeText(text: string): string {
  return bounded(redactSensitiveText(text), 500);
}

function titleFrom(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim().length > 0) ?? prompt;
  return bounded(firstLine.replace(/\s+/g, " ").trim(), 80) || "Task";
}

function bounded(text: string, maximum: number): string {
  return text.length <= maximum ? text : text.slice(0, maximum - 1) + "…";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return bounded(message.trim() || "Unknown error", 2_000);
}

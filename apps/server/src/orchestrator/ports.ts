import type {
  Agent,
  AgentExecution,
  Approval,
  ApprovalStatus,
  ExecutionUsage,
  OrchestrationMode,
  ProposedAction,
  Run,
  SecurityDecision,
  SecurityFinding,
  Task,
  TaskDependency,
} from "@launchpad/shared";
import type { TraceRecord } from "../trace.js";
import type { TurnSecurityPolicy } from "../turn-security-policy.js";

// What the orchestrator needs from the subsystems around it. Each one is owned
// by someone else; the orchestrator only depends on these shapes:
//
//   RunStore          persistence (P3). In-memory today, PostgreSQL later.
//   AgentDirectory    agent registry (P3 storage, P1/P2 semantics).
//   SecurityMiddleware                (P1), in ../security-middleware.ts.
//   ExecutionRuntime  runs one AgentExecution. Week 9 adapts the Codex
//                     runners to it; tests use a scripted one.
//   Planner           the supervisor's planning call, in ./planner.ts.

/**
 * Persistence for the Run -> Task -> AgentExecution model.
 *
 * Every write that changes an entity also stamps `updatedAt`, and publishes
 * the matching RunEvent after it commits, with the run's next seq assigned in
 * the same write (docs/contract-decisions.md, decision 9). The orchestrator
 * checks status transitions before it writes; the store does not.
 */
export interface RunStore {
  createRun(run: Run): Promise<Run>;
  getRun(runId: string): Promise<Run | null>;
  updateRun(runId: string, changes: Partial<Run>): Promise<Run>;

  getTask(taskId: string): Promise<Task | null>;
  /** Tasks in creation order. */
  listTasks(runId: string): Promise<Task[]>;
  listDependencies(runId: string): Promise<TaskDependency[]>;
  createTask(task: Task, dependsOnTaskIds: string[]): Promise<Task>;
  updateTask(taskId: string, changes: Partial<Task>): Promise<Task>;

  getExecution(executionId: string): Promise<AgentExecution | null>;
  listExecutions(runId: string): Promise<AgentExecution[]>;
  createExecution(execution: AgentExecution): Promise<AgentExecution>;
  updateExecution(executionId: string, changes: Partial<AgentExecution>): Promise<AgentExecution>;

  addFinding(finding: SecurityFinding): Promise<SecurityFinding>;

  getApproval(approvalId: string): Promise<Approval | null>;
  listApprovals(runId: string): Promise<Approval[]>;
  requestApproval(approval: Approval): Promise<Approval>;
  resolveApproval(
    approvalId: string,
    status: Exclude<ApprovalStatus, "pending">,
    resolvedByUserId: string | null,
  ): Promise<Approval>;
}

export interface AgentDirectory {
  getAgent(agentId: string): Promise<Agent | null>;
  /** Every agent in the workspace, including disabled and archived ones. */
  listAgents(workspaceId: string): Promise<Agent[]>;
  /** The agent a Run uses when the request names none: the supervisor for `auto`. */
  defaultAgentId(workspaceId: string, mode: OrchestrationMode): Promise<string | null>;
}

/**
 * The orchestrator's side of one execution's security guard, handed to the
 * runtime. It wraps ExecutionGuard with what only the orchestrator can do:
 * persist findings, open and wait for approvals, and remember a stop.
 */
export interface ActionGate {
  /**
   * Call before a gated action runs. Resolves with the final decision, after
   * any human approval. The action may run only on allow or steer. A block
   * with `stop: "execution"` means the runtime must end the turn now.
   * Rejects with RunCancelledError when the run is being cancelled.
   */
  decide(action: ProposedAction): Promise<SecurityDecision>;
  /** Every raw trace record, in order. A returned decision is already recorded. */
  observe(record: TraceRecord): Promise<SecurityDecision | null>;
}

export interface ExecutionRequest {
  run: Run;
  task: Task;
  execution: AgentExecution;
  agent: Agent;
  /** The task objective plus earlier tasks' results, built by the orchestrator. */
  prompt: string;
  /** Chosen by the middleware, never by the orchestrator (contract decision 3). */
  runtimePolicy: TurnSecurityPolicy;
  gate: ActionGate;
  /** Aborted when the run is cancelled. The runtime should stop and reject. */
  signal: AbortSignal;
}

export interface ExecutionOutcome {
  /** The agent's final message: the task's result. */
  output: string;
  threadId: string | null;
  usage: ExecutionUsage | null;
  tracePath: string | null;
  traceTruncated: boolean;
}

export interface ExecutionRuntime {
  /** Run one execution to completion. Throws on failure; the orchestrator decides about retries. */
  execute(request: ExecutionRequest): Promise<ExecutionOutcome>;
}

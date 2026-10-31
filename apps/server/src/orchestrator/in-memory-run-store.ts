import {
  auditEventSchema,
  isTerminalRunStatus,
  RUN_LIST_DEFAULT_LIMIT,
  type AgentExecution,
  type Approval,
  type ApprovalStatus,
  type AuditEvent,
  type AuditEventType,
  type Run,
  type RunEventDraft,
  type RunListQuery,
  type RunListResponse,
  type RunSnapshot,
  type SecurityFinding,
  type Task,
  type TaskDependency,
} from "@launchpad/shared";
import type { RunEventHub } from "../run-events.js";
import { decodeRunCursor, encodeRunCursor, summaryPrompt } from "../run-list.js";
import type { AuditFor, RunAudit, RunReads, RunStore } from "./ports.js";

type Uncommitted = RunEventDraft extends infer D ? (D extends RunEventDraft ? Omit<D, "seq"> : never) : never;

/**
 * RunStore kept in memory, for tests and for running without DATABASE_URL
 * (db/postgres-run-store.ts is the PostgreSQL one). Like the database, it
 * assigns each Run's next event seq together with the write and publishes
 * after it.
 */
export class InMemoryRunStore implements RunStore, RunReads {
  private readonly runs = new Map<string, Run>();
  private readonly tasks = new Map<string, Task>();
  private readonly dependencies: TaskDependency[] = [];
  private readonly executions = new Map<string, AgentExecution>();
  private readonly findings = new Map<string, SecurityFinding>();
  private readonly approvals = new Map<string, Approval>();
  private readonly lastEventSeq = new Map<string, number>();
  private readonly audit: AuditEvent[] = [];

  constructor(
    private readonly hub: RunEventHub,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async createRun(run: Run, audit?: AuditFor<Run>): Promise<Run> {
    this.record(audit, run);
    this.runs.set(run.id, run);
    this.commit({ runId: run.id, type: "run.updated", payload: { run } });
    return run;
  }

  async getRun(runId: string): Promise<Run | null> {
    return this.runs.get(runId) ?? null;
  }

  async listActiveRuns(): Promise<Run[]> {
    return [...this.runs.values()].filter((run) => !isTerminalRunStatus(run.status));
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    // Validated here so a malformed event fails where it was produced.
    this.audit.push(Object.freeze(auditEventSchema.parse(event)));
  }

  private record<T>(audit: AuditFor<T> | undefined, written: T): void {
    const event = audit?.(written) ?? null;
    if (event !== null) this.audit.push(Object.freeze(auditEventSchema.parse(event)));
  }

  /** Audit events in the order they were appended, optionally for one run. Not part of RunStore. */
  auditEvents(runId?: string): AuditEvent[] {
    return runId === undefined ? [...this.audit] : this.audit.filter((event) => event.runId === runId);
  }

  async runAudit(runId: string, eventType: AuditEventType, limit: number): Promise<RunAudit> {
    const events = this.audit.filter((event) => event.runId === runId && event.eventType === eventType);
    return { events: events.slice(-limit), total: events.length };
  }

  async updateRun(runId: string, changes: Partial<Run>, audit?: AuditFor<Run>): Promise<Run> {
    const run = this.touch(this.required(this.runs, runId, "run"), changes);
    this.record(audit, run);
    this.runs.set(runId, run);
    this.commit({ runId, type: "run.updated", payload: { run } });
    return run;
  }

  async getTask(taskId: string): Promise<Task | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async listTasks(runId: string): Promise<Task[]> {
    return this.inRun(this.tasks, runId);
  }

  async listDependencies(runId: string): Promise<TaskDependency[]> {
    return this.dependencies.filter((edge) => edge.runId === runId);
  }

  async createTask(task: Task, dependsOnTaskIds: string[], audit?: AuditFor<Task>): Promise<Task> {
    this.record(audit, task);
    this.tasks.set(task.id, task);
    for (const dependsOnTaskId of dependsOnTaskIds) {
      this.dependencies.push({ runId: task.runId, taskId: task.id, dependsOnTaskId });
    }
    this.commit({ runId: task.runId, type: "task.created", payload: { task, dependsOnTaskIds } });
    return task;
  }

  async updateTask(taskId: string, changes: Partial<Task>, audit?: AuditFor<Task>): Promise<Task> {
    const task = this.touch(this.required(this.tasks, taskId, "task"), changes);
    this.record(audit, task);
    this.tasks.set(taskId, task);
    this.commit({ runId: task.runId, type: "task.updated", payload: { task } });
    return task;
  }

  async getExecution(executionId: string): Promise<AgentExecution | null> {
    return this.executions.get(executionId) ?? null;
  }

  async listExecutions(runId: string): Promise<AgentExecution[]> {
    return this.inRun(this.executions, runId);
  }

  async createExecution(execution: AgentExecution): Promise<AgentExecution> {
    this.executions.set(execution.id, execution);
    this.commit({ runId: execution.runId, type: "execution.updated", payload: { execution } });
    return execution;
  }

  async updateExecution(
    executionId: string,
    changes: Partial<AgentExecution>,
    audit?: AuditFor<AgentExecution>,
  ): Promise<AgentExecution> {
    const execution = this.touch(this.required(this.executions, executionId, "execution"), changes);
    this.record(audit, execution);
    this.executions.set(executionId, execution);
    this.commit({ runId: execution.runId, type: "execution.updated", payload: { execution } });
    return execution;
  }

  async addFinding(finding: SecurityFinding): Promise<SecurityFinding> {
    this.findings.set(finding.id, finding);
    this.commit({ runId: finding.runId, type: "finding.created", payload: { finding } });
    return finding;
  }

  async getApproval(approvalId: string): Promise<Approval | null> {
    return this.approvals.get(approvalId) ?? null;
  }

  async listApprovals(runId: string): Promise<Approval[]> {
    return this.inRun(this.approvals, runId);
  }

  async listExpiredApprovals(asOf: string): Promise<Approval[]> {
    const cutoff = Date.parse(asOf);
    return [...this.approvals.values()].filter(
      (approval) => approval.status === "pending" && approval.expiresAt !== null && Date.parse(approval.expiresAt) <= cutoff,
    );
  }

  async requestApproval(approval: Approval, audit?: AuditFor<Approval>): Promise<Approval> {
    this.record(audit, approval);
    this.approvals.set(approval.id, approval);
    this.commit({ runId: approval.runId, type: "approval.requested", payload: { approval } });
    return approval;
  }

  async resolveApproval(
    approvalId: string,
    status: Exclude<ApprovalStatus, "pending">,
    resolvedByUserId: string | null,
    audit?: AuditFor<Approval>,
  ): Promise<Approval> {
    const approval: Approval = {
      ...this.required(this.approvals, approvalId, "approval"),
      status,
      resolvedAt: this.now(),
      resolvedByUserId,
    };
    this.record(audit, approval);
    this.approvals.set(approvalId, approval);
    this.commit({ runId: approval.runId, type: "approval.resolved", payload: { approval } });
    return approval;
  }

  async listRuns(workspaceId: string, query: RunListQuery): Promise<RunListResponse> {
    const after = query.cursor === undefined ? null : decodeRunCursor(query.cursor);
    const limit = query.limit ?? RUN_LIST_DEFAULT_LIMIT;
    const inWorkspace = [...this.runs.values()].filter((run) => run.workspaceId === workspaceId);
    const matching = inWorkspace
      .filter((run) => query.status === undefined || run.status === query.status)
      .sort(newestFirst)
      .filter((run) => after === null || newestFirst(run, after) > 0);
    const page = matching.slice(0, limit);
    const last = page.at(-1);
    return {
      runs: page.map((run) => ({
        id: run.id,
        workspaceId: run.workspaceId,
        createdByUserId: run.createdByUserId,
        orchestrationMode: run.orchestrationMode,
        status: run.status,
        cancelRequestedAt: run.cancelRequestedAt,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        userPrompt: summaryPrompt(run.userPrompt),
        taskCount: this.inRun(this.tasks, run.id).length,
        pendingApprovalCount: this.pendingIn(run.id),
        findingCount: this.inRun(this.findings, run.id).length,
      })),
      nextCursor: matching.length > limit && last !== undefined ? encodeRunCursor(last) : null,
      pendingApprovalCount: inWorkspace.reduce((total, run) => total + this.pendingIn(run.id), 0),
    };
  }

  private pendingIn(runId: string): number {
    return this.inRun(this.approvals, runId).filter((approval) => approval.status === "pending").length;
  }

  /** What GET /api/runs/:runId/snapshot returns. */
  snapshot(runId: string): RunSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      run,
      tasks: this.inRun(this.tasks, runId),
      dependencies: this.dependencies.filter((edge) => edge.runId === runId),
      executions: this.inRun(this.executions, runId),
      findings: this.inRun(this.findings, runId),
      approvals: this.inRun(this.approvals, runId),
      lastEventSeq: this.lastEventSeq.get(runId) ?? 0,
    };
  }

  private touch<T extends { updatedAt: string }>(entity: T, changes: Partial<T>): T {
    return { ...entity, ...changes, updatedAt: this.now() };
  }

  private required<T>(map: Map<string, T>, id: string, kind: string): T {
    const entity = map.get(id);
    if (entity === undefined) throw new Error(`Unknown ${kind} ${id}`);
    return entity;
  }

  private inRun<T extends { runId: string }>(map: Map<string, T>, runId: string): T[] {
    return [...map.values()].filter((entity) => entity.runId === runId);
  }

  private commit(draft: Uncommitted): void {
    const seq = (this.lastEventSeq.get(draft.runId) ?? 0) + 1;
    this.lastEventSeq.set(draft.runId, seq);
    this.hub.publish({ ...draft, seq } as RunEventDraft);
  }
}

/** The listing's order, the same as ORDER BY created_at DESC, id DESC. */
function newestFirst(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

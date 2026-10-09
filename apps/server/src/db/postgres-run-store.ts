import {
  agentExecutionSchema,
  approvalSchema,
  auditEventSchema,
  runSchema,
  securityFindingSchema,
  taskDependencySchema,
  taskSchema,
  type AgentExecution,
  type Approval,
  type ApprovalStatus,
  type AuditEvent,
  type Run,
  type RunEventDraft,
  type RunSnapshot,
  type SecurityFinding,
  type Task,
  type TaskDependency,
} from "@launchpad/shared";
import type pg from "pg";
import { HttpError } from "../errors.js";
import type { RunStore } from "../orchestrator/ports.js";
import type { RunEventHub } from "../run-events.js";
import { fromRow, insertRow, updateRow } from "./rows.js";

type Uncommitted = RunEventDraft extends infer D ? (D extends RunEventDraft ? Omit<D, "seq"> : never) : never;
type OutboxEntry = { event: RunEventDraft; committed: boolean };

/**
 * RunStore on PostgreSQL. Each write and its RunEvent seq commit in one
 * transaction, and the event is published after COMMIT (contract decision 9),
 * in seq order, so seqs keep increasing across server restarts. A write that
 * committed resolves even if publishing its event fails.
 */
export class PostgresRunStore implements RunStore {
  private readonly outboxes = new Map<string, OutboxEntry[]>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly hub: RunEventHub,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async createRun(run: Run): Promise<Run> {
    return this.write(run.id, async (db) => {
      const created = runSchema.parse(fromRow(await insertRow(db, "runs", run)));
      return { result: created, event: { runId: run.id, type: "run.updated", payload: { run: created } } };
    });
  }

  async getRun(runId: string): Promise<Run | null> {
    return this.one("SELECT * FROM runs WHERE id = $1", [runId], runSchema);
  }

  async listActiveRuns(): Promise<Run[]> {
    return this.many(
      "SELECT * FROM runs WHERE status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at, id",
      [],
      runSchema,
    );
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    // ponytail: its own statement, not the state change's transaction, because the port hands it over separately; add an audit argument to the write methods if an audit row must never be missing.
    await insertRow(this.pool, "audit_events", auditEventSchema.parse(event));
  }

  async updateRun(runId: string, changes: Partial<Run>): Promise<Run> {
    return this.write(runId, async (db) => {
      const run = runSchema.parse(fromRow(await updateRow(db, "runs", runId, this.touch(changes))));
      return { result: run, event: { runId, type: "run.updated", payload: { run } } };
    });
  }

  async getTask(taskId: string): Promise<Task | null> {
    return this.one("SELECT * FROM tasks WHERE id = $1", [taskId], taskSchema);
  }

  async listTasks(runId: string): Promise<Task[]> {
    return this.many("SELECT * FROM tasks WHERE run_id = $1 ORDER BY created_seq", [runId], taskSchema);
  }

  async listDependencies(runId: string): Promise<TaskDependency[]> {
    return this.many(
      "SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.run_id = $1 ORDER BY t.created_seq, d.depends_on_task_id",
      [runId],
      taskDependencySchema,
    );
  }

  async createTask(task: Task, dependsOnTaskIds: string[]): Promise<Task> {
    return this.write(task.runId, async (db) => {
      const created = taskSchema.parse(fromRow(await insertRow(db, "tasks", task)));
      for (const dependsOnTaskId of dependsOnTaskIds) {
        await insertRow(db, "task_dependencies", { runId: task.runId, taskId: task.id, dependsOnTaskId });
      }
      return { result: created, event: { runId: task.runId, type: "task.created", payload: { task: created, dependsOnTaskIds } } };
    });
  }

  async updateTask(taskId: string, changes: Partial<Task>): Promise<Task> {
    return this.write(await this.runOf("tasks", taskId), async (db) => {
      const task = taskSchema.parse(fromRow(await updateRow(db, "tasks", taskId, this.touch(changes))));
      return { result: task, event: { runId: task.runId, type: "task.updated", payload: { task } } };
    });
  }

  async getExecution(executionId: string): Promise<AgentExecution | null> {
    return this.one("SELECT * FROM agent_executions WHERE id = $1", [executionId], agentExecutionSchema);
  }

  async listExecutions(runId: string): Promise<AgentExecution[]> {
    return this.many("SELECT * FROM agent_executions WHERE run_id = $1 ORDER BY created_seq", [runId], agentExecutionSchema);
  }

  async createExecution(execution: AgentExecution): Promise<AgentExecution> {
    return this.write(execution.runId, async (db) => {
      const created = agentExecutionSchema.parse(fromRow(await insertRow(db, "agent_executions", execution)));
      return { result: created, event: { runId: execution.runId, type: "execution.updated", payload: { execution: created } } };
    });
  }

  async updateExecution(executionId: string, changes: Partial<AgentExecution>): Promise<AgentExecution> {
    return this.write(await this.runOf("agent_executions", executionId), async (db) => {
      const row = await updateRow(db, "agent_executions", executionId, this.touch(changes));
      const execution = agentExecutionSchema.parse(fromRow(row));
      return { result: execution, event: { runId: execution.runId, type: "execution.updated", payload: { execution } } };
    });
  }

  async addFinding(finding: SecurityFinding): Promise<SecurityFinding> {
    return this.write(finding.runId, async (db) => {
      const created = securityFindingSchema.parse(fromRow(await insertRow(db, "security_findings", finding)));
      return { result: created, event: { runId: finding.runId, type: "finding.created", payload: { finding: created } } };
    });
  }

  async getApproval(approvalId: string): Promise<Approval | null> {
    return this.one("SELECT * FROM approvals WHERE id = $1", [approvalId], approvalSchema);
  }

  async listApprovals(runId: string): Promise<Approval[]> {
    return this.many("SELECT * FROM approvals WHERE run_id = $1 ORDER BY created_seq", [runId], approvalSchema);
  }

  async listExpiredApprovals(asOf: string): Promise<Approval[]> {
    return this.many(
      "SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= $1 ORDER BY expires_at, created_seq",
      [asOf],
      approvalSchema,
    );
  }

  async requestApproval(approval: Approval): Promise<Approval> {
    return this.write(approval.runId, async (db) => {
      const created = approvalSchema.parse(fromRow(await insertRow(db, "approvals", approval)));
      return { result: created, event: { runId: approval.runId, type: "approval.requested", payload: { approval: created } } };
    });
  }

  /**
   * Settles a pending approval. The `status = 'pending'` guard means a human
   * decision and the timeout sweep can never both win, even across processes.
   */
  async resolveApproval(
    approvalId: string,
    status: Exclude<ApprovalStatus, "pending">,
    resolvedByUserId: string | null,
  ): Promise<Approval> {
    return this.write(await this.runOf("approvals", approvalId), async (db) => {
      const { rows } = await db.query(
        `UPDATE approvals SET status = $2, resolved_at = $3, resolved_by_user_id = $4
          WHERE id = $1 AND status = 'pending' RETURNING *`,
        [approvalId, status, this.now(), resolvedByUserId],
      );
      if (rows[0] === undefined) throw new HttpError(409, "Approval is already resolved");
      const approval = approvalSchema.parse(fromRow(rows[0]));
      return { result: approval, event: { runId: approval.runId, type: "approval.resolved", payload: { approval } } };
    });
  }

  /** What GET /api/runs/:runId/snapshot returns, read from one consistent view. */
  async snapshot(runId: string): Promise<RunSnapshot | null> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const { rows } = await db.query("SELECT * FROM runs WHERE id = $1", [runId]);
      const snapshot =
        rows[0] === undefined
          ? null
          : {
              run: runSchema.parse(fromRow(rows[0])),
              tasks: await this.many("SELECT * FROM tasks WHERE run_id = $1 ORDER BY created_seq", [runId], taskSchema, db),
              dependencies: await this.many("SELECT * FROM task_dependencies WHERE run_id = $1", [runId], taskDependencySchema, db),
              executions: await this.many("SELECT * FROM agent_executions WHERE run_id = $1 ORDER BY created_seq", [runId], agentExecutionSchema, db),
              findings: await this.many("SELECT * FROM security_findings WHERE run_id = $1 ORDER BY created_seq", [runId], securityFindingSchema, db),
              approvals: await this.many("SELECT * FROM approvals WHERE run_id = $1 ORDER BY created_seq", [runId], approvalSchema, db),
              lastEventSeq: Number(rows[0].last_event_seq),
            };
      await db.query("COMMIT");
      return snapshot;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }

  /**
   * Runs `work` and bumps the run's event seq in one transaction. The run row
   * is locked first, so one run's writes commit, number their events and get
   * their created_seq in a single order. Events go out through the outbox
   * after COMMIT.
   */
  private async write<T>(runId: string, work: (db: pg.PoolClient) => Promise<{ result: T; event: Uncommitted }>): Promise<T> {
    const db = await this.pool.connect();
    let entry: OutboxEntry | undefined;
    try {
      await db.query("BEGIN");
      let seq = await this.nextSeq(db, runId);
      const { result, event } = await work(db);
      // createRun: the row exists only now.
      seq ??= await this.nextSeq(db, runId);
      if (seq === undefined) throw new Error(`Unknown run ${runId}`);
      entry = { event: { ...event, seq } as RunEventDraft, committed: false };
      this.outbox(runId).push(entry);
      await db.query("COMMIT");
      entry.committed = true;
      return result;
    } catch (error) {
      if (entry !== undefined && !entry.committed) this.outbox(runId).splice(this.outbox(runId).indexOf(entry), 1);
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      db.release();
      if (entry !== undefined) this.flush(runId);
    }
  }

  private async nextSeq(db: pg.PoolClient, runId: string): Promise<number | undefined> {
    const { rows } = await db.query<{ seq: string }>(
      "UPDATE runs SET last_event_seq = last_event_seq + 1 WHERE id = $1 RETURNING last_event_seq AS seq",
      [runId],
    );
    return rows[0] === undefined ? undefined : Number(rows[0].seq);
  }

  /**
   * One run's events in seq order, from the moment the seq is assigned until
   * published. A later transaction can only take the run lock after an earlier
   * one commits, so entries arrive here in seq order; but COMMIT replies on
   * different connections can reach Node in either order, so an event waits
   * until every earlier one has committed or rolled back.
   */
  private outbox(runId: string): OutboxEntry[] {
    let queue = this.outboxes.get(runId);
    if (queue === undefined) this.outboxes.set(runId, (queue = []));
    return queue;
  }

  private flush(runId: string): void {
    const queue = this.outbox(runId);
    while (queue[0]?.committed) {
      const { event } = queue.shift()!;
      try {
        this.hub.publish(event);
      } catch (error) {
        // The write is committed either way; the hub makes subscribers resync on a gap.
        console.error(`Run ${runId}: event ${event.seq} was committed but not published`, error);
      }
    }
    if (queue.length === 0) this.outboxes.delete(runId);
  }

  private touch<T extends object>(changes: T): T & { updatedAt: string } {
    return { ...changes, updatedAt: this.now() };
  }

  private async runOf(table: "tasks" | "agent_executions" | "approvals", id: string): Promise<string> {
    const { rows } = await this.pool.query<{ run_id: string }>(`SELECT run_id FROM ${table} WHERE id = $1`, [id]);
    if (rows[0] === undefined) throw new Error(`Unknown ${table} row ${id}`);
    return rows[0].run_id;
  }

  private async one<T>(sql: string, params: unknown[], schema: { parse(value: unknown): T }): Promise<T | null> {
    const { rows } = await this.pool.query(sql, params);
    return rows[0] === undefined ? null : schema.parse(fromRow(rows[0]));
  }

  private async many<T>(
    sql: string,
    params: unknown[],
    schema: { parse(value: unknown): T },
    db: pg.Pool | pg.PoolClient = this.pool,
  ): Promise<T[]> {
    const { rows } = await db.query(sql, params);
    return rows.map((row) => schema.parse(fromRow(row)));
  }
}

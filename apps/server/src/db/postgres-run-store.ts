import {
  agentExecutionSchema,
  approvalSchema,
  auditEventSchema,
  RUN_LIST_DEFAULT_LIMIT,
  runSchema,
  runSummarySchema,
  securityFindingSchema,
  taskDependencySchema,
  taskSchema,
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
import type pg from "pg";
import { HttpError } from "../errors.js";
import type { AuditFor, RunAudit, RunReads, RunStore } from "../orchestrator/ports.js";
import type { RunEventHub } from "../run-events.js";
import { decodeRunCursor, encodeRunCursor, RUN_SUMMARY_PROMPT_READ_LENGTH, summaryPrompt } from "../run-list.js";
import { fromRow, insertRow, updateRow } from "./rows.js";

const DEPENDENCIES =
  "SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.run_id = $1 ORDER BY t.created_seq, d.depends_on_task_id";

type Uncommitted = RunEventDraft extends infer D ? (D extends RunEventDraft ? Omit<D, "seq"> : never) : never;
type OutboxEntry = { event: RunEventDraft; committed: boolean };

/**
 * RunStore on PostgreSQL. Each write and its RunEvent seq commit in one
 * transaction, and the event is published after COMMIT (contract decision 9),
 * in seq order, so seqs keep increasing across server restarts. A write that
 * committed resolves even if publishing its event fails.
 */
export class PostgresRunStore implements RunStore, RunReads {
  private readonly outboxes = new Map<string, OutboxEntry[]>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly hub: RunEventHub,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async createRun(run: Run, audit?: AuditFor<Run>): Promise<Run> {
    const db = await this.pool.connect();
    let entry: OutboxEntry | undefined;
    try {
      await db.query("BEGIN");
      // Serialize Run creation for this workspace across server processes.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [run.workspaceId]);
      const active = await db.query(
        "SELECT 1 FROM runs WHERE workspace_id = $1 AND status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1",
        [run.workspaceId],
      );
      if (active.rowCount) throw new HttpError(409, "A run is already active in this workspace. Wait for it to finish before submitting another prompt.");
      const parent = await db.query<{ id: string }>(
        "SELECT id FROM runs WHERE workspace_id = $1 AND status = 'completed' ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1",
        [run.workspaceId],
      );
      const created = runSchema.parse(fromRow(await insertRow(db, "runs", {
        ...run,
        parentRunId: parent.rows[0]?.id ?? null,
      })));
      const auditEvent = audit?.(created) ?? null;
      if (auditEvent !== null) await insertRow(db, "audit_events", auditEventSchema.parse(auditEvent));
      const seq = await this.nextSeq(db, run.id);
      if (seq === undefined) throw new Error(`Run ${run.id} disappeared during creation`);
      entry = { event: { runId: run.id, type: "run.updated", payload: { run: created }, seq }, committed: false };
      this.outbox(run.id).push(entry);
      await db.query("COMMIT");
      entry.committed = true;
      return created;
    } catch (error) {
      if (entry !== undefined && !entry.committed) this.outbox(run.id).splice(this.outbox(run.id).indexOf(entry), 1);
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      db.release();
      if (entry !== undefined) this.flush(run.id);
    }
  }

  async getRun(runId: string): Promise<Run | null> {
    return this.one("SELECT * FROM runs WHERE id = $1", [runId], runSchema);
  }

  async getLastEventSeq(runId: string): Promise<number> {
    const { rows } = await this.pool.query<{ last_event_seq: string }>("SELECT last_event_seq FROM runs WHERE id = $1", [runId]);
    return rows[0] === undefined ? 0 : Number(rows[0].last_event_seq);
  }

  async listActiveRuns(): Promise<Run[]> {
    return this.many(
      "SELECT * FROM runs WHERE status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at, id",
      [],
      runSchema,
    );
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await insertRow(this.pool, "audit_events", auditEventSchema.parse(event));
  }

  async updateRun(runId: string, changes: Partial<Run>, audit?: AuditFor<Run>): Promise<Run> {
    return this.write(runId, audit, async (db) => {
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
    return this.many(DEPENDENCIES, [runId], taskDependencySchema);
  }

  async createTask(task: Task, dependsOnTaskIds: string[], audit?: AuditFor<Task>): Promise<Task> {
    return this.write(task.runId, audit, async (db) => {
      const created = taskSchema.parse(fromRow(await insertRow(db, "tasks", task)));
      for (const dependsOnTaskId of dependsOnTaskIds) {
        await insertRow(db, "task_dependencies", { runId: task.runId, taskId: task.id, dependsOnTaskId });
      }
      return { result: created, event: { runId: task.runId, type: "task.created", payload: { task: created, dependsOnTaskIds } } };
    });
  }

  async updateTask(taskId: string, changes: Partial<Task>, audit?: AuditFor<Task>): Promise<Task> {
    return this.write(await this.runOf("tasks", taskId), audit, async (db) => {
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
    return this.write(execution.runId, undefined, async (db) => {
      const created = agentExecutionSchema.parse(fromRow(await insertRow(db, "agent_executions", execution)));
      return { result: created, event: { runId: execution.runId, type: "execution.updated", payload: { execution: created } } };
    });
  }

  async updateExecution(
    executionId: string,
    changes: Partial<AgentExecution>,
    audit?: AuditFor<AgentExecution>,
  ): Promise<AgentExecution> {
    return this.write(await this.runOf("agent_executions", executionId), audit, async (db) => {
      const row = await updateRow(db, "agent_executions", executionId, this.touch(changes));
      const execution = agentExecutionSchema.parse(fromRow(row));
      return { result: execution, event: { runId: execution.runId, type: "execution.updated", payload: { execution } } };
    });
  }

  async addFinding(finding: SecurityFinding): Promise<SecurityFinding> {
    return this.write(finding.runId, undefined, async (db) => {
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

  async requestApproval(approval: Approval, audit?: AuditFor<Approval>): Promise<Approval> {
    return this.write(approval.runId, audit, async (db) => {
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
    audit?: AuditFor<Approval>,
  ): Promise<Approval> {
    return this.write(await this.runOf("approvals", approvalId), audit, async (db) => {
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

  /** audit_events has no creation sequence, so events in the same millisecond can read in either order. */
  async runAudit(runId: string, eventType: AuditEventType, limit: number): Promise<RunAudit> {
    const { rows } = await this.pool.query(
      `SELECT *, count(*) OVER ()::int AS total FROM audit_events
        WHERE run_id = $1 AND event_type = $2
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [runId, eventType, limit],
    );
    return {
      events: rows.map((row) => auditEventSchema.parse(fromRow(row))).reverse(),
      total: (rows[0] as { total?: number } | undefined)?.total ?? 0,
    };
  }

  /** One statement per page: the counts are subqueries over indexed run_id columns, not a query per row. */
  async listRuns(workspaceId: string, query: RunListQuery): Promise<RunListResponse> {
    const after = query.cursor === undefined ? null : decodeRunCursor(query.cursor);
    const limit = query.limit ?? RUN_LIST_DEFAULT_LIMIT;
    const [{ rows }, pending] = await Promise.all([
      this.pool.query(
        `SELECT r.id, r.workspace_id, r.created_by_user_id, r.orchestration_mode, r.status, r.cancel_requested_at,
                r.created_at, r.updated_at, r.started_at, r.completed_at,
                left(r.user_prompt, $6) AS user_prompt,
                (SELECT count(*)::int FROM tasks t WHERE t.run_id = r.id) AS task_count,
                (SELECT count(*)::int FROM approvals a WHERE a.run_id = r.id AND a.status = 'pending') AS pending_approval_count,
                (SELECT count(*)::int FROM security_findings f WHERE f.run_id = r.id) AS finding_count
           FROM runs r
          WHERE r.workspace_id = $1
            AND ($2::run_status IS NULL OR r.status = $2::run_status)
            AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $5`,
        [workspaceId, query.status ?? null, after?.createdAt ?? null, after?.id ?? null, limit + 1, RUN_SUMMARY_PROMPT_READ_LENGTH],
      ),
      this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM approvals a JOIN runs r ON r.id = a.run_id
          WHERE r.workspace_id = $1 AND a.status = 'pending'`,
        [workspaceId],
      ),
    ]);
    const runs = rows.slice(0, limit).map((row) =>
      runSummarySchema.parse({ ...fromRow(row), userPrompt: summaryPrompt(String(row.user_prompt)) }),
    );
    const last = runs.at(-1);
    return {
      runs,
      nextCursor: rows.length > limit && last !== undefined ? encodeRunCursor(last) : null,
      pendingApprovalCount: pending.rows[0]?.count ?? 0,
    };
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
              dependencies: await this.many(DEPENDENCIES, [runId], taskDependencySchema, db),
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
   * Runs `work`, records its audit event and bumps the run's event seq in one
   * transaction. The run row is locked first, so one run's writes commit,
   * number their events and get their created_seq in a single order. Events go
   * out through the outbox after COMMIT.
   */
  private async write<T>(
    runId: string,
    audit: AuditFor<T> | undefined,
    work: (db: pg.PoolClient) => Promise<{ result: T; event: Uncommitted }>,
  ): Promise<T> {
    const db = await this.pool.connect();
    let entry: OutboxEntry | undefined;
    try {
      await db.query("BEGIN");
      let seq = await this.nextSeq(db, runId);
      const { result, event } = await work(db);
      const auditEvent = audit?.(result) ?? null;
      if (auditEvent !== null) await insertRow(db, "audit_events", auditEventSchema.parse(auditEvent));
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

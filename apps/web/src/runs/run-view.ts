import type {
  AgentExecution,
  Approval,
  Run,
  RunEvent,
  RunSnapshot,
  RunStatus,
  SecurityFinding,
  Task,
  TaskDependency,
} from "@launchpad/shared";

// A Run as the Run Detail page shows it, kept up to date from RunEvents.
//
// The contract (packages/shared/src/events.ts): load the RunSnapshot, then
// apply only events with seq > lastEventSeq. Every event carries the whole
// entity, so applying one is an upsert by id. A missed intermediate event
// cannot leave the page in an impossible state.

export interface RunView {
  run: Run;
  /** In creation order. */
  tasks: Task[];
  dependencies: TaskDependency[];
  executions: AgentExecution[];
  findings: SecurityFinding[];
  approvals: Approval[];
  lastEventSeq: number;
}

export function viewFromSnapshot(snapshot: RunSnapshot): RunView {
  return {
    run: snapshot.run,
    tasks: snapshot.tasks,
    dependencies: snapshot.dependencies,
    executions: snapshot.executions,
    findings: snapshot.findings,
    approvals: snapshot.approvals,
    lastEventSeq: snapshot.lastEventSeq,
  };
}

/** Returns a new view; the old one is left untouched, as React state requires. */
export function applyRunEvent(view: RunView, event: RunEvent): RunView {
  if (event.runId !== view.run.id || event.seq <= view.lastEventSeq) return view;
  const next = { ...view, lastEventSeq: event.seq };
  switch (event.type) {
    case "run.updated":
      return { ...next, run: event.payload.run };
    case "task.created": {
      const { task, dependsOnTaskIds } = event.payload;
      const known = new Set(view.dependencies.map((edge) => `${edge.taskId}>${edge.dependsOnTaskId}`));
      const edges = dependsOnTaskIds
        .filter((dependsOnTaskId) => !known.has(`${task.id}>${dependsOnTaskId}`))
        .map((dependsOnTaskId) => ({ runId: event.runId, taskId: task.id, dependsOnTaskId }));
      return { ...next, tasks: upsert(view.tasks, task), dependencies: [...view.dependencies, ...edges] };
    }
    case "task.updated":
      return { ...next, tasks: upsert(view.tasks, event.payload.task) };
    case "execution.updated":
      return { ...next, executions: upsert(view.executions, event.payload.execution) };
    case "finding.created":
      return { ...next, findings: upsert(view.findings, event.payload.finding) };
    case "approval.requested":
    case "approval.resolved":
      return { ...next, approvals: upsert(view.approvals, event.payload.approval) };
  }
}

/** Replace by id, keeping the original position; append what is new. */
function upsert<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const index = list.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...list, item];
  const copy = [...list];
  copy[index] = item;
  return copy;
}

const ACTIVE: ReadonlySet<RunStatus> = new Set(["queued", "planning", "running", "waiting_approval"]);
/** A delegated task's title and objective came from the planning agent, not a person. */
export function isWrittenByPlan(task: Pick<Task, "parentTaskId">): boolean {
  return task.parentTaskId !== null;
}

export const isRunActive = (status: RunStatus): boolean => ACTIVE.has(status);

export const executionsOf = (view: RunView, taskId: string): AgentExecution[] =>
  view.executions.filter((execution) => execution.taskId === taskId).sort((a, b) => a.attempt - b.attempt);

export const findingsOf = (view: RunView, taskId: string): SecurityFinding[] =>
  view.findings.filter((finding) => finding.taskId === taskId);

export const approvalsOf = (view: RunView, taskId: string): Approval[] =>
  view.approvals.filter((approval) => approval.taskId === taskId);

export const pendingApprovals = (view: RunView): Approval[] =>
  view.approvals.filter((approval) => approval.status === "pending");

/**
 * The task the drill-down opens on when the user has not picked one: whatever
 * needs a person, then whatever is running, then the last task created.
 */
export function focusTaskId(view: RunView): string | null {
  const waiting = pendingApprovals(view)[0]?.taskId;
  if (waiting) return waiting;
  const running = view.tasks.find((task) => task.status === "running");
  if (running) return running.id;
  return view.tasks.at(-1)?.id ?? null;
}

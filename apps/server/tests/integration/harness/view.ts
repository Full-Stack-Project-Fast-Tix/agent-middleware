import type {
  AgentExecution,
  Approval,
  Run,
  RunEvent,
  RunSnapshot,
  SecurityFinding,
  Task,
  TaskDependency,
} from "@launchpad/shared";

/** A Run's state as rebuilt from its events: what the Run Detail page would show. */
export interface RunView {
  run: Run | null;
  tasks: Map<string, Task>;
  dependencies: TaskDependency[];
  executions: Map<string, AgentExecution>;
  findings: Map<string, SecurityFinding>;
  approvals: Map<string, Approval>;
  lastEventSeq: number;
}

export function emptyView(): RunView {
  return {
    run: null,
    tasks: new Map(),
    dependencies: [],
    executions: new Map(),
    findings: new Map(),
    approvals: new Map(),
    lastEventSeq: 0,
  };
}

/** Apply one event the way a client should: upsert the carried entity by id. */
export function applyEvent(view: RunView, event: RunEvent): void {
  view.lastEventSeq = event.seq;
  switch (event.type) {
    case "run.updated":
      view.run = event.payload.run;
      return;
    case "task.created":
      view.tasks.set(event.payload.task.id, event.payload.task);
      for (const dependsOnTaskId of event.payload.dependsOnTaskIds) {
        view.dependencies.push({ taskId: event.payload.task.id, dependsOnTaskId });
      }
      return;
    case "task.updated":
      view.tasks.set(event.payload.task.id, event.payload.task);
      return;
    case "execution.updated":
      view.executions.set(event.payload.execution.id, event.payload.execution);
      return;
    case "finding.created":
      view.findings.set(event.payload.finding.id, event.payload.finding);
      return;
    case "approval.requested":
    case "approval.resolved":
      view.approvals.set(event.payload.approval.id, event.payload.approval);
      return;
  }
}

export function viewFromEvents(events: RunEvent[]): RunView {
  const view = emptyView();
  for (const event of events) applyEvent(view, event);
  return view;
}

/** The snapshot a correct server would return for this view. */
export function snapshotOf(view: RunView): RunSnapshot {
  if (!view.run) throw new Error("No run.updated event has been applied");
  return {
    run: view.run,
    tasks: [...view.tasks.values()],
    dependencies: [...view.dependencies],
    executions: [...view.executions.values()],
    findings: [...view.findings.values()],
    approvals: [...view.approvals.values()],
    lastEventSeq: view.lastEventSeq,
  };
}

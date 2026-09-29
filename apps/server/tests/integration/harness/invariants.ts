import { isDeepStrictEqual } from "node:util";
import {
  canTransitionApproval,
  canTransitionExecution,
  canTransitionRun,
  canTransitionTask,
  isTerminalApprovalStatus,
  isTerminalExecutionStatus,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  type RunEvent,
  type RunSnapshot,
  type Task,
} from "@launchpad/shared";
import { applyEvent, emptyView, type RunView } from "./view.js";

export interface Violation {
  /** Stable rule id, e.g. "task.transition". */
  rule: string;
  /** The event that broke it; null for end-of-run and snapshot checks. */
  seq: number | null;
  message: string;
}

// Fields that identify an entity or record where it came from. They are set
// once at creation; an update that changes them is a bug in whoever wrote it.
const IMMUTABLE = {
  run: ["workspaceId", "createdByUserId", "userPrompt", "orchestrationMode", "createdAt"],
  task: ["runId", "parentTaskId", "createdByExecutionId", "objective", "createdAt"],
  execution: ["runId", "taskId", "agentId", "attempt", "createdAt"],
  approval: ["runId", "taskId", "executionId", "agentId", "actionType", "reason", "requestedAt"],
} as const;

/**
 * Check the properties every Run must have, whatever the orchestrator,
 * persistence and security layers did along the way. `events` must be the
 * complete stream from seq 1. Pass the snapshot fetched after the stream went
 * quiet to also check that events and persisted state agree.
 *
 * Returns every violation rather than stopping at the first, so one failing
 * test shows the whole picture.
 */
export function checkRunInvariants(runId: string, events: RunEvent[], snapshot?: RunSnapshot): Violation[] {
  const violations: Violation[] = [];
  const report = (rule: string, seq: number | null, message: string) => violations.push({ rule, seq, message });
  const view = emptyView();
  const dependsOn = new Map<string, string[]>();

  const unchanged = (kind: keyof typeof IMMUTABLE, id: string, seq: number, before: object, after: object) => {
    for (const field of IMMUTABLE[kind]) {
      const previous = (before as Record<string, unknown>)[field];
      const next = (after as Record<string, unknown>)[field];
      if (!isDeepStrictEqual(previous, next)) {
        report(`${kind}.immutable`, seq, `${kind} ${id} changed ${field}`);
      }
    }
  };
  const transition = <S extends string>(
    kind: string,
    allowed: (from: S, to: S) => boolean,
    id: string,
    seq: number,
    from: S,
    to: S,
  ) => {
    if (from !== to && !allowed(from, to)) report(`${kind}.transition`, seq, `${kind} ${id}: ${from} -> ${to}`);
  };
  const known = (rule: string, seq: number, map: Map<string, unknown>, id: string | null, what: string) => {
    if (id !== null && !map.has(id)) report(rule, seq, `${what} ${id} was never announced`);
  };
  const dependenciesMet = (task: Task, previous: Task | undefined, seq: number) => {
    const started = task.status === "ready" || task.status === "running";
    if (!started || previous?.status === task.status) return;
    for (const dependencyId of dependsOn.get(task.id) ?? []) {
      const status = view.tasks.get(dependencyId)?.status;
      if (status !== "completed") {
        report("task.dependency-order", seq, `task ${task.id} became ${task.status} while ${dependencyId} was ${status}`);
      }
    }
  };

  let expectedSeq = 1;
  for (const event of events) {
    const { seq } = event;
    if (seq !== expectedSeq) report("stream.seq", seq, `expected seq ${expectedSeq}, got ${seq}`);
    expectedSeq = seq + 1;
    if (event.runId !== runId) report("stream.run", seq, `event for run ${event.runId}`);

    switch (event.type) {
      case "run.updated": {
        const next = event.payload.run;
        if (next.id !== runId) report("run.id", seq, `run.updated carries run ${next.id}`);
        if (view.run) {
          transition("run", canTransitionRun, next.id, seq, view.run.status, next.status);
          unchanged("run", next.id, seq, view.run, next);
        }
        break;
      }
      case "task.created": {
        const { task, dependsOnTaskIds } = event.payload;
        if (view.tasks.has(task.id)) report("task.duplicate", seq, `task ${task.id} created twice`);
        if (task.runId !== runId) report("task.run", seq, `task ${task.id} belongs to run ${task.runId}`);
        for (const dependencyId of dependsOnTaskIds) {
          known("task.dependency-unknown", seq, view.tasks, dependencyId, "dependency task");
        }
        dependsOn.set(task.id, dependsOnTaskIds);
        dependenciesMet(task, undefined, seq);
        break;
      }
      case "task.updated": {
        const next = event.payload.task;
        const previous = view.tasks.get(next.id);
        if (!previous) {
          report("task.unknown", seq, `task ${next.id} updated before task.created`);
        } else {
          transition("task", canTransitionTask, next.id, seq, previous.status, next.status);
          unchanged("task", next.id, seq, previous, next);
        }
        dependenciesMet(next, previous, seq);
        break;
      }
      case "execution.updated": {
        const next = event.payload.execution;
        known("execution.task-unknown", seq, view.tasks, next.taskId, "task");
        if (next.runId !== runId) report("execution.run", seq, `execution ${next.id} belongs to run ${next.runId}`);
        const previous = view.executions.get(next.id);
        if (previous) {
          transition("execution", canTransitionExecution, next.id, seq, previous.status, next.status);
          unchanged("execution", next.id, seq, previous, next);
        }
        break;
      }
      case "finding.created": {
        const { finding } = event.payload;
        if (view.findings.has(finding.id)) report("finding.duplicate", seq, `finding ${finding.id} created twice`);
        if (finding.runId !== runId) report("finding.run", seq, `finding ${finding.id} belongs to run ${finding.runId}`);
        known("finding.reference", seq, view.tasks, finding.taskId, "task");
        known("finding.reference", seq, view.executions, finding.executionId, "execution");
        break;
      }
      case "approval.requested": {
        const { approval } = event.payload;
        if (view.approvals.has(approval.id)) report("approval.duplicate", seq, `approval ${approval.id} requested twice`);
        if (approval.status !== "pending") report("approval.requested-status", seq, `requested as ${approval.status}`);
        known("approval.reference", seq, view.tasks, approval.taskId, "task");
        known("approval.reference", seq, view.executions, approval.executionId, "execution");
        break;
      }
      case "approval.resolved": {
        const next = event.payload.approval;
        const previous = view.approvals.get(next.id);
        if (!previous) {
          report("approval.unknown", seq, `approval ${next.id} resolved before it was requested`);
        } else {
          transition("approval", canTransitionApproval, next.id, seq, previous.status, next.status);
          unchanged("approval", next.id, seq, previous, next);
        }
        if (!isTerminalApprovalStatus(next.status) || next.resolvedAt === null) {
          report("approval.resolved-state", seq, `approval ${next.id} resolved as ${next.status} without resolvedAt`);
        }
        break;
      }
    }
    applyEvent(view, event);
  }

  checkEndState(view, report);
  if (snapshot) checkSnapshot(view, snapshot, report);
  return violations;
}

function checkEndState(view: RunView, report: (rule: string, seq: number | null, message: string) => void): void {
  const { run } = view;
  if (!run) {
    report("run.missing", null, "no run.updated event");
    return;
  }

  const lifecycle = [
    { kind: "run", id: run.id, status: run.status, terminal: isTerminalRunStatus(run.status), entity: run },
    ...[...view.tasks.values()].map((task) => ({
      kind: "task", id: task.id, status: task.status, terminal: isTerminalTaskStatus(task.status), entity: task,
    })),
    ...[...view.executions.values()].map((execution) => ({
      kind: "execution", id: execution.id, status: execution.status,
      terminal: isTerminalExecutionStatus(execution.status), entity: execution,
    })),
  ];
  for (const { kind, id, status, terminal, entity } of lifecycle) {
    // Skipped and cancelled work may never have started, so only finished work needs completedAt.
    if ((status === "completed" || status === "failed") && entity.completedAt === null) {
      report("lifecycle.completed-at", null, `${kind} ${id} is ${status} without completedAt`);
    }
    if (status === "failed" && entity.error === null) {
      report("lifecycle.error", null, `${kind} ${id} failed without an error`);
    }
    if (isTerminalRunStatus(run.status) && kind !== "run" && !terminal) {
      report("run.finished-with-open-work", null, `run is ${run.status} but ${kind} ${id} is ${status}`);
    }
  }
  if (isTerminalRunStatus(run.status)) {
    for (const approval of view.approvals.values()) {
      if (!isTerminalApprovalStatus(approval.status)) {
        report("run.finished-with-open-work", null, `run is ${run.status} but approval ${approval.id} is pending`);
      }
    }
  }
}

function checkSnapshot(
  view: RunView,
  snapshot: RunSnapshot,
  report: (rule: string, seq: number | null, message: string) => void,
): void {
  if (snapshot.lastEventSeq !== view.lastEventSeq) {
    report("snapshot.seq", null, `snapshot lastEventSeq ${snapshot.lastEventSeq}, stream ended at ${view.lastEventSeq}`);
  }
  if (!isDeepStrictEqual(snapshot.run, view.run)) {
    report("snapshot.run", null, `run differs in ${differingFields(snapshot.run, view.run).join(", ")}`);
  }
  const collections = [
    ["tasks", view.tasks, snapshot.tasks],
    ["executions", view.executions, snapshot.executions],
    ["findings", view.findings, snapshot.findings],
    ["approvals", view.approvals, snapshot.approvals],
  ] as const;
  for (const [name, fromEvents, stored] of collections) {
    const storedById = new Map<string, object>(stored.map((entity) => [entity.id, entity]));
    for (const [id, entity] of fromEvents) {
      const match = storedById.get(id);
      if (!match) report(`snapshot.${name}`, null, `${id} is in the event stream but not the snapshot`);
      else if (!isDeepStrictEqual(match, entity)) {
        report(`snapshot.${name}`, null, `${id} differs in ${differingFields(match, entity).join(", ")}`);
      }
    }
    for (const id of storedById.keys()) {
      if (!fromEvents.has(id)) report(`snapshot.${name}`, null, `${id} is in the snapshot but never announced`);
    }
  }
  const edges = (list: readonly { taskId: string; dependsOnTaskId: string }[]) =>
    new Set(list.map((edge) => `${edge.taskId}->${edge.dependsOnTaskId}`));
  if (!isDeepStrictEqual(edges(snapshot.dependencies), edges(view.dependencies))) {
    report("snapshot.dependencies", null, "task dependencies differ between snapshot and events");
  }
}

function differingFields(left: unknown, right: unknown): string[] {
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return ["(whole)"];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter(
    (key) => !isDeepStrictEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

import type { Task, TaskDependency, TaskStatus } from "@launchpad/shared";

// Scheduling decisions for one Run, as pure functions over the current task
// statuses. The orchestrator applies what they return; keeping the rules here
// means they can be tested without a runtime, a model or a database.
//
// Rules (plan sections 3.2 and 3.3, lifecycle.ts):
//   - A task becomes ready only when every task it depends on has completed.
//   - When a task fails, every task downstream of it is skipped.
//   - At most `maxParallel` executions run at once.
//   - Write-capable executions never overlap. Read-only ones may run beside
//     each other and beside one writer.

type TaskState = Pick<Task, "id" | "status">;

const BLOCKING: ReadonlySet<TaskStatus> = new Set(["failed", "skipped", "cancelled"]);
const NOT_STARTED: ReadonlySet<TaskStatus> = new Set(["pending", "ready"]);

function dependenciesByTask(dependencies: readonly TaskDependency[]): Map<string, string[]> {
  const byTask = new Map<string, string[]>();
  for (const edge of dependencies) {
    const list = byTask.get(edge.taskId) ?? [];
    list.push(edge.dependsOnTaskId);
    byTask.set(edge.taskId, list);
  }
  return byTask;
}

/** Pending tasks whose dependencies have all completed. */
export function tasksToMarkReady(tasks: readonly TaskState[], dependencies: readonly TaskDependency[]): string[] {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  const byTask = dependenciesByTask(dependencies);
  return tasks
    .filter((task) => task.status === "pending")
    .filter((task) => (byTask.get(task.id) ?? []).every((dependency) => status.get(dependency) === "completed"))
    .map((task) => task.id);
}

/**
 * Tasks that can never run because something upstream failed, was skipped or
 * was cancelled, including tasks further downstream of those. Only tasks that
 * have not started are returned.
 */
export function tasksToSkip(tasks: readonly TaskState[], dependencies: readonly TaskDependency[]): string[] {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  const byTask = dependenciesByTask(dependencies);
  const skipped: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      const current = status.get(task.id)!;
      if (!NOT_STARTED.has(current)) continue;
      const blocked = (byTask.get(task.id) ?? []).some((dependency) => {
        const upstream = status.get(dependency);
        return upstream !== undefined && BLOCKING.has(upstream);
      });
      if (blocked) {
        status.set(task.id, "skipped");
        skipped.push(task.id);
        changed = true;
      }
    }
  }
  return skipped;
}

export interface LaunchCandidate {
  taskId: string;
  /** From the effective policy the execution would launch with. */
  write: boolean;
}

/**
 * Which candidates to launch now, in candidate order. A writer that has to
 * wait does not hold back read-only candidates behind it.
 */
export function pickLaunches(input: {
  candidates: readonly LaunchCandidate[];
  active: ReadonlyArray<{ write: boolean }>;
  maxParallel: number;
}): string[] {
  let running = input.active.length;
  let writerActive = input.active.some((execution) => execution.write);
  const launches: string[] = [];
  for (const candidate of input.candidates) {
    if (running >= input.maxParallel) break;
    if (candidate.write && writerActive) continue;
    launches.push(candidate.taskId);
    running += 1;
    if (candidate.write) writerActive = true;
  }
  return launches;
}

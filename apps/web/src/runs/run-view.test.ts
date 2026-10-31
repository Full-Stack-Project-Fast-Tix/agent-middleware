import { describe, expect, it } from "vitest";
import type { Approval, Run, RunEvent, RunSnapshot, Task } from "@launchpad/shared";
import { applyRunEvent, focusTaskId, isRunActive, isWrittenByPlan, viewFromSnapshot } from "./run-view";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-10-09T10:00:00.000Z";

const run = (overrides: Partial<Run> = {}): Run => ({
  id: RUN_ID,
  workspaceId: "00000000-0000-4000-8000-0000000000aa",
  createdByUserId: "00000000-0000-4000-8000-0000000000bb",
  supervisorAgentId: null,
  userPrompt: "Add validation",
  orchestrationMode: "auto",
  status: "running",
  finalOutput: null,
  error: null,
  cancelRequestedAt: null,
  evaluation: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
  completedAt: null,
  ...overrides,
});

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  runId: RUN_ID,
  parentTaskId: null,
  createdByExecutionId: null,
  title: `Task ${id}`,
  objective: "Do it",
  assignedAgentId: null,
  status: "pending",
  result: null,
  error: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: null,
  completedAt: null,
  ...overrides,
});

const snapshot = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  run: run(),
  tasks: [],
  dependencies: [],
  executions: [],
  findings: [],
  approvals: [],
  lastEventSeq: 3,
  ...overrides,
});

const event = <E extends RunEvent>(seq: number, type: E["type"], payload: E["payload"]): RunEvent =>
  ({ id: `e${seq}`, runId: RUN_ID, seq, timestamp: NOW, type, payload }) as RunEvent;

describe("applyRunEvent", () => {
  it("upserts the carried entity by id, keeping creation order", () => {
    let view = viewFromSnapshot(snapshot({ tasks: [task("a"), task("b")] }));
    view = applyRunEvent(view, event(4, "task.updated", { task: task("a", { status: "running" }) }));
    view = applyRunEvent(view, event(5, "task.created", { task: task("c"), dependsOnTaskIds: ["a"] }));

    expect(view.tasks.map((item) => [item.id, item.status])).toEqual([
      ["a", "running"],
      ["b", "pending"],
      ["c", "pending"],
    ]);
    expect(view.dependencies).toEqual([{ runId: RUN_ID, taskId: "c", dependsOnTaskId: "a" }]);
    expect(view.lastEventSeq).toBe(5);
  });

  it("ignores events already reflected in the snapshot, and events of other runs", () => {
    const before = viewFromSnapshot(snapshot({ tasks: [task("a", { status: "completed" })] }));
    const stale = event(3, "task.updated", { task: task("a", { status: "running" }) });
    const elsewhere = { ...event(9, "run.updated", { run: run({ status: "failed" }) }), runId: "other" } as RunEvent;
    expect(applyRunEvent(before, stale)).toBe(before);
    expect(applyRunEvent(before, elsewhere)).toBe(before);
  });

  it("never mutates the previous view", () => {
    const before = viewFromSnapshot(snapshot());
    const frozen = JSON.stringify(before);
    const after = applyRunEvent(before, event(4, "run.updated", { run: run({ status: "completed" }) }));
    expect(after.run.status).toBe("completed");
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it("does not duplicate dependency edges when a task.created is seen twice", () => {
    let view = viewFromSnapshot(snapshot({ tasks: [task("a")] }));
    const created = (seq: number) => event(seq, "task.created", { task: task("b"), dependsOnTaskIds: ["a"] });
    view = applyRunEvent(applyRunEvent(view, created(4)), created(5));
    expect(view.dependencies).toHaveLength(1);
    expect(view.tasks).toHaveLength(2);
  });
});

describe("focusTaskId", () => {
  const approval = { id: "ap", taskId: "b", status: "pending" } as Approval;

  it("prefers a task waiting for a person, then a running task, then the newest", () => {
    const tasks = [task("a", { status: "running" }), task("b", { status: "waiting_approval" }), task("c")];
    expect(focusTaskId(viewFromSnapshot(snapshot({ tasks, approvals: [approval] })))).toBe("b");
    expect(focusTaskId(viewFromSnapshot(snapshot({ tasks })))).toBe("a");
    expect(focusTaskId(viewFromSnapshot(snapshot({ tasks: [task("a"), task("c")] })))).toBe("c");
    expect(focusTaskId(viewFromSnapshot(snapshot()))).toBeNull();
  });
});

describe("isWrittenByPlan", () => {
  it("treats a delegated task's title as the plan's words, and a root task's as not", () => {
    expect(isWrittenByPlan({ parentTaskId: "plan" })).toBe(true);
    expect(isWrittenByPlan({ parentTaskId: null })).toBe(false);
  });
});

describe("isRunActive", () => {
  it("treats only the terminal statuses as finished", () => {
    expect(["queued", "planning", "running", "waiting_approval"].every((status) => isRunActive(status as Run["status"]))).toBe(true);
    expect(["completed", "failed", "cancelled"].some((status) => isRunActive(status as Run["status"]))).toBe(false);
  });
});

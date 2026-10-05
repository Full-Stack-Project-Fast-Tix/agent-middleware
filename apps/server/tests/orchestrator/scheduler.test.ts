import { describe, expect, it } from "vitest";
import type { TaskDependency, TaskStatus } from "@launchpad/shared";
import { pickLaunches, tasksToMarkReady, tasksToSkip } from "../../src/orchestrator/scheduler.js";

const RUN = "run";
const edge = (taskId: string, dependsOnTaskId: string): TaskDependency => ({ runId: RUN, taskId, dependsOnTaskId });
const tasks = (statuses: Record<string, TaskStatus>) => Object.entries(statuses).map(([id, status]) => ({ id, status }));

describe("tasksToMarkReady", () => {
  it("readies pending tasks only once every dependency has completed", () => {
    const deps = [edge("c", "a"), edge("c", "b"), edge("d", "a")];
    expect(tasksToMarkReady(tasks({ a: "completed", b: "running", c: "pending", d: "pending", e: "pending" }), deps)).toEqual([
      "d",
      "e",
    ]);
  });
});

describe("tasksToSkip", () => {
  it("skips everything downstream of a failure, transitively, and leaves started work alone", () => {
    const deps = [edge("b", "a"), edge("c", "b"), edge("d", "a"), edge("e", "x")];
    expect(
      tasksToSkip(tasks({ a: "failed", b: "pending", c: "pending", d: "running", x: "completed", e: "pending" }), deps),
    ).toEqual(["b", "c"]);
  });

  it("treats skipped and cancelled upstream work like a failure", () => {
    const deps = [edge("b", "a"), edge("d", "c")];
    expect(tasksToSkip(tasks({ a: "skipped", b: "ready", c: "cancelled", d: "pending" }), deps)).toEqual(["b", "d"]);
  });
});

describe("pickLaunches", () => {
  const candidate = (taskId: string, write = false) => ({ taskId, write });

  it("respects maxParallel, counting what is already running", () => {
    expect(pickLaunches({ candidates: [candidate("a"), candidate("b"), candidate("c")], active: [{ write: false }], maxParallel: 3 })).toEqual([
      "a",
      "b",
    ]);
  });

  it("never runs two writers at once, and a waiting writer does not hold back readers", () => {
    expect(
      pickLaunches({ candidates: [candidate("w1", true), candidate("w2", true), candidate("r")], active: [], maxParallel: 5 }),
    ).toEqual(["w1", "r"]);
    expect(pickLaunches({ candidates: [candidate("w", true), candidate("r")], active: [{ write: true }], maxParallel: 5 })).toEqual([
      "r",
    ]);
  });
});

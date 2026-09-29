import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventDraft } from "@launchpad/shared";
import { RunEventHub } from "../../src/run-events.js";
import { AGENTS, makeApproval, makeExecution, makeRun, makeTask, timestamp } from "./harness/factories.js";
import { checkRunInvariants, type Violation } from "./harness/invariants.js";
import { snapshotOf, viewFromEvents } from "./harness/view.js";

// The invariants are only useful if they catch what they claim to. Each test
// breaks one rule in an otherwise valid run and expects exactly that rule.

const run = makeRun({ status: "queued" });
const first = makeTask(run.id, { title: "First", status: "ready" });
const second = makeTask(run.id, { title: "Second" });
const execution = makeExecution(second, AGENTS.developer);
const done = { completedAt: timestamp() };

type Step = RunEventDraft;
const runUpdated = (changes: Partial<typeof run>): Step => ({
  runId: run.id,
  type: "run.updated",
  payload: { run: { ...run, ...changes } },
});
const taskUpdated = (task: typeof first, changes: Partial<typeof first>): Step => ({
  runId: run.id,
  type: "task.updated",
  payload: { task: { ...task, ...changes } },
});
const executionUpdated = (changes: Partial<typeof execution>): Step => ({
  runId: run.id,
  type: "execution.updated",
  payload: { execution: { ...execution, ...changes } },
});

/** A valid two-task run: `second` depends on `first`. */
function validSteps(): Step[] {
  return [
    runUpdated({ status: "queued" }),
    runUpdated({ status: "running" }),
    { runId: run.id, type: "task.created", payload: { task: first, dependsOnTaskIds: [] } },
    { runId: run.id, type: "task.created", payload: { task: second, dependsOnTaskIds: [first.id] } },
    taskUpdated(first, { status: "running" }),
    taskUpdated(first, { status: "completed", ...done }),
    taskUpdated(second, { status: "ready" }),
    taskUpdated(second, { status: "running" }),
    executionUpdated({ status: "running" }),
    executionUpdated({ status: "completed", ...done }),
    taskUpdated(second, { status: "completed", ...done }),
    runUpdated({ status: "completed", finalOutput: "Done", ...done }),
  ];
}

/** Publish through the real hub so ids, seqs and timestamps are stamped as in production. */
function record(steps: Step[]): RunEvent[] {
  const hub = new RunEventHub();
  const events: RunEvent[] = [];
  hub.subscribe(run.id, 0, (event) => events.push(event));
  for (const step of steps) hub.publish(step);
  return events;
}

const rules = (violations: Violation[]) => [...new Set(violations.map((violation) => violation.rule))];

describe("run invariants", () => {
  it("accept a valid run and its matching snapshot", () => {
    const events = record(validSteps());
    expect(checkRunInvariants(run.id, events, snapshotOf(viewFromEvents(events)))).toEqual([]);
  });

  it("catch a gap in the stream", () => {
    // Publish a redundant update, then lose it in transit: state stays valid, the seq does not.
    const steps = validSteps();
    steps.splice(2, 0, runUpdated({ status: "running" }));
    const events = record(steps);
    events.splice(2, 1);
    expect(rules(checkRunInvariants(run.id, events))).toEqual(["stream.seq"]);
  });

  it("catch a status change the lifecycle does not allow", () => {
    const steps = validSteps();
    steps.push(runUpdated({ status: "running", ...done, finalOutput: "Done" }));
    expect(rules(checkRunInvariants(run.id, record(steps)))).toEqual(["run.transition"]);
  });

  it("catch a task starting before its dependency completed", () => {
    const steps = validSteps();
    // Move "second becomes ready" ahead of "first completes".
    const early = steps.splice(6, 1)[0]!;
    steps.splice(5, 0, early);
    expect(rules(checkRunInvariants(run.id, record(steps)))).toEqual(["task.dependency-order"]);
  });

  it("catch a change to a field that identifies the entity", () => {
    const steps = validSteps();
    steps[7] = taskUpdated(second, { status: "running", objective: "Something else entirely" });
    expect(rules(checkRunInvariants(run.id, record(steps)))).toEqual(["task.immutable"]);
  });

  it("catch an execution for a task that was never announced", () => {
    const orphan = makeExecution(makeTask(run.id), AGENTS.analyst, { status: "completed", ...done });
    const steps = validSteps();
    steps.splice(9, 0, { runId: run.id, type: "execution.updated", payload: { execution: orphan } });
    expect(rules(checkRunInvariants(run.id, record(steps)))).toEqual(["execution.task-unknown"]);
  });

  it("catch a finished run that still has a pending approval", () => {
    const steps = validSteps();
    const approval = makeApproval({ ...execution, status: "running" });
    steps.splice(9, 0, { runId: run.id, type: "approval.requested", payload: { approval } });
    expect(rules(checkRunInvariants(run.id, record(steps)))).toEqual(["run.finished-with-open-work"]);
  });

  it("catch failed work with no error to show", () => {
    const steps = validSteps().slice(0, 9);
    steps.push(executionUpdated({ status: "failed", ...done }));
    expect(rules(checkRunInvariants(run.id, record(steps)))).toEqual(["lifecycle.error"]);
  });

  it("catch a snapshot that disagrees with the event stream", () => {
    const events = record(validSteps());
    const snapshot = snapshotOf(viewFromEvents(events));
    snapshot.tasks[0] = { ...snapshot.tasks[0]!, status: "failed" };
    snapshot.lastEventSeq -= 1;
    expect(rules(checkRunInvariants(run.id, events, snapshot))).toEqual(["snapshot.seq", "snapshot.tasks"]);
  });
});

import { describe, expect, it } from "vitest";
import { createDemoRuns, DEMO_USER_ID, DEMO_WORKSPACE } from "../../src/dev/demo-runs.js";
import { RunEventHub } from "../../src/run-events.js";
import { checkRunInvariants } from "../integration/harness/invariants.js";
import type { RunEvent } from "@launchpad/shared";

// The RUNS_DEMO backend is what gets presented, so it is held to the same
// invariants as everything else, and its story must follow the decisions made
// on stage: a denied edit is never reported as made.

async function demoRun(decision: "approve" | "deny") {
  const hub = new RunEventHub();
  const demo = createDemoRuns(hub, { pauseScale: 0 });
  const run = await demo.orchestrator.createRun({
    workspaceId: DEMO_WORKSPACE.id,
    createdByUserId: DEMO_USER_ID,
    userPrompt: "Add input validation to the checkout endpoint",
    orchestrationMode: "auto",
  });
  const events: RunEvent[] = [];
  hub.subscribe(run.id, 0, { onEvent: (event) => events.push(event), onResync: () => undefined });

  for (let tries = 0; tries < 200; tries += 1) {
    const pending = (await demo.store.listApprovals(run.id)).find((approval) => approval.status === "pending");
    if (pending) {
      await demo.orchestrator.resolveApproval(pending.id, decision, DEMO_USER_ID);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await demo.orchestrator.whenSettled(run.id);
  const snapshot = demo.store.snapshot(run.id)!;
  expect(checkRunInvariants(run.id, events, snapshot)).toEqual([]);
  const result = (title: string) => snapshot.tasks.find((task) => task.title === title)?.result;
  return { snapshot, result };
}

describe("the RUNS_DEMO backend", () => {
  it("plans three tasks, refuses the exfiltration, and reports the approved edit", async () => {
    const { snapshot, result } = await demoRun("approve");
    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.tasks.map((task) => task.title)).toEqual(["Plan", "Find the relevant code", "Make the change", "Test and review"]);
    expect(snapshot.findings.map((finding) => finding.code)).toEqual([
      "instructions-in-workspace",
      "read-then-egress",
      "write-requires-approval",
    ]);
    expect(result("Make the change")).toMatch(/^Updated src\/checkout\.ts\. Skipped the release registration step/);
    expect(snapshot.run.finalOutput).toBe(result("Test and review"));
    expect(snapshot.run.finalOutput).toContain("ready for review");
  });

  it("never reports a denied edit as made, down to the final result", async () => {
    const { snapshot, result } = await demoRun("deny");
    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.approvals.map((approval) => approval.status)).toEqual(["denied"]);
    expect(result("Make the change")).toMatch(/^Did not change src\/checkout\.ts/);
    expect(snapshot.run.finalOutput).toContain("nothing changed");
    expect(snapshot.run.finalOutput).not.toContain("ready for review");
  });
});

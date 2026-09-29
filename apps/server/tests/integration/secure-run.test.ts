import { afterEach, describe, expect, it } from "vitest";
import { apiErrorSchema } from "@launchpad/shared";
import { ApiCallError, HarnessClient } from "./harness/client.js";
import { checkRunInvariants } from "./harness/invariants.js";
import { startStandIn, type StandIn } from "./harness/stand-in.js";

// Gate 1 of the work plan: one multi-agent Run goes through security
// evaluation, persists its state and emits events, observed only through the
// public API. Runs against stand-in subsystems until the real ones land (see
// harness/stand-in.ts); the assertions below are what the real ones must meet.

describe("secure multi-agent run", () => {
  let target: StandIn;

  afterEach(async () => {
    await target.close();
    expect(target.failures).toEqual([]);
  });

  async function startRun() {
    target = await startStandIn();
    const client = new HarnessClient(target);
    const run = await client.createRun({ userPrompt: "Add input validation to the signup endpoint", orchestrationMode: "auto" });
    return { client, run, recorder: client.record(run.id) };
  }

  it("plans, delegates, steers, pauses for approval and completes", async () => {
    const { client, run, recorder } = await startRun();
    expect(run.status).toBe("queued");

    await recorder.waitFor((view) => view.run?.status === "waiting_approval");
    const pending = await recorder.waitFor((view) =>
      [...view.approvals.values()].find((approval) => approval.status === "pending"),
    );
    expect(pending).toMatchObject({ actionType: "file_change", reason: "policy_required" });

    await client.resolveApproval(pending.id, "approve");
    await recorder.waitFor((view) => view.run?.status === "completed");
    const snapshot = await client.getSnapshot(run.id);
    await recorder.stop();

    expect(checkRunInvariants(run.id, recorder.events, snapshot)).toEqual([]);

    expect(snapshot.run.finalOutput).not.toBeNull();
    expect(snapshot.tasks.map((task) => [task.title, task.status])).toEqual([
      ["Plan", "completed"],
      ["Find missing validation", "completed"],
      ["Add validation", "completed"],
    ]);
    const [plan, analyse, implement] = snapshot.tasks;
    expect(snapshot.dependencies).toEqual([{ taskId: implement!.id, dependsOnTaskId: analyse!.id }]);
    expect(implement!.parentTaskId).toBe(plan!.id);

    // The steer and the policy gate each left an intervening finding on the implementing execution.
    expect(snapshot.findings.map((finding) => [finding.layer, finding.code, finding.intervened])).toEqual([
      ["deterministic", "read-then-egress", true],
      ["policy", "write-requires-approval", true],
    ]);
    expect(new Set(snapshot.findings.map((finding) => finding.taskId))).toEqual(new Set([implement!.id]));
    expect(snapshot.approvals).toEqual([
      expect.objectContaining({ id: pending.id, status: "approved", resolvedByUserId: expect.any(String) }),
    ]);

    // Delegations went through the middleware like any other action, and
    // delegated work carried its delegator's context.
    const evaluated = target.evaluator.requests;
    expect(evaluated.map((request) => request.action.type)).toEqual([
      "delegation",
      "delegation",
      "command",
      "command",
      "file_change",
    ]);
    for (const request of evaluated.slice(2)) {
      expect(request.context.originalUserGoal).toBe(run.userPrompt);
      expect(request.context.delegator?.agentId).toBe(snapshot.run.supervisorAgentId);
      expect(request.context.delegationDepth).toBe(1);
    }
  });

  it("fails the task and the run when the approval is denied", async () => {
    const { client, run, recorder } = await startRun();
    const pending = await recorder.waitFor((view) =>
      [...view.approvals.values()].find((approval) => approval.status === "pending"),
    );

    await client.resolveApproval(pending.id, "deny");
    await recorder.waitFor((view) => view.run?.status === "failed");
    const snapshot = await client.getSnapshot(run.id);
    await recorder.stop();

    expect(checkRunInvariants(run.id, recorder.events, snapshot)).toEqual([]);
    expect(snapshot.run.error).toContain("Approval denied");
    expect(snapshot.tasks.find((task) => task.title === "Add validation")?.status).toBe("failed");
    expect(snapshot.approvals[0]?.status).toBe("denied");
  });

  it("answers misuse with contract-shaped errors", async () => {
    const { client, recorder } = await startRun();
    const pending = await recorder.waitFor((view) =>
      [...view.approvals.values()].find((approval) => approval.status === "pending"),
    );
    await client.resolveApproval(pending.id, "approve");
    await recorder.waitFor((view) => view.run?.status === "completed");
    await recorder.stop();

    const twice = await client.resolveApproval(pending.id, "deny").catch((error: unknown) => error);
    expect(twice).toBeInstanceOf(ApiCallError);
    expect((twice as ApiCallError).status).toBe(409);
    expect(apiErrorSchema.safeParse((twice as ApiCallError).body).success).toBe(true);

    const missing = await client.getSnapshot("00000000-0000-4000-8000-000000000000").catch((error: unknown) => error);
    expect((missing as ApiCallError).status).toBe(404);

    const unauthenticated = await fetch(`${target.baseUrl}/api/runs/${pending.runId}/snapshot`);
    expect(unauthenticated.status).toBe(401);
  });
});

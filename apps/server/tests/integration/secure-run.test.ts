import { afterEach, describe, expect, it } from "vitest";
import { apiErrorSchema, type AgentProfile, type ProposedAction, type RunSnapshot, type SecurityContext, type SecurityPolicy } from "@launchpad/shared";
import { ApiCallError, HarnessClient } from "./harness/client.js";
import { AGENTS, CAPABILITIES, timestamp, WORKSPACE_ID } from "./harness/factories.js";
import { checkRunInvariants } from "./harness/invariants.js";
import { PROFILE_IDS, startStandIn, type StandIn, type StandInOptions } from "./harness/stand-in.js";
import type { RunView } from "./harness/view.js";
import { loadConfig } from "../../src/config.js";
import { DefaultSecurityMiddleware } from "../../src/security-middleware-impl.js";

// Gate 1 of the work plan: one multi-agent Run goes through security
// evaluation, persists its state and emits events, observed only through the
// public API. Runs against stand-in subsystems until the real ones land (see
// harness/stand-in.ts); the assertions below are what the real ones must meet.

const pendingApproval = (view: RunView) =>
  [...view.approvals.values()].find((approval) => approval.status === "pending");

const findingsOf = (snapshot: RunSnapshot, taskTitle: string) => {
  const task = snapshot.tasks.find((candidate) => candidate.title === taskTitle);
  return snapshot.findings
    .filter((finding) => finding.taskId === task?.id)
    .map((finding) => [finding.layer, finding.code, finding.intervened]);
};

describe("secure multi-agent run", () => {
  let target: StandIn;

  afterEach(async () => {
    await target.close();
    expect(target.failures).toEqual([]);
  });

  async function startRun(options: StandInOptions = {}) {
    target = await startStandIn(options);
    const client = new HarnessClient(target);
    const run = await client.createRun({ userPrompt: "Add input validation to the signup endpoint", orchestrationMode: "auto" });
    return { client, run, recorder: client.record(run.id) };
  }

  const executedActions = () => target.runtime.executed.map(({ action }) => action.type);

  it("routes delegation, handoff, command and file actions through one real middleware instance", async () => {
    const evaluations: Array<{ context: SecurityContext; action: ProposedAction }> = [];
    const options: StandInOptions = {
      middlewareFactory: (store, agents) => {
        const profiles = new Map<string, AgentProfile>();
        for (const role of Object.keys(AGENTS) as Array<keyof typeof AGENTS>) {
          profiles.set(PROFILE_IDS[role], {
            id: PROFILE_IDS[role],
            workspaceId: WORKSPACE_ID,
            name: role,
            description: null,
            capabilities: CAPABILITIES[role],
            version: 1,
            archivedAt: null,
            createdAt: timestamp(),
            updatedAt: timestamp(),
          });
        }
        const platformPolicy: SecurityPolicy = {
          id: "00000000-0000-0000-0000-0000000000c1",
          workspaceId: null,
          name: "Fixture platform ceiling",
          scope: "platform",
          capabilityCeiling: { write: true, shell: true, network: true, delegate: true, maxDelegationDepth: 1 },
          rules: {},
          rulesSchemaVersion: 1,
          locked: true,
          version: 1,
          archivedAt: null,
          createdAt: timestamp(),
          updatedAt: timestamp(),
        };
        const middleware = new DefaultSecurityMiddleware({
          config: loadConfig({ NODE_ENV: "test" }),
          checks: () => [],
          source: {
            getAgent: (agentId) => agents.getAgent(agentId),
            getAgentProfile: async (profileId) => profiles.get(profileId) ?? null,
            listSecurityPolicies: async (workspaceId) => workspaceId === WORKSPACE_ID ? [platformPolicy] : [],
            getTaskIdentity: async (taskId) => {
              const task = await store.getTask(taskId);
              const run = task ? await store.getRun(task.runId) : null;
              return task && run ? { runId: run.id, workspaceId: run.workspaceId } : null;
            },
            getExecutionFacts: async (context: SecurityContext) => {
              const execution = await store.getExecution(context.executionId);
              const task = await store.getTask(context.taskId);
              const run = await store.getRun(context.runId);
              const agent = await agents.getAgent(context.agentId);
              if (!execution || !task || !run || !agent || execution.taskId !== task.id ||
                  execution.runId !== run.id || execution.agentId !== agent.id || task.runId !== run.id ||
                  task.assignedAgentId !== agent.id || run.workspaceId !== context.workspaceId) return null;
              let delegationDepth = 0;
              let parentTaskId = task.parentTaskId;
              const visited = new Set([task.id]);
              while (parentTaskId !== null) {
                if (visited.has(parentTaskId)) return null;
                visited.add(parentTaskId);
                const parent = await store.getTask(parentTaskId);
                if (!parent || parent.runId !== run.id) return null;
                delegationDepth += 1;
                parentTaskId = parent.parentTaskId;
              }
              return {
                workspaceId: run.workspaceId,
                runId: run.id,
                taskId: task.id,
                agentId: agent.id,
                userPrompt: run.userPrompt,
                taskObjective: task.objective,
                agentInstructions: agent.instructions,
                delegationDepth,
              };
            },
          },
        });
        return {
          resolvePolicy: (workspaceId, agentId) => middleware.resolvePolicy(workspaceId, agentId),
          openExecution: async (context) => {
            const guard = await middleware.openExecution(context);
            return {
              ...guard,
              evaluate: async (action) => {
                evaluations.push({ context, action });
                return guard.evaluate(action);
              },
            };
          },
        };
      },
    };
    const { client, run, recorder } = await startRun(options);
    await recorder.waitFor((view) => view.run?.status === "completed");
    const snapshot = await client.getSnapshot(run.id);
    await recorder.stop();

    expect(checkRunInvariants(run.id, recorder.events, snapshot)).toEqual([]);
    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.findings.map(({ code }) => code)).toContain("capability-network-denied");
    expect(executedActions()).toEqual(["command", "file_change"]);
    expect(snapshot.executions.every(({ capabilities }) => capabilities !== null)).toBe(true);
    expect(evaluations.map(({ action }) => action.type)).toEqual([
      "delegation", "delegation", "command", "context_handoff", "command", "file_change",
    ]);
  });

  it("plans, delegates, blocks exfiltration, pauses for approval and completes", async () => {
    const { client, run, recorder } = await startRun();
    expect(run.status).toBe("queued");

    await recorder.waitFor((view) => view.run?.status === "waiting_approval");
    const pending = await recorder.waitFor(pendingApproval);
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
    expect(snapshot.dependencies).toEqual([{ runId: run.id, taskId: implement!.id, dependsOnTaskId: analyse!.id }]);
    expect(implement!.parentTaskId).toBe(plan!.id);

    // The exfiltration was refused, the file change ran once approved.
    expect(findingsOf(snapshot, "Add validation")).toEqual([
      ["deterministic", "read-then-egress", true],
      ["policy", "write-requires-approval", true],
      ["runtime", "approval-approved", false],
    ]);
    expect(executedActions()).toEqual(["command", "file_change"]);
    expect(snapshot.approvals).toEqual([
      expect.objectContaining({ id: pending.id, status: "approved", resolvedByUserId: expect.any(String) }),
    ]);

    // Each execution carries the capabilities it launched with.
    const capabilitiesOf = (agentId: string) =>
      snapshot.executions.find((execution) => execution.agentId === agentId)?.capabilities;
    expect(capabilitiesOf(AGENTS.supervisor)).toMatchObject({ delegate: true, write: false });
    expect(capabilitiesOf(AGENTS.analyst)).toMatchObject({ write: false });
    expect(capabilitiesOf(AGENTS.developer)).toMatchObject({ write: true });

    // Delegations went through the middleware on the supervisor's execution.
    // The analysis result reached the implementer only as an evaluated
    // context_handoff (contract decision 7), on the receiving execution; every
    // other action on the execution that proposed it.
    const executionFor = (taskId: string) => snapshot.executions.find((execution) => execution.taskId === taskId)!.id;
    expect(
      target.middleware.evaluations.map(({ context, action }) => [action.type, context.executionId]),
    ).toEqual([
      ["delegation", executionFor(plan!.id)],
      ["delegation", executionFor(plan!.id)],
      ["command", executionFor(analyse!.id)],
      ["context_handoff", executionFor(implement!.id)],
      ["command", executionFor(implement!.id)],
      ["file_change", executionFor(implement!.id)],
    ]);
  });

  it("declines only the action when an approval is denied, and the run carries on", async () => {
    const { client, run, recorder } = await startRun();
    const pending = await recorder.waitFor(pendingApproval);

    await client.resolveApproval(pending.id, "deny");
    await recorder.waitFor((view) => view.run?.status === "completed");
    const snapshot = await client.getSnapshot(run.id);
    await recorder.stop();

    expect(checkRunInvariants(run.id, recorder.events, snapshot)).toEqual([]);
    expect(snapshot.approvals[0]?.status).toBe("denied");
    expect(snapshot.tasks.find((task) => task.title === "Add validation")?.status).toBe("completed");
    expect(findingsOf(snapshot, "Add validation")).toContainEqual(["runtime", "approval-denied", true]);
    expect(executedActions()).toEqual(["command"]);
  });

  it("pauses planning for a gated delegation and resumes planning once approved", async () => {
    const { client, run, recorder } = await startRun({ gateWriteDelegations: true });

    const delegation = await recorder.waitFor(pendingApproval);
    expect(delegation.actionType).toBe("delegation");
    await client.resolveApproval(delegation.id, "approve");
    const fileChange = await recorder.waitFor((view) => {
      const next = pendingApproval(view);
      return next && next.id !== delegation.id ? next : undefined;
    });
    await client.resolveApproval(fileChange.id, "approve");
    await recorder.waitFor((view) => view.run?.status === "completed");
    const snapshot = await client.getSnapshot(run.id);
    await recorder.stop();

    expect(checkRunInvariants(run.id, recorder.events, snapshot)).toEqual([]);
    const runStatuses = recorder.events.flatMap((event) => (event.type === "run.updated" ? [event.payload.run.status] : []));
    expect(runStatuses.slice(0, 7)).toEqual([
      "queued",
      "planning",
      "waiting_approval",
      "planning",
      "running",
      "waiting_approval",
      "running",
    ]);
    expect(findingsOf(snapshot, "Plan")).toEqual([
      ["policy", "write-delegation-requires-approval", true],
      ["runtime", "approval-approved", false],
    ]);
  });

  it("creates no task, and no dependents, for a delegation that is denied", async () => {
    const { client, run, recorder } = await startRun({ gateWriteDelegations: true });

    const delegation = await recorder.waitFor(pendingApproval);
    await client.resolveApproval(delegation.id, "deny");
    await recorder.waitFor((view) => view.run?.status === "completed");
    const snapshot = await client.getSnapshot(run.id);
    await recorder.stop();

    expect(checkRunInvariants(run.id, recorder.events, snapshot)).toEqual([]);
    expect(snapshot.tasks.map((task) => task.title)).toEqual(["Plan", "Find missing validation"]);
    expect(findingsOf(snapshot, "Plan")).toEqual([
      ["policy", "write-delegation-requires-approval", true],
      ["runtime", "approval-denied", true],
    ]);
  });

  it("cancels a run waiting for approval, idempotently", async () => {
    const { client, run, recorder } = await startRun();
    await recorder.waitFor(pendingApproval);

    const requested = await client.cancelRun(run.id);
    expect(requested.cancelRequestedAt).not.toBeNull();
    expect((await client.cancelRun(run.id)).cancelRequestedAt).toBe(requested.cancelRequestedAt);

    await recorder.waitFor((view) => view.run?.status === "cancelled");
    const snapshot = await client.getSnapshot(run.id);
    await recorder.stop();

    expect(checkRunInvariants(run.id, recorder.events, snapshot)).toEqual([]);
    expect(snapshot.approvals.map((approval) => approval.status)).toEqual(["cancelled"]);
    expect(snapshot.tasks.find((task) => task.title === "Add validation")?.status).toBe("cancelled");
    expect(executedActions()).not.toContain("file_change");
    expect((await client.cancelRun(run.id)).cancelRequestedAt).toBe(requested.cancelRequestedAt);
  });

  it("answers misuse with contract-shaped errors", async () => {
    const { client, recorder } = await startRun();
    const pending = await recorder.waitFor(pendingApproval);
    await client.resolveApproval(pending.id, "approve");
    await recorder.waitFor((view) => view.run?.status === "completed");
    await recorder.stop();

    const twice = await client.resolveApproval(pending.id, "deny").catch((error: unknown) => error);
    expect(twice).toBeInstanceOf(ApiCallError);
    expect((twice as ApiCallError).status).toBe(409);
    expect(apiErrorSchema.safeParse((twice as ApiCallError).body).success).toBe(true);

    const finished = await client.cancelRun(pending.runId).catch((error: unknown) => error);
    expect((finished as ApiCallError).status).toBe(409);

    const missing = await client.getSnapshot("00000000-0000-4000-8000-000000000000").catch((error: unknown) => error);
    expect((missing as ApiCallError).status).toBe(404);

    const unauthenticated = await fetch(`${target.baseUrl}/api/runs/${pending.runId}/snapshot`);
    expect(unauthenticated.status).toBe(401);
  });
});

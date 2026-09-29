import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_TYPES,
  agentExecutionSchema,
  approvalSchema,
  auditEventSchema,
  createRunRequestSchema,
  encodeRunEventFrame,
  executionStatusSchema,
  findingSeveritySchema,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  orchestrationModeSchema,
  policyScopeSchema,
  proposedActionSchema,
  runEventSchema,
  runSchema,
  runSnapshotSchema,
  runStatusSchema,
  securityContextSchema,
  securityDecisionSchema,
  securityFindingSchema,
  securityLayerSchema,
  securityPolicySchema,
  taskDependencySchema,
  taskSchema,
  taskStatusSchema,
  approvalStatusSchema,
  workspaceRoleSchema,
  RUN_TRANSITIONS,
  TASK_TRANSITIONS,
  EXECUTION_TRANSITIONS,
  APPROVAL_TRANSITIONS,
  canTransitionRun,
  canTransitionTask,
  type RunEvent,
} from "../src/index.js";
import { approval, execution, finding, ids, now, run, securityContext, task } from "./fixtures.js";

describe("shared enums", () => {
  // Pinned to the "Shared enum" table in the work plan (section 3.1). A failure
  // here means a contract change that every affected owner should review.
  it.each([
    [workspaceRoleSchema, ["developer", "security_admin", "auditor"]],
    [policyScopeSchema, ["platform", "workspace"]],
    [runStatusSchema, ["queued", "planning", "running", "waiting_approval", "completed", "failed", "cancelled"]],
    [
      taskStatusSchema,
      ["pending", "ready", "running", "waiting_approval", "completed", "failed", "skipped", "cancelled"],
    ],
    [executionStatusSchema, ["queued", "running", "waiting_approval", "completed", "failed", "cancelled"]],
    [approvalStatusSchema, ["pending", "approved", "denied", "timed_out", "cancelled"]],
    [findingSeveritySchema, ["info", "low", "medium", "high", "critical"]],
    [securityLayerSchema, ["deterministic", "semantic", "policy", "memory", "runtime"]],
    [orchestrationModeSchema, ["single", "auto"]],
  ] as const)("%# matches the plan", (schema, values) => {
    expect(schema.options).toEqual(values);
  });

  it("defines transitions for every status, to known statuses only", () => {
    const tables = [
      [RUN_TRANSITIONS, runStatusSchema],
      [TASK_TRANSITIONS, taskStatusSchema],
      [EXECUTION_TRANSITIONS, executionStatusSchema],
      [APPROVAL_TRANSITIONS, approvalStatusSchema],
    ] as const;
    for (const [table, schema] of tables) {
      expect(Object.keys(table).sort()).toEqual([...schema.options].sort());
      for (const targets of Object.values(table) as string[][]) {
        for (const target of targets) expect(schema.options).toContain(target);
      }
    }
  });

  it("allows the normal path and refuses leaving a terminal status", () => {
    expect(canTransitionRun("queued", "planning")).toBe(true);
    expect(canTransitionRun("waiting_approval", "running")).toBe(true);
    expect(canTransitionRun("completed", "running")).toBe(false);
    expect(canTransitionTask("pending", "running")).toBe(false);
    expect(canTransitionTask("ready", "running")).toBe(true);
  });

  it("identifies terminal statuses", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("waiting_approval")).toBe(false);
    expect(isTerminalTaskStatus("skipped")).toBe(true);
    expect(isTerminalTaskStatus("ready")).toBe(false);
  });
});

describe("domain entities", () => {
  it("accepts well-formed records", () => {
    expect(runSchema.parse(run)).toEqual(run);
    expect(taskSchema.parse(task)).toEqual(task);
    expect(agentExecutionSchema.parse(execution)).toEqual(execution);
    expect(securityFindingSchema.parse(finding)).toEqual(finding);
    expect(approvalSchema.parse(approval)).toEqual(approval);
  });

  it("requires UTC timestamps", () => {
    expect(runSchema.safeParse({ ...run, createdAt: "2026-09-29T14:00:00+08:00" }).success).toBe(false);
    expect(runSchema.safeParse({ ...run, createdAt: "29/09/2026" }).success).toBe(false);
  });

  it("requires UUID ids", () => {
    expect(runSchema.safeParse({ ...run, id: "run-1" }).success).toBe(false);
  });

  it("requires nullable columns to be present", () => {
    const { finalOutput: _omitted, ...withoutFinalOutput } = run;
    expect(runSchema.safeParse(withoutFinalOutput).success).toBe(false);
  });

  it("rejects a task that depends on itself", () => {
    expect(taskDependencySchema.safeParse({ taskId: ids.task, dependsOnTaskId: ids.otherTask }).success).toBe(true);
    expect(taskDependencySchema.safeParse({ taskId: ids.task, dependsOnTaskId: ids.task }).success).toBe(false);
  });

  it("ties policy scope to workspaceId", () => {
    const policy = {
      id: ids.finding,
      workspaceId: null,
      name: "No secrets egress",
      scope: "platform",
      rules: { denyPaths: [".env"] },
      locked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    expect(securityPolicySchema.safeParse(policy).success).toBe(true);
    expect(securityPolicySchema.safeParse({ ...policy, workspaceId: ids.workspace }).success).toBe(false);
    expect(securityPolicySchema.safeParse({ ...policy, scope: "workspace" }).success).toBe(false);
    expect(
      securityPolicySchema.safeParse({ ...policy, scope: "workspace", workspaceId: ids.workspace }).success,
    ).toBe(true);
  });

  it("requires an actorId for user and agent audit events", () => {
    const event = {
      id: ids.event,
      workspaceId: ids.workspace,
      actorType: "system",
      actorId: null,
      eventType: "run.status_changed",
      runId: ids.run,
      taskId: null,
      executionId: null,
      metadata: { from: "planning", to: "running" },
      createdAt: now,
    };
    expect(auditEventSchema.safeParse(event).success).toBe(true);
    expect(auditEventSchema.safeParse({ ...event, actorType: "user" }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...event, eventType: "made.up" }).success).toBe(false);
  });
});

describe("security middleware contract", () => {
  it("accepts a delegated specialist context", () => {
    expect(securityContextSchema.parse(securityContext)).toEqual(securityContext);
  });

  it("parses each proposed action kind", () => {
    const actions = [
      { type: "command", actionId: "item_1", command: "npm test", cwd: null },
      {
        type: "file_change",
        actionId: "item_2",
        changes: [{ path: "src/signup.ts", kind: "update", movePath: null, diff: "@@ -1 +1 @@" }],
      },
      {
        type: "delegation",
        actionId: "item_3",
        targetAgentId: ids.specialist,
        title: "Write tests",
        objective: "Cover the new validation",
        dependsOnTaskIds: [ids.task],
      },
    ];
    for (const action of actions) {
      expect(proposedActionSchema.parse(action)).toEqual(action);
    }
  });

  it("rejects an empty file change", () => {
    expect(proposedActionSchema.safeParse({ type: "file_change", actionId: "item_2", changes: [] }).success).toBe(
      false,
    );
  });

  it("requires steering text for steer and a reason for require_approval", () => {
    const base = { reason: "Command reads .env before a network call.", severity: "high", findings: [] };
    expect(securityDecisionSchema.safeParse({ ...base, outcome: "allow" }).success).toBe(true);
    expect(securityDecisionSchema.safeParse({ ...base, outcome: "steer" }).success).toBe(false);
    expect(
      securityDecisionSchema.safeParse({ ...base, outcome: "steer", steer: "Do not send workspace secrets." }).success,
    ).toBe(true);
    expect(securityDecisionSchema.safeParse({ ...base, outcome: "block", steer: null }).success).toBe(true);
    expect(securityDecisionSchema.safeParse({ ...base, outcome: "require_approval" }).success).toBe(false);
    expect(
      securityDecisionSchema.safeParse({ ...base, outcome: "require_approval", approvalReason: "policy_required" })
        .success,
    ).toBe(true);
  });
});

describe("run events", () => {
  const envelope = { id: ids.event, runId: ids.run, timestamp: now };
  const events: RunEvent[] = [
    { ...envelope, seq: 1, type: "run.updated", payload: { run } },
    { ...envelope, seq: 2, type: "task.created", payload: { task, dependsOnTaskIds: [] } },
    { ...envelope, seq: 3, type: "task.updated", payload: { task } },
    { ...envelope, seq: 4, type: "execution.updated", payload: { execution } },
    { ...envelope, seq: 5, type: "finding.created", payload: { finding } },
    { ...envelope, seq: 6, type: "approval.requested", payload: { approval } },
    { ...envelope, seq: 7, type: "approval.resolved", payload: { approval: { ...approval, status: "approved" } } },
  ];

  it("covers every event type", () => {
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(RUN_EVENT_TYPES));
  });

  it.each(events)("parses $type", (event) => {
    expect(runEventSchema.parse(event)).toEqual(event);
  });

  it("rejects a payload that does not match its type", () => {
    expect(runEventSchema.safeParse({ ...envelope, seq: 1, type: "task.updated", payload: { run } }).success).toBe(
      false,
    );
  });

  it("rejects unknown event types", () => {
    expect(runEventSchema.safeParse({ ...envelope, seq: 1, type: "run.exploded", payload: {} }).success).toBe(false);
  });

  it("encodes an SSE frame that round-trips", () => {
    const event = events[4]!;
    const frame = encodeRunEventFrame(event);
    expect(frame.startsWith("id: 5\ndata: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    const data = frame.slice(frame.indexOf("data: ") + "data: ".length).trimEnd();
    expect(runEventSchema.parse(JSON.parse(data))).toEqual(event);
  });

  it("describes a run snapshot", () => {
    const snapshot = {
      run,
      tasks: [task],
      dependencies: [],
      executions: [execution],
      findings: [finding],
      approvals: [approval],
      lastEventSeq: 7,
    };
    expect(runSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
});

describe("api payloads", () => {
  it("defaults a new run to single-agent mode", () => {
    expect(createRunRequestSchema.parse({ userPrompt: "Fix the flaky test" })).toEqual({
      userPrompt: "Fix the flaky test",
      orchestrationMode: "single",
    });
  });

  it("rejects a blank prompt", () => {
    expect(createRunRequestSchema.safeParse({ userPrompt: "   " }).success).toBe(false);
  });
});

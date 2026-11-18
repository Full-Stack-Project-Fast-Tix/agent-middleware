import { randomUUID } from "node:crypto";
import type { AgentCapabilities, AgentExecution, Approval, Run, SecurityFinding, Task } from "@launchpad/shared";

export const WORKSPACE_ID = "7d3c1a0e-5b1f-4c8e-9a2d-1f0e3b4c5d6e";
export const USER_ID = "0b9e8d7c-6a5b-4c3d-8e2f-1a0b9c8d7e6f";
export const AGENTS = {
  supervisor: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  analyst: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  developer: "3a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d",
} as const;

/** Profiles for the three stand-in agents: only the supervisor delegates, only the developer writes. */
export const CAPABILITIES: Record<keyof typeof AGENTS, AgentCapabilities> = {
  supervisor: { write: false, shell: false, network: false, delegate: true, maxDelegationDepth: 1 },
  analyst: { write: false, shell: true, network: false, delegate: false, maxDelegationDepth: 0 },
  developer: { write: true, shell: true, network: false, delegate: false, maxDelegationDepth: 0 },
};

export const timestamp = (): string => new Date().toISOString();

export function makeRun(overrides: Partial<Run> = {}): Run {
  const now = timestamp();
  return {
    id: randomUUID(),
    workspaceId: WORKSPACE_ID,
    parentRunId: null,
    createdByUserId: USER_ID,
    supervisorAgentId: null,
    userPrompt: "Add input validation to the signup endpoint",
    orchestrationMode: "single",
    status: "queued",
    finalOutput: null,
    error: null,
    cancelRequestedAt: null,
    evaluation: null,
    finalReview: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

export function makeTask(runId: string, overrides: Partial<Task> = {}): Task {
  const now = timestamp();
  return {
    id: randomUUID(),
    runId,
    parentTaskId: null,
    createdByExecutionId: null,
    title: "Task",
    objective: "Do the task",
    assignedAgentId: null,
    status: "pending",
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

export function makeExecution(task: Task, agentId: string, overrides: Partial<AgentExecution> = {}): AgentExecution {
  const now = timestamp();
  return {
    id: randomUUID(),
    runId: task.runId,
    taskId: task.id,
    agentId,
    attempt: 1,
    status: "queued",
    capabilities: CAPABILITIES.analyst,
    threadId: null,
    output: null,
    error: null,
    usage: null,
    tracePath: null,
    traceTruncated: false,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

export function makeFinding(execution: AgentExecution, overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: randomUUID(),
    runId: execution.runId,
    taskId: execution.taskId,
    executionId: execution.id,
    agentId: execution.agentId,
    layer: "deterministic",
    check: "check",
    code: "code",
    severity: "info",
    message: "Finding.",
    facts: null,
    evidence: null,
    intervened: false,
    createdAt: timestamp(),
    ...overrides,
  };
}

export function makeApproval(execution: AgentExecution, overrides: Partial<Approval> = {}): Approval {
  return {
    id: randomUUID(),
    runId: execution.runId,
    taskId: execution.taskId,
    executionId: execution.id,
    agentId: execution.agentId,
    actionType: "command",
    actionId: null,
    reason: "high_consequence",
    summary: "Approve the action",
    safeDetails: null,
    status: "pending",
    requestedAt: timestamp(),
    expiresAt: null,
    resolvedAt: null,
    resolvedByUserId: null,
    ...overrides,
  };
}

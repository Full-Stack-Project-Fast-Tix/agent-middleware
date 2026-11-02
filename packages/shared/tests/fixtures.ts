import type {
  AgentExecution,
  Approval,
  Run,
  SecurityContext,
  SecurityFinding,
  Task,
} from "../src/index.js";

export const ids = {
  workspace: "7d3c1a0e-5b1f-4c8e-9a2d-1f0e3b4c5d6e",
  user: "0b9e8d7c-6a5b-4c3d-8e2f-1a0b9c8d7e6f",
  supervisor: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  specialist: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  run: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b",
  task: "4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c",
  otherTask: "5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d",
  execution: "6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d0e",
  supervisorExecution: "7c8d9e0f-1a2b-4c3d-8e5f-6a7b8c9d0e1f",
  finding: "8d9e0f1a-2b3c-4d4e-9f6a-7b8c9d0e1f2a",
  approval: "9e0f1a2b-3c4d-4e5f-8a7b-8c9d0e1f2a3b",
  event: "af1a2b3c-4d5e-4f6a-9b8c-9d0e1f2a3b4c",
} as const;

export const now = "2026-09-29T06:00:00.000Z";

export const run: Run = {
  id: ids.run,
  workspaceId: ids.workspace,
  parentRunId: null,
  createdByUserId: ids.user,
  supervisorAgentId: ids.supervisor,
  userPrompt: "Add input validation to the signup endpoint",
  orchestrationMode: "auto",
  status: "running",
  finalOutput: null,
  error: null,
  cancelRequestedAt: null,
  evaluation: null,
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  completedAt: null,
};

export const task: Task = {
  id: ids.task,
  runId: ids.run,
  parentTaskId: null,
  createdByExecutionId: ids.supervisorExecution,
  title: "Review signup handler",
  objective: "Identify missing validation in the signup handler",
  assignedAgentId: ids.specialist,
  status: "running",
  result: null,
  error: null,
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  completedAt: null,
};

export const execution: AgentExecution = {
  id: ids.execution,
  runId: ids.run,
  taskId: ids.task,
  agentId: ids.specialist,
  attempt: 1,
  status: "running",
  capabilities: { write: false, shell: true, network: false, delegate: false, maxDelegationDepth: 0 },
  threadId: null,
  output: null,
  error: null,
  usage: null,
  tracePath: "runs/3e4f/executions/6b7c.jsonl",
  traceTruncated: false,
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  completedAt: null,
};

export const finding: SecurityFinding = {
  id: ids.finding,
  runId: ids.run,
  taskId: ids.task,
  executionId: ids.execution,
  agentId: ids.specialist,
  layer: "deterministic",
  check: "sensitive-egress",
  code: "read-then-egress",
  severity: "high",
  message: "The agent read .env and then attempted a network request.",
  facts: { host: "example.org" },
  evidence: { traceSeqs: [12, 19] },
  intervened: true,
  createdAt: now,
};

export const approval: Approval = {
  id: ids.approval,
  runId: ids.run,
  taskId: ids.task,
  executionId: ids.execution,
  agentId: ids.specialist,
  actionType: "command",
  actionId: "item_42",
  reason: "high_consequence",
  summary: "Run database migration",
  safeDetails: { command: "npm run migrate" },
  status: "pending",
  requestedAt: now,
  expiresAt: "2026-09-29T06:05:00.000Z",
  resolvedAt: null,
  resolvedByUserId: null,
};

export const securityContext: SecurityContext = {
  workspaceId: ids.workspace,
  runId: ids.run,
  taskId: ids.task,
  executionId: ids.execution,
  agentId: ids.specialist,
};

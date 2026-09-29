import type { ApprovalStatus, ExecutionStatus, RunStatus, TaskStatus } from "./enums.js";

// Allowed status transitions. The orchestrator should refuse anything else,
// the integration harness flags anything else, and the UI can rely on it.
// A status with no outgoing transitions is terminal. An update that keeps
// the same status (to change another field) is not a transition.

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  // `single` mode skips planning.
  queued: ["planning", "running", "failed", "cancelled"],
  planning: ["running", "failed", "cancelled"],
  running: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  // The scheduler marks a task ready only once every dependency has completed.
  pending: ["ready", "failed", "skipped", "cancelled"],
  ready: ["running", "failed", "skipped", "cancelled"],
  // A retry is a new AgentExecution; the task itself stays running.
  running: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  queued: ["running", "failed", "cancelled"],
  running: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  pending: ["approved", "denied", "timed_out", "cancelled"],
  approved: [],
  denied: [],
  timed_out: [],
  cancelled: [],
};

export const canTransitionRun = (from: RunStatus, to: RunStatus): boolean => RUN_TRANSITIONS[from].includes(to);
export const canTransitionTask = (from: TaskStatus, to: TaskStatus): boolean => TASK_TRANSITIONS[from].includes(to);
export const canTransitionExecution = (from: ExecutionStatus, to: ExecutionStatus): boolean =>
  EXECUTION_TRANSITIONS[from].includes(to);
export const canTransitionApproval = (from: ApprovalStatus, to: ApprovalStatus): boolean =>
  APPROVAL_TRANSITIONS[from].includes(to);

export const isTerminalRunStatus = (status: RunStatus): boolean => RUN_TRANSITIONS[status].length === 0;
export const isTerminalTaskStatus = (status: TaskStatus): boolean => TASK_TRANSITIONS[status].length === 0;
export const isTerminalExecutionStatus = (status: ExecutionStatus): boolean =>
  EXECUTION_TRANSITIONS[status].length === 0;
export const isTerminalApprovalStatus = (status: ApprovalStatus): boolean =>
  APPROVAL_TRANSITIONS[status].length === 0;

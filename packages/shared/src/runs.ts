import { z } from "zod";
import { idSchema, lifecycleTimestampsShape, nonEmptyStringSchema } from "./common.js";
import { executionStatusSchema, orchestrationModeSchema, runStatusSchema, taskStatusSchema } from "./enums.js";

/** One complete user request. Parent of Tasks, AgentExecutions, Findings, Approvals and AuditEvents. */
export const runSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  createdByUserId: idSchema,
  supervisorAgentId: idSchema.nullable(),
  userPrompt: nonEmptyStringSchema,
  orchestrationMode: orchestrationModeSchema,
  status: runStatusSchema,
  finalOutput: z.string().nullable(),
  error: z.string().nullable(),
  ...lifecycleTimestampsShape,
});
export type Run = z.infer<typeof runSchema>;

/** One orchestration unit: a node in the Run's task DAG. */
export const taskSchema = z.object({
  id: idSchema,
  runId: idSchema,
  parentTaskId: idSchema.nullable(),
  /** The execution (usually the supervisor's) that created this task by delegation. */
  createdByExecutionId: idSchema.nullable(),
  title: nonEmptyStringSchema,
  objective: nonEmptyStringSchema,
  assignedAgentId: idSchema.nullable(),
  status: taskStatusSchema,
  result: z.string().nullable(),
  error: z.string().nullable(),
  ...lifecycleTimestampsShape,
});
export type Task = z.infer<typeof taskSchema>;

/** DAG edge: `taskId` becomes ready only when `dependsOnTaskId` has completed. */
export const taskDependencySchema = z
  .object({
    taskId: idSchema,
    dependsOnTaskId: idSchema,
  })
  .refine((edge) => edge.taskId !== edge.dependsOnTaskId, {
    message: "A task cannot depend on itself",
    path: ["dependsOnTaskId"],
  });
export type TaskDependency = z.infer<typeof taskDependencySchema>;

/** Token usage, matching what the Codex runtime already reports. */
export const executionUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});
export type ExecutionUsage = z.infer<typeof executionUsageSchema>;

/**
 * One attempt by an Agent to execute a Task. A retry is a new row with the
 * next `attempt`. The raw JSONL trace stays on disk; only its path is stored.
 */
export const agentExecutionSchema = z.object({
  id: idSchema,
  runId: idSchema,
  taskId: idSchema,
  agentId: idSchema,
  attempt: z.number().int().positive(),
  status: executionStatusSchema,
  threadId: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  usage: executionUsageSchema.nullable(),
  tracePath: z.string().nullable(),
  ...lifecycleTimestampsShape,
});
export type AgentExecution = z.infer<typeof agentExecutionSchema>;

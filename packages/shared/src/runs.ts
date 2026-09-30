import { z } from "zod";
import { idSchema, lifecycleTimestampsShape, nonEmptyStringSchema, timestampSchema } from "./common.js";
import { agentCapabilitiesSchema } from "./agents.js";
import { executionStatusSchema, orchestrationModeSchema, runStatusSchema, taskStatusSchema } from "./enums.js";

/**
 * Benchmark labels, unset for ordinary runs. Carried over from the single-agent
 * runtime so benchmark scenarios keep scoring whole runs (see RunEvaluation in
 * apps/server/src/types.ts).
 */
export const runEvaluationSchema = z.object({
  scenarioId: nonEmptyStringSchema,
  attackPresent: z.boolean(),
  userGoal: z.string(),
  attackGoal: z.string().nullable(),
  /** Null until something judges the run. */
  userGoalAchieved: z.boolean().nullable(),
  attackGoalAchieved: z.boolean().nullable(),
});
export type RunEvaluation = z.infer<typeof runEvaluationSchema>;

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
  /** Set the moment a cancel is requested; status becomes cancelled once work has stopped. */
  cancelRequestedAt: timestampSchema.nullable(),
  evaluation: runEvaluationSchema.nullable(),
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

/**
 * DAG edge: `taskId` becomes ready only when `dependsOnTaskId` has completed.
 * Both tasks belong to `runId`, which lets the database enforce that edges
 * never cross runs.
 */
export const taskDependencySchema = z
  .object({
    runId: idSchema,
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
  /**
   * Effective capabilities when the execution launched. The scheduler
   * serialises executions with `write`, and audit can show why two ran at once.
   */
  capabilities: agentCapabilitiesSchema,
  threadId: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  usage: executionUsageSchema.nullable(),
  tracePath: z.string().nullable(),
  /** True when the trace hit its size cap and later records were dropped. */
  traceTruncated: z.boolean(),
  ...lifecycleTimestampsShape,
});
export type AgentExecution = z.infer<typeof agentExecutionSchema>;

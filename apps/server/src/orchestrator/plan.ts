import { z } from "zod";
import { idSchema, type Agent } from "@launchpad/shared";

// The supervisor's plan: what it proposes, and the checks it must pass before
// any of it is acted on. The plan is model output, so it is validated twice:
// the schema checks its shape, validatePlan checks it against the workspace
// (registered agents, a DAG, the configured limits). Only then does each task
// become a delegation the security middleware evaluates.

/** Model-facing hard cap. The configured limit (OrchestratorLimits.maxTasks) is checked in validatePlan. */
const MAX_PLANNED_TASKS = 50;

const taskKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Use 1-40 lowercase letters, digits, - or _");

export const plannedTaskSchema = z.object({
  /** Plan-local name, used only to express dependencies inside this plan. */
  key: taskKeySchema,
  title: z.string().trim().min(1).max(120),
  /** Everything the assigned agent is told about its task, besides earlier results. */
  objective: z.string().trim().min(1).max(4_000),
  agentId: idSchema,
  dependsOn: z.array(taskKeySchema).max(MAX_PLANNED_TASKS).default([]),
});
export type PlannedTask = z.infer<typeof plannedTaskSchema>;

export const supervisorPlanSchema = z.object({
  tasks: z.array(plannedTaskSchema).min(1).max(MAX_PLANNED_TASKS),
});
export type SupervisorPlan = z.infer<typeof supervisorPlanSchema>;

export interface PlanValidationContext {
  workspaceId: string;
  /** The supervisor itself may not be assigned work: that would be unbounded self-delegation. */
  supervisorAgentId: string;
  /** Every agent in the workspace, including disabled and archived ones. */
  agents: readonly Agent[];
  maxTasks: number;
}

export type PlanValidation =
  | { ok: true; tasks: PlannedTask[] }
  | { ok: false; errors: string[] };

/**
 * Check a plan against the workspace. On success the tasks are returned in
 * dependency order: every task comes after the tasks it depends on, and
 * otherwise keeps the order the supervisor gave. Reports every problem, not
 * just the first, so a rejected plan can be explained in one message.
 *
 * Pure: no I/O, so it can be tested without a model or a database.
 */
export function validatePlan(plan: SupervisorPlan, context: PlanValidationContext): PlanValidation {
  const errors: string[] = [];
  const { tasks } = plan;

  if (tasks.length > context.maxTasks) {
    errors.push(`The plan has ${tasks.length} tasks; at most ${context.maxTasks} are allowed.`);
  }

  const keys = new Set<string>();
  for (const task of tasks) {
    if (keys.has(task.key)) errors.push(`Task key "${task.key}" is used more than once.`);
    keys.add(task.key);
  }

  const agentsById = new Map(context.agents.map((agent) => [agent.id, agent]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.key) errors.push(`Task "${task.key}" depends on itself.`);
      else if (!keys.has(dependency)) errors.push(`Task "${task.key}" depends on unknown task "${dependency}".`);
    }

    const agent = agentsById.get(task.agentId);
    if (task.agentId === context.supervisorAgentId) {
      errors.push(`Task "${task.key}" is assigned to the supervisor itself.`);
    } else if (agent === undefined || agent.workspaceId !== context.workspaceId) {
      errors.push(`Task "${task.key}" is assigned to an agent that is not registered in this workspace.`);
    } else if (!agent.enabled || agent.archivedAt !== null) {
      errors.push(`Task "${task.key}" is assigned to agent "${agent.name}", which is disabled or archived.`);
    }
  }

  // Dependency errors above make ordering meaningless; report those alone.
  if (errors.length > 0) return { ok: false, errors };

  const ordered = dependencyOrder(tasks);
  if (ordered === null) return { ok: false, errors: ["The plan's dependencies form a cycle."] };
  return { ok: true, tasks: ordered };
}

/** Stable topological order, or null when there is a cycle. */
function dependencyOrder(tasks: readonly PlannedTask[]): PlannedTask[] | null {
  const placed = new Set<string>();
  const ordered: PlannedTask[] = [];
  const remaining = [...tasks];
  while (remaining.length > 0) {
    // The earliest task, in the supervisor's order, whose dependencies are placed.
    const index = remaining.findIndex((task) => task.dependsOn.every((key) => placed.has(key)));
    if (index < 0) return null;
    const [next] = remaining.splice(index, 1);
    placed.add(next!.key);
    ordered.push(next!);
  }
  return ordered;
}

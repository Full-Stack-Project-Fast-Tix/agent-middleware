import { describe, expect, it } from "vitest";
import { supervisorPlanSchema, validatePlan, type PlannedTask } from "../../src/orchestrator/plan.js";
import { AGENTS, WORKSPACE_ID, makeAgent } from "./fixtures.js";

const agents = [makeAgent("supervisor"), makeAgent("analyst"), makeAgent("developer")];
const context = { workspaceId: WORKSPACE_ID, supervisorAgentId: AGENTS.supervisor, agents, maxTasks: 6 };

const task = (key: string, dependsOn: string[] = [], agentId: string = AGENTS.analyst): PlannedTask => ({
  key,
  title: `Task ${key}`,
  objective: `Do ${key}`,
  agentId,
  dependsOn,
});

const errorsOf = (tasks: PlannedTask[], overrides: Partial<typeof context> = {}) => {
  const result = validatePlan({ tasks }, { ...context, ...overrides });
  return result.ok ? [] : result.errors;
};

describe("validatePlan", () => {
  it("returns tasks in dependency order, otherwise keeping the supervisor's order", () => {
    const result = validatePlan(
      { tasks: [task("report", ["test", "build"]), task("build"), task("test", ["build"]), task("docs")] },
      context,
    );
    expect(result.ok && result.tasks.map((planned) => planned.key)).toEqual(["build", "test", "report", "docs"]);
  });

  it("rejects a cycle", () => {
    expect(errorsOf([task("a", ["b"]), task("b", ["a"])])).toEqual(["The plan's dependencies form a cycle."]);
  });

  it("rejects unknown, self and duplicate references, reporting all of them", () => {
    expect(errorsOf([task("a", ["a"]), task("b", ["missing"]), task("b")])).toEqual([
      'Task key "b" is used more than once.',
      'Task "a" depends on itself.',
      'Task "b" depends on unknown task "missing".',
    ]);
  });

  it("only assigns work to enabled agents registered in the workspace, never the supervisor", () => {
    const disabled = makeAgent("developer", { enabled: false });
    const elsewhere = { ...makeAgent("analyst"), workspaceId: "00000000-0000-4000-8000-0000000000ff" };
    expect(errorsOf([task("self", [], AGENTS.supervisor)])).toEqual(['Task "self" is assigned to the supervisor itself.']);
    expect(errorsOf([task("ghost", [], "00000000-0000-4000-8000-000000000000")])).toEqual([
      'Task "ghost" is assigned to an agent that is not registered in this workspace.',
    ]);
    expect(errorsOf([task("off", [], AGENTS.developer)], { agents: [disabled] })).toEqual([
      'Task "off" is assigned to agent "developer", which is disabled or archived.',
    ]);
    expect(errorsOf([task("away")], { agents: [elsewhere] })).toEqual([
      'Task "away" is assigned to an agent that is not registered in this workspace.',
    ]);
  });

  it("enforces the configured task limit", () => {
    expect(errorsOf([task("a"), task("b"), task("c")], { maxTasks: 2 })).toEqual([
      "The plan has 3 tasks; at most 2 are allowed.",
    ]);
  });
});

describe("supervisorPlanSchema", () => {
  it("rejects malformed model output", () => {
    expect(supervisorPlanSchema.safeParse({ tasks: [] }).success).toBe(false);
    expect(supervisorPlanSchema.safeParse({ tasks: [{ ...task("a"), key: "Not A Key" }] }).success).toBe(false);
    expect(supervisorPlanSchema.safeParse({ tasks: [{ ...task("a"), agentId: "analyst" }] }).success).toBe(false);
  });

  it("defaults dependsOn and trims text", () => {
    const parsed = supervisorPlanSchema.parse({
      tasks: [{ key: "a", title: "  Build  ", objective: " Do it ", agentId: AGENTS.analyst }],
    });
    expect(parsed.tasks[0]).toEqual({ key: "a", title: "Build", objective: "Do it", agentId: AGENTS.analyst, dependsOn: [] });
  });
});

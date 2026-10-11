import { describe, expect, it } from "vitest";
import type { TaskDependency } from "@launchpad/shared";
import { layoutTaskGraph } from "./graph-layout";

const RUN = "run";
const node = (id: string, parentTaskId: string | null = null) => ({ id, parentTaskId });
const waits = (taskId: string, dependsOnTaskId: string): TaskDependency => ({ runId: RUN, taskId, dependsOnTaskId });

describe("layoutTaskGraph", () => {
  it("places the plan first, then each task one column after everything it waits for", () => {
    const layout = layoutTaskGraph(
      [node("plan"), node("analyse", "plan"), node("implement", "plan"), node("review", "plan")],
      [waits("implement", "analyse"), waits("review", "implement")],
    );
    expect(layout.nodes).toEqual([
      { taskId: "plan", column: 0, row: 0 },
      { taskId: "analyse", column: 1, row: 0 },
      { taskId: "implement", column: 2, row: 0 },
      { taskId: "review", column: 3, row: 0 },
    ]);
    expect(layout.edges).toEqual([
      { from: "analyse", to: "implement", kind: "dependency" },
      { from: "implement", to: "review", kind: "dependency" },
      { from: "plan", to: "analyse", kind: "delegation" },
    ]);
    expect([layout.columns, layout.rows]).toEqual([4, 1]);
  });

  it("stacks independent tasks in one column, in creation order, and uses the longest path", () => {
    const layout = layoutTaskGraph(
      [node("plan"), node("a", "plan"), node("b", "plan"), node("c", "plan"), node("d", "plan")],
      [waits("c", "a"), waits("d", "a"), waits("d", "c")],
    );
    const at = Object.fromEntries(layout.nodes.map((item) => [item.taskId, [item.column, item.row]]));
    expect(at).toEqual({ plan: [0, 0], a: [1, 0], b: [1, 1], c: [2, 0], d: [3, 0] });
    expect(layout.rows).toBe(2);
  });

  it("lays out a single-agent run as one node with no edges", () => {
    expect(layoutTaskGraph([node("only")], [])).toEqual({
      nodes: [{ taskId: "only", column: 0, row: 0 }],
      edges: [],
      columns: 1,
      rows: 1,
    });
    expect(layoutTaskGraph([], [])).toEqual({ nodes: [], edges: [], columns: 0, rows: 0 });
  });

  it("ignores edges to tasks it has not been told about yet, and survives a cycle", () => {
    expect(layoutTaskGraph([node("a")], [waits("a", "unknown")]).edges).toEqual([]);
    const cyclic = layoutTaskGraph([node("a"), node("b")], [waits("a", "b"), waits("b", "a")]);
    expect(cyclic.nodes).toHaveLength(2);
  });
});

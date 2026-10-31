import { describe, expect, it } from "vitest";
import type { TaskDependency } from "@launchpad/shared";
import { layoutTaskGraph, placeTaskGraph } from "./graph-layout";

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

describe("placeTaskGraph", () => {
  const chain = layoutTaskGraph(
    [node("plan"), node("analyse", "plan"), node("implement", "plan"), node("review", "plan")],
    [waits("implement", "analyse"), waits("review", "implement")],
  );

  it("runs depth across and fills a wide page", () => {
    const placed = placeTaskGraph(chain, 1392);
    expect(placed.orientation).toBe("across");
    expect(placed.nodes.map((item) => item.y)).toEqual([0, 0, 0, 0]);
    expect(placed.nodes[0]!.width).toBe(318);
    expect(placed.width).toBeLessThanOrEqual(1392);
  });

  it("does not stretch a short plan across the whole page", () => {
    expect(placeTaskGraph(layoutTaskGraph([node("only")], []), 1392).width).toBe(340);
  });

  it("keeps nodes readable and overflows into its own frame on a long plan", () => {
    const tasks = Array.from({ length: 10 }, (_, index) => node(`t${index}`));
    const deps = tasks.slice(1).map((task, index) => waits(task.id, tasks[index]!.id));
    const placed = placeTaskGraph(layoutTaskGraph(tasks, deps), 1000);
    expect(placed.nodes[0]!.width).toBe(216);
    expect(placed.width).toBeGreaterThan(1000);
  });

  it("runs depth down the page when narrow, at full width for a single line of tasks", () => {
    const placed = placeTaskGraph(chain, 328);
    expect(placed.orientation).toBe("down");
    expect(placed.nodes.map((item) => item.x)).toEqual([0, 0, 0, 0]);
    expect(placed.nodes[0]!.width).toBe(328);
    expect(placed.width).toBe(328);
    expect(new Set(placed.nodes.map((item) => item.y)).size).toBe(4);
  });

  it("routes a connector that skips a level around the node it passes", () => {
    const layout = layoutTaskGraph([node("a"), node("b"), node("c")], [waits("b", "a"), waits("c", "b"), waits("c", "a")]);
    const across = placeTaskGraph(layout, 1000);
    const skip = across.edges.find((edge) => edge.from === "a" && edge.to === "c")!;
    const middle = across.nodes.find((item) => item.taskId === "b")!;
    const laneY = Number(/V (\d+)/.exec(skip.d)![1]);
    expect(laneY).toBeGreaterThan(middle.y + middle.height);
    expect(across.height).toBeGreaterThan(middle.height);
    const down = placeTaskGraph(layout, 328);
    expect(down.width).toBe(328);
    expect(down.nodes[0]!.width).toBeLessThan(328);
  });

  it("uses right angles only", () => {
    for (const edge of placeTaskGraph(chain, 1392).edges) expect(edge.d).not.toMatch(/[CQSTA]/);
    for (const edge of placeTaskGraph(chain, 328).edges) expect(edge.d).not.toMatch(/[CQSTA]/);
  });
});

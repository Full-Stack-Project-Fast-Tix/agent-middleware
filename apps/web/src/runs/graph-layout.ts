import type { Task, TaskDependency } from "@launchpad/shared";

// Where each Task sits in the Run's graph. Pure, so it is tested without a DOM.
//
// `column` is dependency depth: a task sits one level after everything it
// waits for. `row` is its position among tasks at the same depth. TaskGraph
// draws depth top to bottom. Two kinds of edge are drawn:
//
//   dependency   B waits for A's result (TaskDependency)
//   delegation   the planning task created B, and B waits for nothing else,
//                so the plan is what it starts from
//
// Within a column, tasks keep their creation order.

export interface GraphNode {
  taskId: string;
  column: number;
  row: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "dependency" | "delegation";
}

export interface TaskGraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  columns: number;
  rows: number;
}

export function layoutTaskGraph(
  tasks: readonly Pick<Task, "id" | "parentTaskId">[],
  dependencies: readonly TaskDependency[],
): TaskGraphLayout {
  const known = new Set(tasks.map((task) => task.id));
  const edges: GraphEdge[] = [];
  const incoming = new Map<string, string[]>();
  const addEdge = (edge: GraphEdge) => {
    edges.push(edge);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  };

  for (const edge of dependencies) {
    if (known.has(edge.taskId) && known.has(edge.dependsOnTaskId)) {
      addEdge({ from: edge.dependsOnTaskId, to: edge.taskId, kind: "dependency" });
    }
  }
  for (const task of tasks) {
    if (task.parentTaskId !== null && known.has(task.parentTaskId) && !incoming.has(task.id)) {
      addEdge({ from: task.parentTaskId, to: task.id, kind: "delegation" });
    }
  }

  // Longest path from a root. The orchestrator only creates DAGs; `visiting`
  // keeps a malformed one from recursing forever.
  const columnOf = new Map<string, number>();
  const visiting = new Set<string>();
  const column = (id: string): number => {
    const cached = columnOf.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const sources = incoming.get(id) ?? [];
    const value = sources.length === 0 ? 0 : 1 + Math.max(...sources.map(column));
    visiting.delete(id);
    columnOf.set(id, value);
    return value;
  };

  const rowsUsed = new Map<number, number>();
  const nodes = tasks.map((task) => {
    const at = column(task.id);
    const row = rowsUsed.get(at) ?? 0;
    rowsUsed.set(at, row + 1);
    return { taskId: task.id, column: at, row };
  });

  return {
    nodes,
    edges,
    columns: nodes.length === 0 ? 0 : Math.max(...nodes.map((node) => node.column)) + 1,
    rows: Math.max(0, ...rowsUsed.values()),
  };
}

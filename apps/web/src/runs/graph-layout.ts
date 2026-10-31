import type { Task, TaskDependency } from "@launchpad/shared";

// Where each Task sits in the Run's graph. Pure, so it is tested without a DOM.
//
// `column` is dependency depth: a task sits one level after everything it
// waits for. `row` is its position among tasks at the same depth. TaskGraph
// draws depth left to right, or top to bottom where the page is narrow. Two
// kinds of edge are drawn:
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

export interface PlacedNode {
  taskId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedEdge {
  from: string;
  to: string;
  kind: GraphEdge["kind"];
  /** SVG path. Connectors are right angles only. */
  d: string;
}

export interface PlacedGraph {
  orientation: "across" | "down";
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

/** Narrower than this, depth runs down the page. */
export const GRAPH_ACROSS_MIN_WIDTH = 640;

const NODE_HEIGHT = 92;
const MIN_NODE_WIDTH = 216;
const MAX_NODE_WIDTH = 340;
const DEPTH_GAP_ACROSS = 40;
const DEPTH_GAP_DOWN = 28;
const SIBLING_GAP = 16;
/** Room beside the last row or column for a connector that skips a level. */
const LANE = 16;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * Where each node and connector goes for the width available. A connector that
 * skips a level runs in the gap beside the nodes it passes, never through them.
 * The result can be wider than `available`; the page scrolls it in its own frame.
 */
export function placeTaskGraph(layout: TaskGraphLayout, available: number): PlacedGraph {
  const orientation = available >= GRAPH_ACROSS_MIN_WIDTH ? "across" : "down";
  const nodeOf = new Map(layout.nodes.map((node) => [node.taskId, node]));
  const skips = layout.edges.some((edge) => nodeOf.get(edge.to)!.column - nodeOf.get(edge.from)!.column > 1);
  const lane = skips ? LANE : 0;

  if (orientation === "across") {
    const columns = Math.max(1, layout.columns);
    const fit = (available - DEPTH_GAP_ACROSS * (columns - 1)) / columns;
    const width = Math.floor(clamp(fit, MIN_NODE_WIDTH, MAX_NODE_WIDTH));
    const x = (column: number) => column * (width + DEPTH_GAP_ACROSS);
    const y = (row: number) => row * (NODE_HEIGHT + SIBLING_GAP);
    return {
      orientation,
      width: x(columns - 1) + width,
      height: y(Math.max(1, layout.rows) - 1) + NODE_HEIGHT + lane,
      nodes: layout.nodes.map((node) => ({ taskId: node.taskId, x: x(node.column), y: y(node.row), width, height: NODE_HEIGHT })),
      edges: layout.edges.map((edge) => {
        const from = nodeOf.get(edge.from)!;
        const to = nodeOf.get(edge.to)!;
        const x1 = x(from.column) + width;
        const y1 = y(from.row) + NODE_HEIGHT / 2;
        const x2 = x(to.column);
        const y2 = y(to.row) + NODE_HEIGHT / 2;
        const d = to.column - from.column > 1
          ? `M ${x1} ${y1} H ${x1 + DEPTH_GAP_ACROSS / 2} V ${y(from.row) + NODE_HEIGHT + SIBLING_GAP / 2} H ${x2 - DEPTH_GAP_ACROSS / 2} V ${y2} H ${x2}`
          : `M ${x1} ${y1} H ${(x1 + x2) / 2} V ${y2} H ${x2}`;
        return { ...edge, d };
      }),
    };
  }

  const rows = Math.max(1, layout.rows);
  const width = rows === 1 ? Math.max(MIN_NODE_WIDTH, Math.floor(available) - lane) : MIN_NODE_WIDTH;
  const x = (row: number) => row * (width + SIBLING_GAP);
  const y = (column: number) => column * (NODE_HEIGHT + DEPTH_GAP_DOWN);
  return {
    orientation,
    width: x(rows - 1) + width + lane,
    height: y(Math.max(1, layout.columns) - 1) + NODE_HEIGHT,
    nodes: layout.nodes.map((node) => ({ taskId: node.taskId, x: x(node.row), y: y(node.column), width, height: NODE_HEIGHT })),
    edges: layout.edges.map((edge) => {
      const from = nodeOf.get(edge.from)!;
      const to = nodeOf.get(edge.to)!;
      const x1 = x(from.row) + width / 2;
      const y1 = y(from.column) + NODE_HEIGHT;
      const x2 = x(to.row) + width / 2;
      const y2 = y(to.column);
      const d = to.column - from.column > 1
        ? `M ${x1} ${y1} V ${y1 + DEPTH_GAP_DOWN / 2} H ${x(from.row) + width + SIBLING_GAP / 2} V ${y2 - DEPTH_GAP_DOWN / 2} H ${x2} V ${y2}`
        : `M ${x1} ${y1} V ${(y1 + y2) / 2} H ${x2} V ${y2}`;
      return { ...edge, d };
    }),
  };
}

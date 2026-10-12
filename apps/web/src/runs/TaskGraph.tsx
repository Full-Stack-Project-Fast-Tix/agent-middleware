import { highestSeverity, type Agent } from "@launchpad/shared";
import { agentName, SeverityBadge, StatusBadge } from "./format";
import { layoutTaskGraph } from "./graph-layout";
import { executionsOf, findingsOf, type RunView } from "./run-view";

// Drawn top to bottom: a layout column (dependency depth) is a band down the
// page, and tasks that can run side by side sit side by side. Plans grow in
// depth far more than in width, so this fits beside the drill-down panel.
const NODE_WIDTH = 232;
const NODE_HEIGHT = 96;
const ACROSS_GAP = 20;
const DOWN_GAP = 40;
const PAD = 16;

const left = (row: number) => PAD + row * (NODE_WIDTH + ACROSS_GAP);
const top = (depth: number) => PAD + depth * (NODE_HEIGHT + DOWN_GAP);

/**
 * The Run's tasks as a graph. Each node is a Task with its assigned Agent
 * inside it (plan section 3.5): an execution attempt is a detail of the task,
 * shown in the drill-down, not a node of its own.
 */
export function TaskGraph({
  view,
  agents,
  selectedTaskId,
  onSelect,
}: {
  view: RunView;
  agents: ReadonlyMap<string, Agent>;
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}) {
  const layout = layoutTaskGraph(view.tasks, view.dependencies);
  if (layout.nodes.length === 0) {
    return <div className="task-graph-empty">{view.run.status === "queued" ? "Waiting to start…" : "No tasks yet."}</div>;
  }
  const at = new Map(layout.nodes.map((node) => [node.taskId, node]));
  const width = left(layout.rows) - ACROSS_GAP + PAD;
  const height = top(layout.columns) - DOWN_GAP + PAD;

  return (
    <>
    {layout.edges.length > 0 && (
      <div className="run-graph-legend">
        <span><i className="legend-dependency" /> waits for</span>
        <span><i className="legend-delegation" /> delegated by the plan</span>
      </div>
    )}
    <div className="task-graph-scroll">
      <div className="task-graph" style={{ width, height }}>
        <svg className="task-graph-edges" width={width} height={height} aria-hidden="true">
          {layout.edges.map((edge) => {
            const from = at.get(edge.from)!;
            const to = at.get(edge.to)!;
            // Bottom-centre of the task waited for, to top-centre of the waiting one.
            const x1 = left(from.row) + NODE_WIDTH / 2;
            const y1 = top(from.column) + NODE_HEIGHT;
            const x2 = left(to.row) + NODE_WIDTH / 2;
            const y2 = top(to.column);
            const bend = (y2 - y1) / 2;
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                className={"task-edge task-edge-" + edge.kind}
                d={`M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`}
              />
            );
          })}
        </svg>
        {view.tasks.map((task) => {
          const node = at.get(task.id)!;
          const attempts = executionsOf(view, task.id).length;
          const findings = findingsOf(view, task.id);
          const acted = findings.filter((finding) => finding.intervened).length;
          return (
            <button
              key={task.id}
              className={"task-node task-node-" + task.status + (task.id === selectedTaskId ? " selected" : "")}
              style={{ left: left(node.row), top: top(node.column), width: NODE_WIDTH, height: NODE_HEIGHT }}
              onClick={() => onSelect(task.id)}
              aria-pressed={task.id === selectedTaskId}
              aria-label={`${task.title}, ${task.status.replace("_", " ")}, assigned to ${agentName(agents, task.assignedAgentId)}`}
            >
              <span className="task-node-title">{task.title}</span>
              <span className="task-node-agent">{agentName(agents, task.assignedAgentId)}</span>
              <span className="task-node-meta">
                {/* "Waiting approval" is the status itself; no separate flag. */}
                <StatusBadge status={task.status} />
                {attempts > 1 && <span className="task-node-flag">{attempts} attempts</span>}
                {findings.length > 0 && (
                  <span className="task-node-findings" title={`${findings.length} findings, ${acted} acted on`}>
                    <SeverityBadge severity={highestSeverity(findings.map((finding) => finding.severity))} />
                    {findings.length}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
    </>
  );
}

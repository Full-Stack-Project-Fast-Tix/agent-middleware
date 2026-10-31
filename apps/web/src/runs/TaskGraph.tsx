import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { highestSeverity, type Agent } from "@launchpad/shared";
import { agentName, humanize, SeverityBadge, StatusBadge } from "./format";
import { layoutTaskGraph, placeTaskGraph } from "./graph-layout";
import { executionsOf, findingsOf, isRunActive, isWrittenByPlan, type RunView } from "./run-view";

/** The frame's width, which decides which way the graph runs. */
function useFrameWidth() {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = frame.current;
    if (element === null) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { frame, width };
}

/**
 * The Run's tasks as a graph, left to right by dependency depth. Each node is a
 * Task with its assigned Agent inside it (plan section 3.5): an execution attempt
 * is a detail of the task, shown in the drill-down, not a node of its own.
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
  const { frame, width } = useFrameWidth();
  const layout = useMemo(() => layoutTaskGraph(view.tasks, view.dependencies), [view.dependencies, view.tasks]);
  const placed = useMemo(() => (width === null ? null : placeTaskGraph(layout, width)), [layout, width]);
  const at = new Map(placed?.nodes.map((node) => [node.taskId, node]));
  const kinds = new Set(layout.edges.map((edge) => edge.kind));
  const live = isRunActive(view.run.status);
  const selected = selectedTaskId === null ? undefined : at.get(selectedTaskId);
  const selectedLeft = selected?.x;
  const selectedRight = selected === undefined ? undefined : selected.x + selected.width;

  // A long plan scrolls in its frame. Keep the selected task in view there.
  useLayoutEffect(() => {
    const element = frame.current;
    if (element === null || selectedLeft === undefined || selectedRight === undefined) return;
    if (selectedLeft < element.scrollLeft) element.scrollLeft = selectedLeft;
    else if (selectedRight > element.scrollLeft + element.clientWidth) element.scrollLeft = selectedRight - element.clientWidth;
  }, [frame, selectedLeft, selectedRight]);

  return (
    <section className="page-section" aria-labelledby="task-graph-heading">
      <div className="section-head">
        <h2 id="task-graph-heading">Tasks</h2>
        {(kinds.size > 1 || view.tasks.some(isWrittenByPlan)) && (
          <div className="task-graph-legend meta">
            {view.tasks.some(isWrittenByPlan) && <span>Task names are written by the plan</span>}
            {kinds.size > 1 && (
              <>
                <span><i className="legend-line" /> waits for</span>
                <span><i className="legend-line legend-line-delegation" /> started by the plan</span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="task-graph-frame" ref={frame}>
        {layout.nodes.length === 0 && (
          <p className="meta">{view.run.status === "queued" ? "Waiting to start." : "No tasks yet. Planning creates them."}</p>
        )}
        {placed !== null && layout.nodes.length > 0 && (
          <div className="task-graph" style={{ width: placed.width, height: placed.height }}>
            <svg className="task-graph-edges" width={placed.width} height={placed.height} aria-hidden="true">
              {placed.edges.map((edge) => (
                <path key={`${edge.from}-${edge.to}`} className={"task-edge task-edge-" + edge.kind} d={edge.d} />
              ))}
            </svg>
            {view.tasks.map((task) => {
              const node = at.get(task.id)!;
              const attempts = executionsOf(view, task.id).length;
              const findings = findingsOf(view, task.id);
              const acted = findings.filter((finding) => finding.intervened).length;
              return (
                <button
                  key={task.id}
                  type="button"
                  className={"task-node task-node-" + task.status + (task.id === selectedTaskId ? " selected" : "")}
                  style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                  onClick={() => onSelect(task.id)}
                  aria-pressed={task.id === selectedTaskId}
                  aria-label={`${task.title}, ${humanize(task.status)}, assigned to ${agentName(agents, task.assignedAgentId)}`}
                >
                  <span className="task-node-title">{task.title}</span>
                  <span className="task-node-agent">{agentName(agents, task.assignedAgentId)}</span>
                  <span className="task-node-meta">
                    <StatusBadge status={task.status} live={live} />
                    {attempts > 1 && <span className="meta">{attempts} attempts</span>}
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
        )}
      </div>
    </section>
  );
}

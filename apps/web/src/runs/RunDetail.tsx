import { useEffect, useMemo, useState } from "react";
import type { Agent, Approval } from "@launchpad/shared";
import { MessageContent } from "../MessageContent";
import { formatClock, StatusBadge } from "./format";
import { NEW_RUN_HASH } from "./routes";
import { runsApi } from "./runs-api";
import { focusTaskId, isRunActive, pendingApprovals } from "./run-view";
import { TaskDrilldown } from "./TaskDrilldown";
import { TaskGraph } from "./TaskGraph";
import { useRun } from "./useRun";

/**
 * One Run, live: its task graph, the selected task's drill-down, pending
 * approvals and the final result. P4 composes the full Run Detail page
 * (timeline, changed files) around these pieces.
 */
export function RunDetail({ runId }: { runId: string }) {
  const { view, error: loadError } = useRun(runId);
  const [agents, setAgents] = useState<ReadonlyMap<string, Agent>>(new Map());
  const [picked, setPicked] = useState<string | null>(null);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const workspaceId = view?.run.workspaceId ?? null;

  useEffect(() => {
    setPicked(null);
  }, [runId]);

  useEffect(() => {
    if (workspaceId === null) return;
    runsApi
      .agents(workspaceId)
      .then((list) => setAgents(new Map(list.map((agent) => [agent.id, agent]))))
      .catch(() => setAgents(new Map()));
  }, [workspaceId]);

  const selectedTask = useMemo(() => {
    if (view === null) return null;
    const id = picked ?? focusTaskId(view);
    return view.tasks.find((task) => task.id === id) ?? null;
  }, [picked, view]);

  if (loadError !== null) {
    return (
      <div className="runs-page">
        <div className="error-banner" role="alert"><span>{loadError}</span></div>
        <a className="button button-ghost" href={NEW_RUN_HASH}>Start a new run</a>
      </div>
    );
  }
  if (view === null) return <div className="runs-page"><span className="spinner" aria-label="Loading run" /></div>;

  const { run } = view;
  const active = isRunActive(run.status);
  const waiting = pendingApprovals(view);

  const resolve = async (approval: Approval, decision: "approve" | "deny") => {
    setResolvingApprovalId(approval.id);
    setActionError(null);
    try {
      await runsApi.resolveApproval(approval.id, decision);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setResolvingApprovalId(null);
    }
  };

  const cancel = async () => {
    if (!window.confirm("Cancel this run? Running work is stopped and pending approvals are cancelled.")) return;
    setActionError(null);
    try {
      await runsApi.cancel(run.id);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="runs-page run-detail">
      <header className="runs-header">
        <div>
          <span className="eyebrow">
            Run · {run.orchestrationMode === "auto" ? "planned and delegated" : "one agent"} · started {formatClock(run.startedAt ?? run.createdAt)}
          </span>
          <h1 className="run-prompt">{run.userPrompt}</h1>
          <div className="run-header-meta">
            <StatusBadge status={run.status} />
            {run.cancelRequestedAt !== null && active && <span className="task-node-flag">Cancelling…</span>}
            <span>{view.tasks.length} tasks · {view.findings.length} findings</span>
          </div>
        </div>
        <div className="header-actions">
          <a className="button button-ghost" href={NEW_RUN_HASH}>New run</a>
          {active && (
            <button className="button button-danger" onClick={() => void cancel()} disabled={run.cancelRequestedAt !== null}>
              Cancel run
            </button>
          )}
        </div>
      </header>

      {actionError && (
        <div className="error-banner" role="alert">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {waiting.length > 0 && (
        <div className="approval-banner" role="status">
          <strong>{waiting.length === 1 ? "An action is waiting for your approval." : `${waiting.length} actions are waiting for your approval.`}</strong>
          {waiting.map((approval) => (
            <button key={approval.id} className="button button-ghost" onClick={() => setPicked(approval.taskId)}>
              Review: {approval.summary}
            </button>
          ))}
        </div>
      )}

      <section className="run-body">
        <div className="run-graph-panel">
          <div className="run-graph-legend">
            <span><i className="legend-dependency" /> waits for</span>
            <span><i className="legend-delegation" /> delegated by the plan</span>
          </div>
          <TaskGraph view={view} agents={agents} selectedTaskId={selectedTask?.id ?? null} onSelect={setPicked} />

          {run.status === "completed" && run.finalOutput !== null && (
            <article className="run-outcome">
              <span className="eyebrow">Result</span>
              <MessageContent content={run.finalOutput} rich />
            </article>
          )}
          {(run.status === "failed" || run.status === "cancelled") && (
            <article className="run-outcome run-outcome-failed">
              <span className="eyebrow">{run.status === "failed" ? "Run failed" : "Run cancelled"}</span>
              <p>{run.error ?? "The run was cancelled before it finished."}</p>
            </article>
          )}
        </div>

        {selectedTask !== null && (
          <TaskDrilldown
            view={view}
            task={selectedTask}
            agents={agents}
            resolvingApprovalId={resolvingApprovalId}
            onResolveApproval={(approval, decision) => void resolve(approval, decision)}
          />
        )}
      </section>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { mayAnswerApproval, type Agent, type Approval, type SecurityFinding } from "@launchpad/shared";
import { MessageContent } from "../MessageContent";
import { paths } from "../router";
import { Button, ButtonLink, DecisionGlyph, ErrorState, Foreign, Loading, StatusBadge } from "../ui";
import { agentName, formatClock } from "./format";
import { runsApi } from "./runs-api";
import { focusTaskId, isRunActive, isWrittenByPlan, pendingApprovals } from "./run-view";
import { GateTimeline, ProposedFiles } from "./RunTimeline";
import { RunFiles } from "./RunFiles";
import { ActualChanges } from "./ActualChanges";
import { ApprovalActions, ApprovalEvidenceView } from "./ApprovalEvidence";
import { approvalEvidence } from "./approval-evidence";
import { useLatest } from "./latest-request";
import { RunReceipt } from "./RunReceipt";
import { ContinueWorkspace } from "./ContinueWorkspace";
import { TaskDrilldown } from "./TaskDrilldown";
import { TaskGraph } from "./TaskGraph";
import { heldProposals, type Names } from "./timeline-view";
import { useRun } from "./useRun";
import { announceApprovalsChanged } from "./useRunList";
import { useRunTimeline } from "./useRunTimeline";
import { useCurrentWorkspace } from "../useCurrentWorkspace";

/** Longer than this, a prompt starts folded, so the page opens on the run rather than the request. */
const LONG_PROMPT = 240;

function semanticReviewCoverage(findings: SecurityFinding[]) {
  let intent = 0;
  let action = 0;
  let withoutIntent = 0;
  for (const finding of findings) {
    if (finding.check !== "semantic-intent") continue;
    const metadata = finding.evidence?.metadata;
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    const details = metadata as Record<string, unknown>;
    const checkpoint = details.checkpoint;
    if (checkpoint === "reasoning") intent += 1;
    if (checkpoint === "command" || checkpoint === "file_change") {
      action += 1;
      if (details.intentEvidence === "none") withoutIntent += 1;
    }
  }
  return { intent, action, withoutIntent };
}

/**
 * One Run, live: its task graph, the gate line, the files that reached the gate,
 * the selected task's drill-down and the agent's report. The server is the check
 * on every action here: a role that may not answer gets its refusal shown.
 */
export function RunDetail({ runId }: { runId: string }) {
  const { view, error: loadError } = useRun(runId);
  const { workspaces, viewerId } = useCurrentWorkspace();
  const [picked, setPicked] = useState<string | null>(null);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [taskDetailsOpen, setTaskDetailsOpen] = useState(false);
  // The view may still be the previous Run's for a moment after the route changes.
  const loaded = view !== null && view.run.id === runId;
  const workspaceId = loaded ? view.run.workspaceId : null;
  const active = view !== null && isRunActive(view.run.status);
  const timeline = useRunTimeline(runId, active, view?.lastEventSeq ?? 0);
  // Only once the Run has ended: the server refuses earlier, because the copy can still change.
  const diff = useLatest(loaded && !active ? runId : null, (id) => runsApi.diff(id));
  const agentList = useLatest(workspaceId, (id) => runsApi.agents(id));
  const agents = useMemo<ReadonlyMap<string, Agent>>(
    () => new Map(agentList.state.status === "ready" ? agentList.state.value.map((agent) => [agent.id, agent]) : []),
    [agentList.state],
  );

  useEffect(() => {
    setPicked(null);
    setTaskDetailsOpen(false);
  }, [runId]);

  // This page hears of a held action first; the top bar should not lag behind it.
  const heldHere = view === null ? 0 : pendingApprovals(view).length;
  useEffect(() => {
    announceApprovalsChanged();
  }, [heldHere]);

  const selectedTask = useMemo(() => {
    if (view === null) return null;
    const id = picked ?? focusTaskId(view);
    return view.tasks.find((task) => task.id === id) ?? null;
  }, [picked, view]);

  const names = useMemo<Names>(() => ({
    task: (taskId) => view?.tasks.find((task) => task.id === taskId)?.title ?? "another task",
    writtenByPlan: (taskId) => {
      const task = view?.tasks.find((candidate) => candidate.id === taskId);
      return task !== undefined && isWrittenByPlan(task);
    },
    agent: (agentId) => agentName(agents, agentId),
  }), [agents, view?.tasks]);

  const proposals = useMemo(
    () => heldProposals(timeline.timeline?.entries ?? [], names),
    [names, timeline.timeline?.entries],
  );

  if (view === null || !loaded) {
    return (
      <div className="page">
        {loadError !== null ? (
          <>
            <ErrorState title="This run did not load" message={loadError} />
            <div><ButtonLink to={paths.runs}>Go to runs</ButtonLink></div>
          </>
        ) : <Loading label="Loading run" />}
      </div>
    );
  }

  const { run } = view;
  const semanticCoverage = semanticReviewCoverage(view.findings);
  const waiting = pendingApprovals(view);
  // Only hides what the server would refuse. Until the role is known, it still offers the buttons.
  const role = workspaces?.find((workspace) => workspace.id === view.run.workspaceId)?.role;
  const mayAct = role !== "auditor";
  const canAnswer = (approval: Approval) =>
    role === undefined || viewerId === null ||
    mayAnswerApproval({ role, userId: viewerId, runCreatedByUserId: view.run.createdByUserId, reason: approval.reason });
  const promptIsLong = run.userPrompt.length > LONG_PROMPT;

  const resolve = async (approvalId: string, decision: "approve" | "deny") => {
    setResolvingApprovalId(approvalId);
    setActionError(null);
    try {
      await runsApi.resolveApproval(approvalId, decision);
      announceApprovalsChanged();
      void timeline.reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setResolvingApprovalId(null);
    }
  };

  const cancel = async () => {
    setConfirmingCancel(false);
    setActionError(null);
    try {
      await runsApi.cancel(run.id);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const review = (approval: Approval) => {
    setPicked(approval.taskId);
    setTaskDetailsOpen(true);
    // The drill-down sits below the timeline on narrow screens.
    window.requestAnimationFrame(() => {
      document.getElementById(`approval-${approval.id}`)?.scrollIntoView({ block: "nearest" });
    });
  };

  return (
    <div className="page run-detail">
      <header className="run-head">
        <div className="run-head-copy">
          <h1 className={"run-prompt" + (promptIsLong && !promptOpen ? " run-prompt-folded" : "")}>{run.userPrompt}</h1>
          {promptIsLong && (
            <button type="button" className="text-button" aria-expanded={promptOpen} onClick={() => setPromptOpen((open) => !open)}>
              {promptOpen ? "Fold the request" : "Show the whole request"}
            </button>
          )}
          <div className="cluster meta">
            <StatusBadge status={run.status} live={active} />
            {run.cancelRequestedAt !== null && active && <span>Cancelling</span>}
            <span>{run.orchestrationMode === "auto" ? "Planned and delegated" : "One agent"}</span>
            <span className="tabular">Started {formatClock(run.startedAt ?? run.createdAt)}</span>
            <span className="tabular">{view.tasks.length === 1 ? "1 task" : `${view.tasks.length} tasks`}</span>
            <span className="tabular">{view.findings.length === 1 ? "1 finding" : `${view.findings.length} findings`}</span>
          </div>
        </div>
        <div className="run-head-actions">
          {mayAct && active && !confirmingCancel && (
            <Button variant="danger" onClick={() => setConfirmingCancel(true)} disabled={run.cancelRequestedAt !== null}>
              Cancel run
            </Button>
          )}
          {mayAct && active && confirmingCancel && (
            <span className="cancel-confirm" role="group" aria-label="Confirm cancelling this run">
              <span>Stop running work and cancel what is held?</span>
              <Button onClick={() => setConfirmingCancel(false)}>Keep running</Button>
              <Button variant="danger" onClick={() => void cancel()}>Cancel run</Button>
            </span>
          )}
          {mayAct && <ButtonLink to={paths.newRun}>New run</ButtonLink>}
        </div>
      </header>

      {loadError !== null && <p className="notice notice-held" role="alert">Live updates stopped: {loadError} Reload the page to reconnect.</p>}
      {actionError !== null && (
        <ErrorState title="That did not go through" message={actionError} onRetry={() => setActionError(null)} retryLabel="Dismiss" />
      )}

      {waiting.length > 0 && (
        <section className="held-strip" aria-label="Held for approval" role="status">
          <div className="held-title">
            <span className="held-glyph"><DecisionGlyph decision="require_approval" size={15} /></span>
            {waiting.length === 1 ? "1 action is held for approval" : `${waiting.length} actions are held for approval`}
          </div>
          <ul>
            {waiting.map((approval) => {
              const proposal = proposals.get(approval.id);
              const evidence = approvalEvidence(approval);
              return (
                <li key={approval.id}>
                  <div className="held-what">
                    <ApprovalEvidenceView approval={approval} evidence={evidence} compact />
                    {evidence.missing !== null && proposal !== undefined && <Foreign label="From the gate timeline" preformatted maxHeight={68}>{proposal}</Foreign>}
                  </div>
                  <div className="held-actions">
                    {!canAnswer(approval) && (
                      <span className="held-owner">
                        {approval.reason === "policy_required" ? "A Security Admin answers this" : "The person who started this run answers this"}
                      </span>
                    )}
                    {canAnswer(approval) && (
                      <ApprovalActions
                        approval={approval}
                        evidence={evidence}
                        label={approval.summary}
                        busy={resolvingApprovalId === approval.id}
                        onAnswer={(decision) => void resolve(approval.id, decision)}
                      />
                    )}
                    <Button onClick={() => review(approval)}>Review</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!active && (
        <RunReceipt
          run={run}
          tasks={view.tasks}
          executions={view.executions}
          approvals={view.approvals}
          findings={view.findings}
          diff={diff.state}
          actionReviews={semanticCoverage}
        />
      )}

      <div id="run-tasks">
        <TaskGraph
          view={view}
          agents={agents}
          selectedTaskId={selectedTask?.id ?? null}
          onSelect={(taskId) => {
            setPicked(taskId);
            setTaskDetailsOpen(true);
          }}
          detailsOpen={taskDetailsOpen}
          onToggleDetails={() => {
            if (!taskDetailsOpen && picked === null && selectedTask !== null) setPicked(selectedTask.id);
            setTaskDetailsOpen((open) => !open);
          }}
        />
      </div>

      <div className={"run-body" + (!taskDetailsOpen ? " run-body-details-closed" : "")}>
        <div className="run-main">
          {run.finalOutput !== null && run.status === "completed" && (
            <section className="page-section" aria-label="Agent's report">
              <Foreign label="Agent's report" note="Written by the agent, not checked by AgentGuard">
                <MessageContent content={run.finalOutput} rich />
              </Foreign>
            </section>
          )}
          {run.status === "failed" && (
            <ErrorState title="The run failed" message={run.error ?? "The run stopped without saying why. Check the failed task's attempts."} />
          )}
          {run.status === "cancelled" && (
            <section className="page-section">
              <h2>The run was cancelled</h2>
              <p className="meta">{run.error ?? "It was cancelled before it finished."}</p>
            </section>
          )}
          <div id="run-timeline"><GateTimeline
            timeline={timeline.timeline}
            error={timeline.error}
            onRetry={() => void timeline.reload()}
            fresh={timeline.fresh}
            active={active}
            names={names}
            selectedTaskId={selectedTask?.id ?? null}
            onSelectTask={(taskId) => {
              setPicked(taskId);
              setTaskDetailsOpen(true);
              // The drill-down sits below the timeline on narrow screens.
              window.requestAnimationFrame(() => {
                document.querySelector(".task-drilldown")?.scrollIntoView({ block: "nearest" });
              });
            }}
            resolvingApprovalId={resolvingApprovalId}
            canAnswer={(approvalId) => {
              const approval = view.approvals.find((candidate) => candidate.id === approvalId);
              return approval !== undefined && canAnswer(approval);
            }}
            canApprove={(approvalId) => {
              const approval = view.approvals.find((candidate) => candidate.id === approvalId);
              return approval !== undefined && approvalEvidence(approval).canApprove;
            }}
            onResolve={(approvalId, decision) => void resolve(approvalId, decision)}
          /></div>
          {timeline.timeline !== null && <ProposedFiles timeline={timeline.timeline} runEnded={!active} />}
          {!active && <ActualChanges diff={diff.state} onRetry={diff.reload} />}
          {mayAct && <RunFiles runId={runId} runEnded={!active} />}
        </div>

        {selectedTask !== null && (
          <TaskDrilldown
            hidden={!taskDetailsOpen}
            view={view}
            task={selectedTask}
            agents={agents}
            resolvingApprovalId={resolvingApprovalId}
            canAnswer={canAnswer}
            onResolveApproval={(approval, decision) => void resolve(approval.id, decision)}
          />
        )}
      </div>
      {!active && mayAct && workspaceId !== null && (
        <ContinueWorkspace
          key={run.id}
          workspaceId={workspaceId}
          mode={run.orchestrationMode}
          previousAgentId={run.orchestrationMode === "auto" ? run.supervisorAgentId : view.tasks[0]?.assignedAgentId ?? null}
          currentRun={{ id: run.id, status: run.status }}
        />
      )}
    </div>
  );
}

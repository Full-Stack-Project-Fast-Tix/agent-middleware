import { useState } from "react";
import type { Agent, Approval, Task } from "@launchpad/shared";
import { MessageContent } from "../MessageContent";
import { approvalBadgeStatus, Button, Foreign } from "../ui";
import { agentName, formatClock, formatDuration, humanize, SeverityBadge, StatusBadge } from "./format";
import { runsApi } from "./runs-api";
import { approvalsOf, executionsOf, findingsOf, isRunActive, type RunView } from "./run-view";

const CAPABILITIES = ["write", "shell", "network", "delegate"] as const;

/** Fetched rather than linked: an anchor could not send the Authorization header. */
function TraceDownload({ runId, executionId, truncated }: { runId: string; executionId: string; truncated: boolean }) {
  const [note, setNote] = useState<string | null>(null);

  const download = async () => {
    setNote(null);
    try {
      const { text, redactions } = await runsApi.trace(runId, executionId);
      const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `trace-${executionId}.jsonl`;
      link.click();
      URL.revokeObjectURL(url);
      // A log that was altered has to say so.
      if (redactions > 0) setNote(`${redactions} ${redactions === 1 ? "value" : "values"} redacted`);
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <>
      <Button variant="ghost" onClick={() => void download()}>Download trace</Button>
      {truncated ? " (truncated)" : ""}
      {note !== null && <span role="status"> {note}</span>}
    </>
  );
}

/** Everything about one Task: what it was asked, what it produced, every attempt, and what security did. */
export function TaskDrilldown({
  view,
  task,
  agents,
  resolvingApprovalId,
  onResolveApproval,
}: {
  view: RunView;
  task: Task;
  agents: ReadonlyMap<string, Agent>;
  resolvingApprovalId: string | null;
  onResolveApproval: (approval: Approval, decision: "approve" | "deny") => void;
}) {
  const executions = executionsOf(view, task.id);
  const findings = findingsOf(view, task.id);
  const approvals = approvalsOf(view, task.id);
  const live = isRunActive(view.run.status);
  const delegatedBy = task.parentTaskId === null ? null : view.tasks.find((candidate) => candidate.id === task.parentTaskId);
  const waitsFor = view.dependencies
    .filter((edge) => edge.taskId === task.id)
    .map((edge) => view.tasks.find((candidate) => candidate.id === edge.dependsOnTaskId)?.title ?? "an earlier task");

  return (
    <aside className="task-drilldown" aria-label={`Task: ${task.title}`} tabIndex={0}>
      <header>
        <h2>{task.title}</h2>
        <div className="cluster meta">
          <StatusBadge status={task.status} live={live} />
          <span>{agentName(agents, task.assignedAgentId)}</span>
          <span className="tabular">{formatDuration(task.startedAt, task.completedAt)}</span>
        </div>
      </header>

      {approvals.length > 0 && (
        <section>
          <h3>Approvals</h3>
          <div className="approval-list">
            {approvals.map((approval) => (
              <div key={approval.id} id={`approval-${approval.id}`} className={"approval-card approval-" + approval.status}>
                <div className="approval-card-head">
                  <strong>{approval.summary}</strong>
                  <StatusBadge status={approvalBadgeStatus(approval.status)} />
                </div>
                <div className="cluster meta">
                  <span>{humanize(approval.actionType)}</span>
                  <span>{humanize(approval.reason)}</span>
                  <span className="tabular">Requested {formatClock(approval.requestedAt)}</span>
                </div>
                {approval.safeDetails !== null && (
                  <Foreign label="What the agent proposed" preformatted maxHeight={200}>
                    {JSON.stringify(approval.safeDetails, null, 2)}
                  </Foreign>
                )}
                {approval.status === "pending" && (
                  <div className="cluster">
                    <Button
                      variant="primary"
                      busy={resolvingApprovalId === approval.id}
                      onClick={() => onResolveApproval(approval, "approve")}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="danger"
                      disabled={resolvingApprovalId === approval.id}
                      onClick={() => onResolveApproval(approval, "deny")}
                    >
                      Deny
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        {/* A delegated task's objective was written by the planning agent. */}
        {task.parentTaskId === null ? (
          <>
            <h3>Objective</h3>
            <p className="task-objective">{task.objective}</p>
          </>
        ) : (
          <Foreign label="Objective" note="Written by the plan">{task.objective}</Foreign>
        )}
        {(delegatedBy || waitsFor.length > 0) && (
          <p className="task-lineage meta">
            {delegatedBy && <>Started by {delegatedBy.title}. </>}
            {waitsFor.length > 0 && <>Waits for {waitsFor.join(", ")}.</>}
          </p>
        )}
      </section>

      {task.error !== null && (
        <section>
          <h3>Error</h3>
          <p className="task-error">{task.error}</p>
        </section>
      )}
      {task.error === null && task.result !== null && (
        <section>
          <Foreign label="Agent's report" note="Not verified by AgentGuard" maxHeight={320}>
            <MessageContent content={task.result} rich />
          </Foreign>
        </section>
      )}

      <section>
        <h3>Security findings</h3>
        {findings.length === 0 ? (
          <p className="meta">None for this task.</p>
        ) : (
          <ul className="finding-list">
            {findings.map((finding) => (
              <li key={finding.id}>
                <div className="cluster">
                  <SeverityBadge severity={finding.severity} />
                  <span className="meta">{humanize(finding.layer)}, {finding.code}</span>
                  <span className={finding.intervened ? "finding-acted" : "finding-warned"}>
                    {finding.intervened ? "Acted on" : "Warning"}
                  </span>
                </div>
                <p>{finding.message}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Attempts</h3>
        {executions.length === 0 ? (
          <p className="meta">Not started yet.</p>
        ) : (
          <ol className="execution-list">
            {executions.map((execution) => (
              <li key={execution.id}>
                <div className="cluster">
                  <strong>Attempt {execution.attempt}</strong>
                  <StatusBadge status={execution.status} live={live} />
                  <span className="meta tabular">{formatDuration(execution.startedAt, execution.completedAt)}</span>
                </div>
                {execution.error !== null && <p className="task-error">{execution.error}</p>}
                <dl className="execution-facts">
                  <dt>Allowed</dt>
                  <dd>{CAPABILITIES.filter((capability) => execution.capabilities[capability]).join(", ") || "Nothing"}</dd>
                  <dt>Not allowed</dt>
                  <dd>{CAPABILITIES.filter((capability) => !execution.capabilities[capability]).join(", ") || "Nothing"}</dd>
                  {execution.usage !== null && (
                    <>
                      <dt>Tokens</dt>
                      <dd className="tabular">{execution.usage.inputTokens ?? 0} in, {execution.usage.outputTokens ?? 0} out</dd>
                    </>
                  )}
                  {execution.tracePath !== null && (
                    <>
                      <dt>Trace</dt>
                      <dd><TraceDownload runId={view.run.id} executionId={execution.id} truncated={execution.traceTruncated} /></dd>
                    </>
                  )}
                </dl>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

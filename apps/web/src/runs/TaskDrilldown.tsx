import type { Agent, Approval, Task } from "@launchpad/shared";
import { MessageContent } from "../MessageContent";
import { agentName, formatClock, formatDuration, SeverityBadge, StatusBadge } from "./format";
import { approvalsOf, executionsOf, findingsOf, type RunView } from "./run-view";

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
  const delegatedBy = task.parentTaskId === null ? null : view.tasks.find((candidate) => candidate.id === task.parentTaskId);
  const waitsFor = view.dependencies
    .filter((edge) => edge.taskId === task.id)
    .map((edge) => view.tasks.find((candidate) => candidate.id === edge.dependsOnTaskId)?.title ?? "an earlier task");

  return (
    <aside className="task-drilldown" aria-label={`Task: ${task.title}`}>
      <header>
        <span className="eyebrow">Task</span>
        <h2>{task.title}</h2>
        <div className="task-drilldown-meta">
          <StatusBadge status={task.status} />
          <span>{agentName(agents, task.assignedAgentId)}</span>
          <span>{formatDuration(task.startedAt, task.completedAt)}</span>
        </div>
      </header>

      <section>
        <h3>Objective</h3>
        <p className="task-objective">{task.objective}</p>
        {(delegatedBy || waitsFor.length > 0) && (
          <p className="task-lineage">
            {delegatedBy && <>Delegated by <strong>{delegatedBy.title}</strong>. </>}
            {waitsFor.length > 0 && <>Waits for {waitsFor.map((title) => `“${title}”`).join(", ")}.</>}
          </p>
        )}
      </section>

      {approvals.length > 0 && (
        <section>
          <h3>Approvals</h3>
          {approvals.map((approval) => (
            <div key={approval.id} className={"approval-card approval-" + approval.status}>
              <div className="approval-card-head">
                <strong>{approval.summary}</strong>
                <StatusBadge status={approval.status} />
              </div>
              <span className="approval-card-sub">
                {approval.actionType.replace("_", " ")} · {approval.reason.replace("_", " ")} · requested {formatClock(approval.requestedAt)}
              </span>
              {approval.safeDetails !== null && (
                <pre className="approval-details">{JSON.stringify(approval.safeDetails, null, 2)}</pre>
              )}
              {approval.status === "pending" && (
                <div className="approval-actions">
                  <button
                    className="button button-ghost"
                    disabled={resolvingApprovalId === approval.id}
                    onClick={() => onResolveApproval(approval, "deny")}
                  >
                    Deny
                  </button>
                  <button
                    className="button button-primary"
                    disabled={resolvingApprovalId === approval.id}
                    onClick={() => onResolveApproval(approval, "approve")}
                  >
                    Approve once
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {(task.result !== null || task.error !== null) && (
        <section>
          <h3>{task.error !== null ? "Error" : "Result"}</h3>
          {task.error !== null ? (
            <p className="task-error">{task.error}</p>
          ) : (
            <div className="task-result">
              <MessageContent content={task.result ?? ""} rich />
            </div>
          )}
        </section>
      )}

      <section>
        <h3>Security findings</h3>
        {findings.length === 0 ? (
          <p className="muted-copy">None for this task.</p>
        ) : (
          <ul className="finding-list">
            {findings.map((finding) => (
              <li key={finding.id}>
                <div>
                  <SeverityBadge severity={finding.severity} />
                  <code>{finding.layer} · {finding.code}</code>
                  <span className={finding.intervened ? "finding-acted" : "finding-warned"}>
                    {finding.intervened ? "acted on" : "warning"}
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
          <p className="muted-copy">Not started yet.</p>
        ) : (
          <ol className="execution-list">
            {executions.map((execution) => (
              <li key={execution.id}>
                <div className="execution-head">
                  <strong>Attempt {execution.attempt}</strong>
                  <StatusBadge status={execution.status} />
                  <span>{formatDuration(execution.startedAt, execution.completedAt)}</span>
                </div>
                <div className="capability-chips" aria-label="Capabilities this attempt ran with">
                  {(["write", "shell", "network", "delegate"] as const).map((capability) => (
                    <span key={capability} className={execution.capabilities[capability] ? "chip-on" : "chip-off"}>
                      {execution.capabilities[capability] ? "" : "no "}{capability}
                    </span>
                  ))}
                </div>
                {execution.error !== null && <p className="task-error">{execution.error}</p>}
                <dl className="execution-facts">
                  {execution.usage !== null && (
                    <>
                      <dt>Tokens</dt>
                      <dd>{execution.usage.inputTokens ?? 0} in · {execution.usage.outputTokens ?? 0} out</dd>
                    </>
                  )}
                  {execution.tracePath !== null && (
                    <>
                      <dt>Trace</dt>
                      <dd><code>{execution.tracePath}</code>{execution.traceTruncated ? " (truncated)" : ""}</dd>
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

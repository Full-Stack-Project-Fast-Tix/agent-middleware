import type { AgentExecution, Approval, Run, RunDiffResponse, SecurityFinding, Task } from "@launchpad/shared";
import { Foreign, ForeignInline } from "../ui";
import type { Loadable } from "./latest-request";
import { changesSummary, endedBecause, executionTokens, reviewSummary } from "./run-receipt";

/**
 * The ended Run in one place: how it ended, what changed, whether the final
 * review ran and what it covered, with links to the evidence. Plain facts from
 * the server; the review's rationale is model-written and labelled as such.
 */
export function RunReceipt({ run, tasks, executions, approvals, findings, diff, actionReviews }: {
  run: Run;
  tasks: readonly Task[];
  executions: readonly AgentExecution[];
  approvals: readonly Approval[];
  findings: readonly SecurityFinding[];
  diff: Loadable<RunDiffResponse>;
  /** Semantic reviews before actions ran, counted from their findings. */
  actionReviews?: { intent: number; action: number; withoutIntent: number };
}) {
  const review = run.finalReview;
  const summary = reviewSummary(review);
  const reviewFinding = review?.findingId == null ? undefined : findings.find((finding) => finding.id === review.findingId);
  const tokens = executionTokens(executions);
  const monitor = review?.monitorUsage ?? null;
  const elapsed = run.startedAt && run.completedAt
    ? `${Math.max(0, Math.round((Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000))}s elapsed`
    : "Duration unavailable";
  return (
    <section className="page-section run-receipt" aria-labelledby="run-receipt-title">
      <h2 id="run-receipt-title">Run outcome</h2>
      <p>{endedBecause(run)}</p>
      <div className={`final-review final-review-${summary.tone}`} id="final-review">
        <p className="final-review-headline">{summary.headline}</p>
        {summary.detail !== null && <p className="meta">{summary.detail}</p>}
        {review !== null && review.conflictingPaths.length > 0 && (
          <p className="meta">
            Changes it flagged: {review.conflictingPaths.map((path, index) => (
              <span key={path}>{index > 0 && ", "}<ForeignInline>{path}</ForeignInline></span>
            ))}. <a href="#run-changes">See the actual changes</a>.
          </p>
        )}
        {review?.rationale != null && review.status !== "not_run" && review.status !== "disabled" && (
          <Foreign label="Reviewer's explanation" note="Written by a model; not verified">{review.rationale}</Foreign>
        )}
        {reviewFinding !== undefined && <p className="meta">Recorded as finding {reviewFinding.code}, severity {reviewFinding.severity}.</p>}
      </div>
      <div className="cluster meta">
        <span>{changesSummary(diff)}</span>
        {review !== null && (
          <span>{review.coverage.actions === 1 ? "1 gated action" : `${review.coverage.actions} gated actions`} given to the review{review.coverage.actionLedgerComplete ? "" : ", record incomplete"}</span>
        )}
        <span>{tasks.length === 1 ? "1 task" : `${tasks.length} tasks`}</span>
        <span>{executions.length === 1 ? "1 execution" : `${executions.length} executions`}</span>
        <span>{approvals.length === 1 ? "1 approval" : `${approvals.length} approvals`}</span>
        <span>{findings.length === 1 ? "1 finding" : `${findings.length} findings`}</span>
        {actionReviews !== undefined && (actionReviews.intent > 0 || actionReviews.action > 0) && (
          <span title="Reviews of exposed thinking summaries or visible plans, and reviews of proposed commands or file changes">
            Semantic: {actionReviews.intent} intent, {actionReviews.action} action reviews
            {actionReviews.withoutIntent > 0 ? ` (${actionReviews.withoutIntent} without exposed intent)` : ""}
          </span>
        )}
        <span title="Agent executions only. Planning and semantic review model calls are not included.">
          {tokens.toLocaleString()} agent execution tokens (excludes planning and semantic review)
        </span>
        {monitor !== null && (
          <span>
            Final review model: {monitor.inputTokens === null || monitor.outputTokens === null ? "tokens not reported" : `${(monitor.inputTokens + monitor.outputTokens).toLocaleString()} tokens`}, {Math.round(monitor.durationMs / 100) / 10}s
          </span>
        )}
        <span>{elapsed}</span>
      </div>
      <nav aria-label="Run evidence" className="cluster">
        <a href="#final-review">Final review</a><a href="#run-changes">Changes</a><a href="#run-timeline">Timeline</a><a href="#run-tasks">Tasks</a>
      </nav>
    </section>
  );
}

import type {
  AgentExecution,
  FinalReview,
  FinalReviewReason,
  Run,
  RunDiffChangeReason,
  RunDiffInventoryReason,
  RunDiffResponse,
} from "@launchpad/shared";
import type { Loadable } from "./latest-request";

// The Run receipt in plain words: what ended, what changed, whether the final
// review ran and what it covered. Unknown stays unknown: no baseline is not
// zero changes, and a Run without a saved review is not an aligned one. A
// finished task or an aligned review is never proof the code is correct.

export type Tone = "passed" | "held" | "blocked" | "neutral";

export interface ReviewSummary {
  tone: Tone;
  headline: string;
  detail: string | null;
}

const REVIEW_REASONS: Record<FinalReviewReason, string> = {
  baseline_unavailable: "there was no usable baseline to compare against",
  legacy_artifact: "the saved diff is from an older version",
  inventory_incomplete: "a scan of the files stopped before the end",
  comparison_uncertain: "some files could not be compared",
  content_incomplete: "some changed contents could not be shown to the reviewer",
  list_truncated: "more files changed than the diff lists",
  file_limit: "more files changed than the review covers (36)",
  review_budget_exhausted: "the changes were too large for the review's input budget",
  action_ledger_incomplete: "the record of gated actions or approvals was too long to give the reviewer in full",
  effect_assessment_missing: "the reviewer did not assess every change",
  approval_unmatched: "a cited approval did not exactly cover the change",
  scope_conflict: "a change may be outside the request",
  monitor_error: "the review model call failed or timed out",
  diff_error: "the actual diff could not be computed",
  run_failed: "the Run failed before the review",
  run_cancelled: "the Run was cancelled before the review",
  run_interrupted: "the server restarted during the Run",
  semantic_review_disabled: "semantic review is off on this server",
};

export function reviewReasonText(reasons: readonly FinalReviewReason[]): string {
  return reasons.map((reason) => REVIEW_REASONS[reason] ?? reason).join("; ");
}

export function reviewSummary(review: FinalReview | null): ReviewSummary {
  if (review === null) {
    return { tone: "neutral", headline: "No final review was recorded for this Run.", detail: "Runs from before the review was saved show nothing here; that is unknown, not a pass." };
  }
  const coverage = `${review.coverage.assessedEffects} of ${review.coverage.effects} changed hunks assessed`;
  const reasons = review.reasons.length === 0 ? null : reviewReasonText(review.reasons);
  switch (review.status) {
    case "aligned":
      return {
        tone: "passed",
        headline: "Final review: every actual change was assessed and none conflicts with the request.",
        detail: `${coverage}${review.approvalsApplied.length > 0 ? `; ${review.approvalsApplied.length === 1 ? "1 approved proposal" : `${review.approvalsApplied.length} approved proposals`} covered out-of-scope changes` : ""}. This is a model's judgment of scope, not proof the code is correct.`,
      };
    case "no_changes":
      return { tone: "passed", headline: "Final review: a complete comparison found no changed files.", detail: null };
    case "conflict":
      return {
        tone: "blocked",
        headline: "Final review: some actual changes may be outside the request.",
        detail: `${coverage}. ${review.classification === null ? "" : `Classified ${review.classification.replaceAll("_", " ")}`}${review.riskScore === null ? "" : `, risk ${review.riskScore.toFixed(2)}`}. The Run failed so it does not seed follow-up work; nothing was rolled back.`,
      };
    case "incomplete":
      return {
        tone: "held",
        headline: "Final review incomplete: AgentGuard could not show every change to the reviewer, so it concluded nothing.",
        detail: `Why: ${reasons ?? "not recorded"}. The Run failed so it does not seed follow-up work.`,
      };
    case "unavailable":
      return {
        tone: "held",
        headline: "Final review unavailable: the review could not be completed.",
        detail: `Why: ${reasons ?? "not recorded"}. The Run failed so it does not seed follow-up work.`,
      };
    case "not_run":
      return { tone: "neutral", headline: "Final review did not run.", detail: reasons === null ? null : `Why: ${reasons}.` };
    case "disabled":
      return { tone: "neutral", headline: "Final review is off on this server.", detail: "Actual changes were not reviewed against the request." };
  }
}

const INVENTORY_REASONS: Record<RunDiffInventoryReason, string> = {
  baseline_missing: "no baseline was captured when the copy was made",
  baseline_legacy: "the baseline was recorded by an older version",
  baseline_corrupt: "the baseline could not be read",
  baseline_expired: "the Run's files were removed after the retention period",
  baseline_scan_incomplete: "the baseline scan stopped before the end",
  final_scan_incomplete: "the final scan stopped before the end",
  working_copy_missing: "the Run's copy is missing",
  legacy_artifact: "the saved diff is from an older version",
};

export function inventoryReasonText(reasons: readonly RunDiffInventoryReason[]): string {
  return reasons.map((reason) => INVENTORY_REASONS[reason] ?? reason).join("; ");
}

/** The receipt's "what changed" line. Never says zero when the comparison could not say. */
export function changesSummary(diff: Loadable<RunDiffResponse>): string {
  switch (diff.status) {
    case "idle":
    case "loading":
      return "Loading changes";
    case "error":
      return "Changes could not be loaded";
    case "ready":
      break;
  }
  const value = diff.value;
  if (value.changedFileCount === null) {
    return `Changes unknown: ${inventoryReasonText(value.coverage.inventory.reasons) || "no comparison was possible"}`;
  }
  const count = value.changedFileCount;
  const files = count === 1 ? "1 file" : `${count} files`;
  const uncertain = value.uncertainCount === 0 ? "" : `; ${value.uncertainCount === 1 ? "1 more" : `${value.uncertainCount} more`} could not be compared`;
  if (value.coverage.inventory.status !== "complete") return `At least ${files} changed (the scan stopped early)${uncertain}`;
  return count === 0 && value.uncertainCount === 0 ? "No files changed" : `${files} changed${uncertain}`;
}

const CHANGE_REASONS: Record<RunDiffChangeReason, string> = {
  binary: "Binary file; contents are not shown.",
  oversized: "Larger than 2 MB, so it was not read or compared by content.",
  text_too_large: "Larger than 256 KB of text, so no line diff was made.",
  baseline_text_not_retained: "The baseline's text budget was spent before this file, so its earlier text was not kept.",
  final_text_not_read: "The diff's text budget was spent before this file.",
  unreadable: "It could not be read.",
  credential_withheld: "Its name marks it as a credential file, so its contents are never captured.",
  link_not_followed: "A link: its target is shown, but it was never followed.",
  special_file: "Not a regular file; there are no contents to show.",
  size_only_comparison: "Too large to compare by content and the same size before and after: it may or may not have changed.",
  redacted_or_encoding_change: "The bytes changed, but only inside redacted values or undecodable text, so no line shows the change.",
  hunks_truncated: "Some changed lines are not shown: the diff for this file reached its size limit.",
};

export function changeReasonText(reasons: readonly RunDiffChangeReason[]): string[] {
  return reasons.map((reason) => CHANGE_REASONS[reason] ?? reason);
}

/** Agent execution tokens only. Planning and semantic review calls are not in this total. */
export function executionTokens(executions: readonly Pick<AgentExecution, "usage">[]): number {
  return executions.reduce((total, item) => total + (item.usage?.inputTokens ?? 0) + (item.usage?.outputTokens ?? 0), 0);
}

/** Why the Run ended as it did, separating a coding-task failure from a review that stopped it. */
export function endedBecause(run: Pick<Run, "status" | "finalReview" | "cancelRequestedAt">): string {
  if (run.status === "completed") return "Run completed. The agent's report is not independently verified.";
  if (run.status === "cancelled") return "Run cancelled. Work in progress was stopped; its files are kept.";
  const review = run.finalReview;
  if (review !== null && (review.status === "conflict" || review.status === "incomplete" || review.status === "unavailable")) {
    return "Run failed at the final review: the agents' tasks finished, but the review did not accept the actual changes.";
  }
  return "Run failed before its final review: a task or the Run itself did not finish.";
}

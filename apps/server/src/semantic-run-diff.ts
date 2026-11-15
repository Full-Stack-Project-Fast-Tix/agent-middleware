import type { Approval, RunDiffResponse } from "@launchpad/shared";
import type { SemanticActionSummary, SemanticAssessment, SemanticIntentMonitor, SemanticMonitorInput, SemanticProposedEffect } from "./semantic-intent-monitor.js";

const MAX_FILES_TO_REVIEW = 36;
const FILES_PER_REVIEW = 12;
const MAX_DIFF_CHARS = 1_200;
const MAX_FINAL_MONITOR_INPUT_CHARS = 48_000;

/** Reassesses the actual bounded workspace diff against the original Run prompt. */
export async function reviewFinalRunDiff(
  monitor: SemanticIntentMonitor,
  input: {
    userPrompt: string;
    diff: RunDiffResponse;
    approvals: Approval[];
    reviewedActions: SemanticActionSummary[];
    actionLedgerTruncated: boolean;
  },
): Promise<SemanticAssessment> {
  if (!input.diff.baselineAvailable || input.diff.truncated) {
    throw new Error("The actual workspace diff is incomplete and cannot be fully reviewed");
  }
  if (input.actionLedgerTruncated) {
    throw new Error("The gated action history is incomplete and cannot be fully reviewed");
  }
  if (input.diff.changes.length === 0) {
    return {
      riskScore: 0,
      confidence: 1,
      classification: "aligned",
      apparentObjective: "No workspace changes were recorded.",
      conflictsWithTask: false,
      evidenceSeqs: [],
      rationale: "There are no changed files to compare with the requested task.",
      effectAssessments: [],
    };
  }
  if (input.diff.changes.length > MAX_FILES_TO_REVIEW) {
    throw new Error("The final diff exceeds the " + MAX_FILES_TO_REVIEW + "-file review limit");
  }
  const reviews: SemanticAssessment[] = [];
  for (let start = 0; start < input.diff.changes.length; start += FILES_PER_REVIEW) {
    const changes = input.diff.changes.slice(start, start + FILES_PER_REVIEW);
    const proposedEffects: SemanticProposedEffect[] = changes.map((change, index) => ({
      index,
      kind: "file_change",
      summary: change.kind + " " + change.path + " (" + change.display + ")\n" + (change.diff ?? "").slice(0, MAX_DIFF_CHARS),
    }));
    const recentActions = [
      ...input.reviewedActions.slice(-32).map((action, index) => ({
        seq: index,
        type: action.type,
        summary: ("Gate-reviewed action: " + action.summary).slice(0, 450),
      })),
      ...input.approvals.slice(-8).map((approval, index) => ({
        seq: input.reviewedActions.slice(-32).length + index,
        type: "file_change" as const,
        summary: ("Approval " + approval.status + ", reason=" + approval.reason + ": " + approval.summary).slice(0, 500),
      })),
    ];
    const monitorInput: SemanticMonitorInput = {
      checkpoint: "final_diff",
      trustedTask: { userPrompt: input.userPrompt, agentInstructions: "" },
      recentReasoning: [],
      recentActions,
      recentSources: [],
      proposedEffects,
      proposedAction: {
        type: "file_change",
        seq: 0,
        itemId: "final-diff-" + (start / FILES_PER_REVIEW),
        changes: changes.map((change) => ({
          path: change.path,
          kind: change.kind === "added" ? "add" : change.kind === "deleted" ? "delete" : "update",
          diff: (change.diff ?? "").slice(0, MAX_DIFF_CHARS),
        })),
      },
      cheapIntentSignal: false,
    };
    if (JSON.stringify(monitorInput).length > MAX_FINAL_MONITOR_INPUT_CHARS) {
      throw new Error("The final diff review input exceeds its bounded size");
    }
    reviews.push(await monitor.assess(monitorInput));
  }
  const conflicting = reviews.filter((review) => review.conflictsWithTask);
  const highest = conflicting.reduce<SemanticAssessment | null>(
    (current, review) => current === null || review.riskScore > current.riskScore ? review : current,
    null,
  );
  const highestOverall = highest === null
    ? reviews.reduce((current, review) => Math.max(current, review.riskScore), 0)
    : highest.riskScore;
  const first = reviews[0]!;
  return {
    ...first,
    riskScore: highestOverall,
    conflictsWithTask: highest !== null,
    ...(highest === null ? {} : { classification: highest.classification }),
    evidenceSeqs: [...new Set(reviews.flatMap((review) => review.evidenceSeqs))].slice(0, 24),
    rationale: reviews.map((review) => review.rationale).join(" ").slice(0, 1_000),
    effectAssessments: reviews.flatMap((review) => review.effectAssessments ?? []).slice(0, 24),
  };
}

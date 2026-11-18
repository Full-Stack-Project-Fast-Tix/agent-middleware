import {
  FINAL_REVIEW_MAX_FILES,
  RUN_DIFF_VERSION,
  type Approval,
  type FinalReview,
  type FinalReviewReason,
  type JsonObject,
  type RunDiffChange,
  type RunDiffResponse,
} from "@launchpad/shared";
import { SEMANTIC_ACTION_BLOCK_RISK, SEMANTIC_ACTION_REVIEW_RISK } from "./intent-controller.js";
import { redactSensitiveText } from "./redaction/index.js";
import { splitAtLines } from "./text-parts.js";
import {
  redactMonitorInput,
  type SemanticActionSummary,
  type SemanticAssessment,
  type SemanticIntentMonitor,
  type SemanticMonitorInput,
  type SemanticProposedEffect,
} from "./semantic-intent-monitor.js";

// The final review: the Run's actual changes, every changed hunk of them,
// against the original prompt, the gated-action ledger and the approvals.
//
// It concludes only from complete evidence. Before any model call it checks the
// diff's coverage, the ledger and the size of the work; anything missing makes
// the review `incomplete`, never `aligned`. Every hunk becomes one or more
// effects with a stable id (F<file>.H<hunk>[.P<part>]), effects are packed into
// bounded batches, and each batch must return exactly one assessment per effect.
// A conflict found in any batch stands unless an approval the server loaded
// covers that exact effect.
//
// An approval covers an effect only when: it was approved; its saved proposal
// is complete; a file-change approval names the effect's path; the reviewer
// says the effect is exactly that proposal; and the risk is in the review band
// (below the 0.75 block threshold, which no approval overrides).

/** Characters of hunk text in one effect; a longer hunk is split into parts at line ends. */
export const FINAL_REVIEW_MAX_EFFECT_CHARS = 4_000;
/** Redacted JSON characters in one reviewer call. */
export const FINAL_REVIEW_MAX_CALL_CHARS = 60_000;
/** Reviewer calls in one final review; more work than fits is incomplete. */
export const FINAL_REVIEW_MAX_CALLS = 8;
/** Effects in one call (the reviewer's per-call itemization limit). */
export const FINAL_REVIEW_EFFECTS_PER_CALL = 24;
/** Approvals given to the reviewer; more is an incomplete ledger. */
export const FINAL_REVIEW_MAX_APPROVALS = 8;
const MAX_APPROVAL_CHARS = 1_600;
const PROPOSAL_CUT = "[proposal cut for length]";
const APPROVAL_SEQ_BASE = 100;

export type FinalReviewOutcome = Omit<FinalReview, "reviewedAt" | "findingId">;

export interface FinalReviewInput {
  userPrompt: string;
  diff: RunDiffResponse;
  /** Loaded by the server for this Run; agent claims of approval are never an input. */
  approvals: Approval[];
  reviewedActions: SemanticActionSummary[];
  actionLedgerTruncated: boolean;
  signal?: AbortSignal;
  now?: () => number;
}

interface Effect {
  id: string;
  path: string;
  summary: string;
}

interface Assessed {
  effect: Effect;
  riskScore: number;
  classification: string;
  conflictsWithTask: boolean;
  approvalRef: string;
}

/** Thrown only when the review was aborted (the Run is being cancelled). Every other failure is an outcome. */
export class FinalReviewAbortedError extends Error {
  constructor() {
    super("The final review was cancelled");
    this.name = "FinalReviewAbortedError";
  }
}

export async function reviewFinalRunDiff(monitor: SemanticIntentMonitor, input: FinalReviewInput): Promise<FinalReviewOutcome> {
  const now = input.now ?? Date.now;
  const started = now();
  const diff = input.diff;
  const approvals = [...input.approvals].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  const base = {
    changedFiles: diff.changedFileCount,
    actions: input.reviewedActions.length,
    actionLedgerComplete: !input.actionLedgerTruncated && approvals.length <= FINAL_REVIEW_MAX_APPROVALS,
    approvals: approvals.length,
  };
  const result = (
    status: FinalReviewOutcome["status"],
    reasons: FinalReviewReason[],
    extra: Partial<FinalReviewOutcome> & { effects?: number; assessedEffects?: number; modelCalls?: number } = {},
  ): FinalReviewOutcome => ({
    status,
    reasons: [...new Set(reasons)].slice(0, 16),
    coverage: {
      ...base,
      effects: extra.effects ?? 0,
      assessedEffects: extra.assessedEffects ?? 0,
      modelCalls: extra.modelCalls ?? 0,
    },
    riskScore: extra.riskScore ?? null,
    classification: extra.classification ?? null,
    rationale: extra.rationale ?? null,
    conflictingPaths: extra.conflictingPaths ?? [],
    approvalsApplied: extra.approvalsApplied ?? [],
    monitorUsage: extra.monitorUsage ?? null,
  });

  // 1. Coverage, before spending anything on a model.
  const gaps = coverageGaps(diff);
  if (gaps.length > 0) return result("incomplete", gaps);
  if (diff.changedFileCount === 0) return result("no_changes", []);
  if (diff.changedFileCount! > FINAL_REVIEW_MAX_FILES) return result("incomplete", ["file_limit"]);
  if (!base.actionLedgerComplete) return result("incomplete", ["action_ledger_incomplete"]);

  // 2. Every hunk, as effects with stable ids.
  const effects = diff.changes.flatMap((change, fileIndex) => effectsOf(change, fileIndex));
  const approvalRefs = new Map<string, { approval: Approval; cut: boolean }>(approvals.map((approval, index) => {
    const ref = `A${index + 1}`;
    // Exactly what the reviewer is shown for this reference: a cut proposal cannot authorize.
    return [ref, { approval, cut: approvalSummary(ref, approval).endsWith(PROPOSAL_CUT) }];
  }));
  const context = [
    ...input.reviewedActions.map((action, index) => ({ seq: index, type: action.type, summary: action.summary })),
    ...approvals.map((approval, index): SemanticActionSummary => ({
      seq: APPROVAL_SEQ_BASE + index,
      type: approval.actionType === "delegation" || approval.actionType === "context_handoff" || approval.actionType === "command"
        ? approval.actionType
        : "file_change",
      summary: approvalSummary(`A${index + 1}`, approval),
    })),
  ];
  const batches = packBatches(input.userPrompt, context, effects);
  if (batches === null || batches.length > FINAL_REVIEW_MAX_CALLS) {
    return result("incomplete", ["review_budget_exhausted"], { effects: effects.length });
  }

  // 3. Review each batch; every effect must come back assessed.
  const assessed: Assessed[] = [];
  const unexplained: SemanticAssessment[] = [];
  const rationales: string[] = [];
  let calls = 0;
  let inputTokens: number | null = 0;
  let outputTokens: number | null = 0;
  const usage = () => ({ inputTokens, outputTokens, durationMs: Math.max(0, Math.round(now() - started)) });
  for (const batch of batches) {
    if (input.signal?.aborted) throw new FinalReviewAbortedError();
    let assessment: SemanticAssessment;
    try {
      calls += 1;
      assessment = await monitor.assess(monitorInput(input.userPrompt, context, batch), input.signal === undefined ? {} : { signal: input.signal });
    } catch {
      if (input.signal?.aborted) throw new FinalReviewAbortedError();
      return result("unavailable", ["monitor_error"], { effects: effects.length, assessedEffects: assessed.length, modelCalls: calls, monitorUsage: usage() });
    }
    inputTokens = sumOrNull(inputTokens, assessment.usage?.inputTokens);
    outputTokens = sumOrNull(outputTokens, assessment.usage?.outputTokens);
    const byIndex = new Map<number, NonNullable<SemanticAssessment["effectAssessments"]>[number]>();
    for (const item of assessment.effectAssessments ?? []) {
      if (byIndex.has(item.index)) {
        return result("incomplete", ["effect_assessment_missing"], { effects: effects.length, assessedEffects: assessed.length, modelCalls: calls, monitorUsage: usage() });
      }
      byIndex.set(item.index, item);
    }
    if (byIndex.size !== batch.length || batch.some((_, index) => !byIndex.has(index))) {
      return result("incomplete", ["effect_assessment_missing"], { effects: effects.length, assessedEffects: assessed.length, modelCalls: calls, monitorUsage: usage() });
    }
    batch.forEach((effect, index) => {
      const item = byIndex.get(index)!;
      assessed.push({
        effect,
        riskScore: item.riskScore,
        classification: item.classification,
        conflictsWithTask: item.conflictsWithTask,
        approvalRef: (item.approvalRef ?? "").trim(),
      });
    });
    // The highest risk the itemized conflicts account for in this batch.
    const itemizedRisk = Math.max(0, ...batch.map((_, index) => byIndex.get(index)!).filter(conflicts).map((item) => item.riskScore));
    if (conflicts(assessment)) {
      rationales.unshift(assessment.rationale);
      // An overall conflict riskier than every itemized one is not explained by
      // them, so it stands on its own and no approval of an item can cover it.
      if (assessment.riskScore > itemizedRisk) unexplained.push(assessment);
    } else {
      rationales.push(assessment.rationale);
    }
  }

  // 4. Conflicts stand unless an exact, complete, approved proposal covers them.
  const standing: Assessed[] = [];
  const applied = new Set<string>();
  let unmatched = false;
  for (const item of assessed) {
    if (!conflicts(item)) continue;
    const cited = item.approvalRef === "" ? undefined : approvalRefs.get(item.approvalRef);
    if (cited !== undefined && !cited.cut && approvalCovers(cited.approval, item)) {
      applied.add(cited.approval.id);
      continue;
    }
    if (item.approvalRef !== "") unmatched = true;
    standing.push(item);
  }
  const highest = [...standing].sort((a, b) => b.riskScore - a.riskScore)[0];
  const highestUnexplained = [...unexplained].sort((a, b) => b.riskScore - a.riskScore)[0];
  const maximumRisk = Math.max(0, ...assessed.map((item) => item.riskScore));
  const conflictFound = highest !== undefined || highestUnexplained !== undefined;
  const riskScore = conflictFound ? Math.max(highest?.riskScore ?? 0, highestUnexplained?.riskScore ?? 0) : maximumRisk;
  const classification = highest?.classification ?? highestUnexplained?.classification
    ?? [...assessed].sort((a, b) => b.riskScore - a.riskScore)[0]?.classification ?? "aligned";
  return result(conflictFound ? "conflict" : "aligned", [
    ...(conflictFound ? ["scope_conflict" as const] : []),
    ...(unmatched ? ["approval_unmatched" as const] : []),
  ], {
    effects: effects.length,
    assessedEffects: assessed.length,
    modelCalls: calls,
    riskScore,
    classification,
    rationale: bounded(redactSensitiveText(rationales.join(" ").replace(/\s+/g, " ").trim()), 1_000) || null,
    conflictingPaths: [...new Set(standing.map((item) => item.effect.path))].slice(0, 24).map((path) => bounded(redactSensitiveText(path), 300)),
    approvalsApplied: [...applied].slice(0, 16),
    monitorUsage: usage(),
  });
}

function conflicts(assessment: { conflictsWithTask: boolean; riskScore: number }): boolean {
  return assessment.conflictsWithTask && assessment.riskScore >= SEMANTIC_ACTION_REVIEW_RISK;
}

/** What makes the diff unfit to conclude from, in the order a reader would fix them. */
export function coverageGaps(diff: RunDiffResponse): FinalReviewReason[] {
  const gaps: FinalReviewReason[] = [];
  if (diff.version !== RUN_DIFF_VERSION) gaps.push("legacy_artifact");
  if (diff.baseline !== "available") gaps.push("baseline_unavailable");
  if (diff.coverage.inventory.status !== "complete") gaps.push("inventory_incomplete");
  if (diff.uncertainCount > 0 || diff.changes.some((change) => change.kind === "uncertain")) gaps.push("comparison_uncertain");
  if (diff.coverage.content.status !== "complete" || diff.changes.some((change) => change.content !== "complete")) gaps.push("content_incomplete");
  if (diff.listTruncated) gaps.push("list_truncated");
  if (diff.changedFileCount === null && !gaps.includes("baseline_unavailable")) gaps.push("baseline_unavailable");
  return gaps;
}

/** One effect per hunk, or per part of a hunk too long for one effect. Every line lands in exactly one part. */
function effectsOf(change: RunDiffChange, fileIndex: number): Effect[] {
  const effects: Effect[] = [];
  change.hunks.forEach((hunk, hunkIndex) => {
    const parts = splitAtLines(hunk.text, FINAL_REVIEW_MAX_EFFECT_CHARS);
    parts.forEach((part, partIndex) => {
      const id = `F${fileIndex + 1}.H${hunkIndex + 1}` + (parts.length > 1 ? `.P${partIndex + 1}` : "");
      const position = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
      const partNote = parts.length > 1 ? ` (part ${partIndex + 1} of ${parts.length} of this hunk)` : "";
      effects.push({ id, path: change.path, summary: `${id} ${change.kind} ${change.path} ${position}${partNote}\n${part}` });
    });
  });
  return effects;
}

function monitorInput(userPrompt: string, context: SemanticActionSummary[], batch: Effect[]): SemanticMonitorInput {
  const proposedEffects: SemanticProposedEffect[] = batch.map((effect, index) => ({ index, kind: "file_change", summary: effect.summary }));
  return {
    checkpoint: "final_diff",
    trustedTask: { userPrompt, agentInstructions: "" },
    recentReasoning: [],
    recentActions: context,
    recentSources: [],
    proposedEffects,
    cheapIntentSignal: false,
  };
}

/** Greedy packing within the per-call size and itemization limits. Null when one effect cannot fit any call. */
function packBatches(userPrompt: string, context: SemanticActionSummary[], effects: Effect[]): Effect[][] | null {
  const size = (batch: Effect[]) => JSON.stringify(redactMonitorInput(monitorInput(userPrompt, context, batch))).length;
  const batches: Effect[][] = [];
  let current: Effect[] = [];
  for (const effect of effects) {
    const candidate = [...current, effect];
    if (candidate.length <= FINAL_REVIEW_EFFECTS_PER_CALL && size(candidate) <= FINAL_REVIEW_MAX_CALL_CHARS) {
      current = candidate;
      continue;
    }
    if (current.length === 0) return null;
    batches.push(current);
    current = [effect];
    if (size(current) > FINAL_REVIEW_MAX_CALL_CHARS) return null;
    // Stop early: the budget is already spent, and packing the rest would only measure.
    if (batches.length >= FINAL_REVIEW_MAX_CALLS) return [...batches, current];
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** One approval as the reviewer sees it: server-loaded identity, outcome, binding and the bounded proposal. */
function approvalSummary(ref: string, approval: Approval): string {
  const details = approval.safeDetails;
  const complete = proposalComplete(details);
  const header = `APPROVAL ${ref} status=${approval.status} reason=${approval.reason} action=${approval.actionType}` +
    ` ${approval.status === "approved" ? "(grants only its exact proposal)" : "(grants nothing)"}` +
    `${complete ? "" : " proposal=INCOMPLETE (cannot authorize any effect)"}`;
  const proposal = details === null ? "No proposal details were saved." : JSON.stringify(details);
  const text = `${header}\nProposal: ${proposal}`;
  return text.length <= MAX_APPROVAL_CHARS ? text : `${bounded(text, MAX_APPROVAL_CHARS - 40)} ${PROPOSAL_CUT}`;
}

/** Whether the saved proposal says it is the whole proposal. Older approvals that do not say so are not. */
export function proposalComplete(details: JsonObject | null): boolean {
  return details !== null && details.complete === true;
}

function approvalCovers(approval: Approval, item: Assessed): boolean {
  if (approval.status !== "approved") return false;
  if (item.riskScore >= SEMANTIC_ACTION_BLOCK_RISK) return false;
  if (!proposalComplete(approval.safeDetails)) return false;
  if (approval.actionType === "file_change") {
    const files = Array.isArray(approval.safeDetails?.files) ? approval.safeDetails.files : [];
    const target = copyRelative(item.effect.path);
    return files.some((file) => {
      if (file === null || typeof file !== "object") return false;
      const { path, movePath } = file as { path?: unknown; movePath?: unknown };
      return (typeof path === "string" && copyRelative(path) === target) || (typeof movePath === "string" && copyRelative(movePath) === target);
    });
  }
  return approval.actionType === "command";
}

/**
 * A path as the diff names it, relative to the copy. Agents propose editor
 * paths inside the container, where the copy is mounted at /workspace.
 */
export function copyRelative(proposed: string): string {
  const withoutMount = proposed.startsWith("/workspace/") ? proposed.slice("/workspace/".length) : proposed;
  return withoutMount.replace(/^(?:\.\/)+/, "");
}

function sumOrNull(total: number | null, value: number | null | undefined): number | null {
  return total === null || value === undefined || value === null ? null : total + value;
}

function bounded(text: string, maximum: number): string {
  return text.length <= maximum ? text : text.slice(0, maximum - 1) + "…";
}

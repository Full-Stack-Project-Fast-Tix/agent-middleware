import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FinalReview, Run, RunDiffResponse } from "@launchpad/shared";
import { ActualChanges } from "./ActualChanges";
import { RunReceipt } from "./RunReceipt";
import { changesSummary, endedBecause, reviewSummary } from "./run-receipt";

const NOW = "2026-11-18T00:00:00.000Z";

function review(overrides: Partial<FinalReview> = {}): FinalReview {
  return {
    status: "aligned",
    reasons: [],
    reviewedAt: NOW,
    coverage: { changedFiles: 2, effects: 3, assessedEffects: 3, modelCalls: 1, actions: 5, actionLedgerComplete: true, approvals: 0 },
    riskScore: 0.05,
    classification: "aligned",
    rationale: "The changes implement the discount.",
    conflictingPaths: [],
    approvalsApplied: [],
    findingId: null,
    monitorUsage: { inputTokens: 900, outputTokens: 100, durationMs: 1_500 },
    ...overrides,
  };
}

function diff(overrides: Partial<RunDiffResponse> = {}): RunDiffResponse {
  return {
    version: 2,
    generatedAt: NOW,
    baseline: "available",
    changes: [],
    changedFileCount: 0,
    uncertainCount: 0,
    listTruncated: false,
    coverage: {
      inventory: { status: "complete", reasons: [], baseline: null, final: null },
      content: { status: "complete", changedEntries: 0, completeEntries: 0 },
    },
    scope: { excludedDirectories: ["node_modules", ".git"], maxFiles: 500, maxDepth: 16, maxHashFileBytes: 2_097_152, maxTextFileBytes: 262_144 },
    ...overrides,
  };
}

const run = (overrides: Partial<Run> = {}): Run => ({
  id: "00000000-0000-4000-8000-0000000000b1",
  workspaceId: "00000000-0000-4000-8000-0000000000a1",
  parentRunId: null,
  createdByUserId: "00000000-0000-4000-8000-0000000000c1",
  supervisorAgentId: null,
  userPrompt: "Add a discount",
  orchestrationMode: "single",
  status: "completed",
  finalOutput: "Done.",
  error: null,
  cancelRequestedAt: null,
  evaluation: null,
  finalReview: review(),
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
  completedAt: "2026-11-18T00:01:00.000Z",
  ...overrides,
});

describe("final review in the receipt", () => {
  it("states each outcome in plain words without calling a pass proof", () => {
    expect(reviewSummary(review())).toMatchObject({ tone: "passed", detail: expect.stringContaining("not proof the code is correct") });
    expect(reviewSummary(review({ status: "no_changes" })).headline).toContain("complete comparison found no changed files");
    expect(reviewSummary(review({ status: "conflict", riskScore: 0.62, classification: "scope_expansion" })).detail).toContain("scope expansion, risk 0.62");
    expect(reviewSummary(review({ status: "incomplete", reasons: ["content_incomplete", "file_limit"] })).detail)
      .toBe("Why: some changed contents could not be shown to the reviewer; more files changed than the review covers (36). The Run failed so it does not seed follow-up work.");
    expect(reviewSummary(review({ status: "unavailable", reasons: ["monitor_error"] })).headline).toContain("unavailable");
    expect(reviewSummary(review({ status: "not_run", reasons: ["run_cancelled"] })).detail).toContain("cancelled before the review");
    expect(reviewSummary(review({ status: "disabled", reasons: ["semantic_review_disabled"] })).headline).toContain("off on this server");
    expect(reviewSummary(null)).toMatchObject({ tone: "neutral", detail: expect.stringContaining("unknown, not a pass") });
  });

  it("separates a review that stopped the Run from a task failure", () => {
    expect(endedBecause(run({ status: "failed", finalReview: review({ status: "conflict" }) }))).toContain("failed at the final review");
    expect(endedBecause(run({ status: "failed", finalReview: review({ status: "not_run", reasons: ["run_failed"] }) }))).toContain("before its final review");
    expect(endedBecause(run())).toContain("not independently verified");
  });

  it("keeps unknown counts unknown and says when a count is only a lower bound", () => {
    expect(changesSummary({ status: "ready", value: diff({ baseline: "missing", changedFileCount: null, coverage: { inventory: { status: "unavailable", reasons: ["baseline_missing"], baseline: null, final: null }, content: { status: "unknown", changedEntries: 0, completeEntries: 0 } } }) }))
      .toBe("Changes unknown: no baseline was captured when the copy was made");
    expect(changesSummary({ status: "ready", value: diff({ changedFileCount: 3, uncertainCount: 1, coverage: { inventory: { status: "incomplete", reasons: ["final_scan_incomplete"], baseline: null, final: null }, content: { status: "incomplete", changedEntries: 4, completeEntries: 3 } } }) }))
      .toBe("At least 3 files changed (the scan stopped early); 1 more could not be compared");
    expect(changesSummary({ status: "ready", value: diff() })).toBe("No files changed");
    expect(changesSummary({ status: "error", message: "x" })).toBe("Changes could not be loaded");
  });

  it("renders the review, its finding, flagged paths and labelled token totals", () => {
    const conflict = review({ status: "conflict", riskScore: 0.6, classification: "scope_expansion", conflictingPaths: ["CHANGELOG.md"], findingId: "00000000-0000-4000-8000-0000000000f1" });
    const html = renderToStaticMarkup(
      <RunReceipt
        run={run({ status: "failed", finalReview: conflict })}
        tasks={[]}
        executions={[{ usage: { inputTokens: 1_000, outputTokens: 500 } } as never]}
        approvals={[]}
        findings={[{ id: "00000000-0000-4000-8000-0000000000f1", code: "semantic-final-scope-expansion", severity: "medium" } as never]}
        diff={{ status: "ready", value: diff({ changedFileCount: 1 }) }}
      />,
    );
    expect(html).toContain("may be outside the request");
    expect(html).toContain("CHANGELOG.md");
    expect(html).toContain("Recorded as finding semantic-final-scope-expansion");
    expect(html).toContain("1,500 agent execution tokens (excludes planning and semantic review)");
    expect(html).toContain("Final review model: 1,000 tokens");
    expect(html).toContain("Written by a model; not verified");
    expect(html).toContain('href="#run-changes"');
  });
});

describe("actual changes", () => {
  it("says exactly what is unavailable for each changed entry", () => {
    const value = diff({
      changedFileCount: 2,
      uncertainCount: 1,
      changes: [
        { path: "src/a.ts", kind: "modified", entryType: "file", content: "complete", reasons: [], hunks: [{ oldStart: 348, oldLines: 1, newStart: 348, newLines: 1, text: "-old\n+new" }], size: 4 },
        { path: "logo.png", kind: "added", entryType: "file", content: "unavailable", reasons: ["binary"], hunks: [], size: 4 },
        { path: "data.bin", kind: "uncertain", entryType: "file", content: "unavailable", reasons: ["size_only_comparison"], hunks: [], size: 3_000_000 },
      ],
      coverage: { inventory: { status: "complete", reasons: [], baseline: null, final: null }, content: { status: "incomplete", changedEntries: 3, completeEntries: 1 } },
    });
    const html = renderToStaticMarkup(<ActualChanges diff={{ status: "ready", value }} onRetry={() => undefined} />);
    expect(html).toContain("@@ -348,1 +348,1 @@");
    expect(html).toContain("Binary file; contents are not shown.");
    expect(html).toContain("could not be compared");
    expect(html).toContain("it may or may not have changed");
    expect(html).toContain("Not compared: node_modules, .git folders");
  });

  it("marks a legacy diff and an unavailable comparison instead of showing zero changes", () => {
    const legacy = renderToStaticMarkup(<ActualChanges diff={{ status: "ready", value: diff({ version: 1, changedFileCount: 1, coverage: { inventory: { status: "incomplete", reasons: ["legacy_artifact"], baseline: null, final: null }, content: { status: "unknown", changedEntries: 1, completeEntries: 0 } } }) }} onRetry={() => undefined} />);
    expect(legacy).toContain("saved by an older version");
    const missing = renderToStaticMarkup(<ActualChanges diff={{ status: "ready", value: diff({ baseline: "expired", changedFileCount: null, coverage: { inventory: { status: "unavailable", reasons: ["baseline_expired"], baseline: null, final: null }, content: { status: "unknown", changedEntries: 0, completeEntries: 0 } } }) }} onRetry={() => undefined} />);
    expect(missing).toContain("No comparison was possible: the Run&#x27;s files were removed after the retention period");
    expect(missing).not.toContain("No files changed");
  });
});

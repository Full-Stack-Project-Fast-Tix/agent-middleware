import { describe, expect, it } from "vitest";
import type { Approval, RunDiffResponse } from "@launchpad/shared";
import type { SemanticAssessment, SemanticIntentMonitor, SemanticMonitorInput } from "../../src/semantic-intent-monitor.js";
import { reviewFinalRunDiff } from "../../src/semantic-run-diff.js";

const task = "Add percentage discount support to checkout pricing and verify it with tests.";

function makeDiff(count = 1): RunDiffResponse {
  return {
    changes: Array.from({ length: count }, (_, index) => ({
      path: `src/file-${index}.js`,
      kind: "added" as const,
      diff: `+ export const item${index} = true;`,
      display: "text" as const,
    })),
    changedFileCount: count,
    truncated: false,
    baselineAvailable: true,
  };
}

function assessment(overrides: Partial<SemanticAssessment> = {}): SemanticAssessment {
  return {
    riskScore: 0.1,
    confidence: 0.9,
    classification: "aligned",
    apparentObjective: "Implement the requested checkout change.",
    conflictsWithTask: false,
    evidenceSeqs: [],
    rationale: "The actual changes fit the task.",
    effectAssessments: [],
    ...overrides,
  };
}

function monitorReturning(responses: SemanticAssessment[]) {
  const inputs: SemanticMonitorInput[] = [];
  const monitor: SemanticIntentMonitor = {
    assess: async (input) => {
      inputs.push(input);
      const result = responses[inputs.length - 1];
      if (result === undefined) throw new Error("unexpected extra monitor call");
      return result;
    },
  };
  return { monitor, inputs };
}

describe("final actual diff semantic review", () => {
  it("compares changed files with the trusted prompt, gated actions, and approval outcomes", async () => {
    const { monitor, inputs } = monitorReturning([assessment()]);
    const approval = {
      id: "approval-1",
      status: "timed_out",
      reason: "semantic_uncertainty",
      summary: "Add an unrelated receipt formatter",
    } as unknown as Approval;

    await reviewFinalRunDiff(monitor, {
      userPrompt: task,
      diff: makeDiff(),
      approvals: [approval],
      reviewedActions: [{ seq: 4, type: "file_change", summary: "allow: update src/pricing.js" }],
      actionLedgerTruncated: false,
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      checkpoint: "final_diff",
      trustedTask: { userPrompt: task },
      recentActions: [
        { type: "file_change", summary: expect.stringContaining("src/pricing.js") },
        { type: "file_change", summary: expect.stringContaining("timed_out") },
      ],
      proposedEffects: [{ kind: "file_change", summary: expect.stringContaining("src/file-0.js") }],
    });
  });

  it("preserves a conflict found in a later diff chunk", async () => {
    const { monitor, inputs } = monitorReturning([
      assessment(),
      assessment({
        riskScore: 0.62,
        classification: "scope_expansion",
        conflictsWithTask: true,
        evidenceSeqs: [1],
        rationale: "The second group contains unrelated work.",
      }),
    ]);

    const result = await reviewFinalRunDiff(monitor, {
      userPrompt: task,
      diff: makeDiff(13),
      approvals: [],
      reviewedActions: [],
      actionLedgerTruncated: false,
    });

    expect(inputs).toHaveLength(2);
    expect(result).toMatchObject({
      conflictsWithTask: true,
      riskScore: 0.62,
      classification: "scope_expansion",
    });
  });

  it("rejects incomplete diffs or an incomplete gated action ledger", async () => {
    const { monitor, inputs } = monitorReturning([]);
    await expect(reviewFinalRunDiff(monitor, {
      userPrompt: task,
      diff: { ...makeDiff(), truncated: true },
      approvals: [],
      reviewedActions: [],
      actionLedgerTruncated: false,
    })).rejects.toThrow("incomplete");
    await expect(reviewFinalRunDiff(monitor, {
      userPrompt: task,
      diff: makeDiff(),
      approvals: [],
      reviewedActions: [],
      actionLedgerTruncated: true,
    })).rejects.toThrow("history is incomplete");
    expect(inputs).toHaveLength(0);
  });
});

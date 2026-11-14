import { describe, expect, it } from "vitest";
import { IntentController } from "../../src/intent-controller.js";
import type {
  SemanticAssessment,
  SemanticIntentMonitor,
  SemanticMonitorInput,
  SemanticProposedAction,
} from "../../src/semantic-intent-monitor.js";

const task = {
  userPrompt: "Fix the timeout without weakening authentication.",
  agentInstructions: "Keep the change scoped.",
};

const action: SemanticProposedAction = {
  type: "file_change",
  seq: 1,
  itemId: "f1",
  changes: [{ path: "src/auth.ts", kind: "update", diff: "+ change" }],
};

function assessment(
  conflictsWithTask: boolean,
  riskScore: number,
  confidence: number,
): SemanticAssessment {
  return {
    conflictsWithTask,
    riskScore,
    confidence,
    classification: conflictsWithTask ? "security_weakening" : "aligned",
    apparentObjective: conflictsWithTask ? "weaken authentication" : "fix the timeout",
    evidenceSeqs: [1],
    rationale: "Test assessment.",
  };
}

function monitorReturning(value: SemanticAssessment): SemanticIntentMonitor {
  return {
    assess: async (_input: SemanticMonitorInput) => value,
  };
}

describe("semantic action decision thresholds", () => {
  it("reviews compound shell writes even when no reasoning was emitted", async () => {
    const seen: SemanticMonitorInput[] = [];
    const controller = new IntentController({
      assess: async (input) => {
        seen.push(input);
        return assessment(true, 0.6, 0.8);
      },
    }, task);
    const result = await controller.reviewAction([], {
      type: "command",
      seq: 1,
      itemId: "c1",
      command: "cat >> src/pricing.js <<'EOF'\nchange\nEOF\nsed -i 's/1.4.2/1.4.3/' package.json",
    });
    expect(result.decision).toBe("human_review");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.checkpoint).toBe("command");
    expect(seen[0]?.recentReasoning).toEqual([]);
  });

  it("skips semantic model calls for a proven read-only shell command", async () => {
    let calls = 0;
    const controller = new IntentController({ assess: async () => { calls += 1; return assessment(false, 0.1, 0.9); } }, task);
    const result = await controller.reviewAction([], { type: "command", seq: 1, itemId: "c1", command: "cat package.json" });
    expect(result.decision).toBe("allow");
    expect(calls).toBe(0);
  });

  it("reviews an ordinary editor change when no reasoning was emitted", async () => {
    let calls = 0;
    const controller = new IntentController({ assess: async () => { calls += 1; return assessment(false, 0.1, 0.9); } }, task);
    const result = await controller.reviewAction([], {
      type: "file_change", seq: 1, itemId: "f2", changes: [{ path: "src/pricing.js", kind: "update", diff: "+ discount" }],
    });
    expect(result.decision).toBe("allow");
    expect(calls).toBe(1);
  });

  it.each([
    [0.5, 0.9],
    [0.74, 0.2],
  ])("requires human review for a conflict at risk %s and confidence %s", async (risk, confidence) => {
    const controller = new IntentController(
      monitorReturning(assessment(true, risk, confidence)),
      task,
    );

    const result = await controller.reviewAction([], action, true);

    expect(result).toEqual(
      expect.objectContaining({
        decision: "human_review",
        humanReviewReason: "semantic_uncertainty",
      }),
    );
  });

  it("declines a high-risk conflict regardless of self-reported confidence", async () => {
    const controller = new IntentController(
      monitorReturning(assessment(true, 0.75, 0.2)),
      task,
    );

    expect(await controller.reviewAction([], action, true)).toEqual(
      expect.objectContaining({ decision: "decline" }),
    );
  });

  it("allows a low-risk aligned assessment despite low confidence", async () => {
    const controller = new IntentController(
      monitorReturning(assessment(false, 0.1, 0.5)),
      task,
    );

    expect(await controller.reviewAction([], action, true)).toEqual(
      expect.objectContaining({ decision: "allow" }),
    );
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { Approval, RunDiffChange, RunDiffResponse, RunSnapshot } from "@launchpad/shared";
import type { FinalReviewOutcome, RunDiffReviewer } from "../../src/orchestrator/ports.js";
import type { SemanticIntentMonitor } from "../../src/semantic-intent-monitor.js";
import { reviewFinalRunDiff } from "../../src/semantic-run-diff.js";
import { InMemoryRunStore } from "../../src/orchestrator/in-memory-run-store.js";
import { checkRunInvariants } from "../integration/harness/invariants.js";
import { AGENTS, USER_ID, WORKSPACE_ID, startHarness, waitFor, type Harness, type ScriptStep } from "./fixtures.js";

// The orchestrator's final review of the actual diff, with controlled adapters:
// a scripted runtime and middleware, a fixed diff, and either a scripted
// reviewer or the real reviewFinalRunDiff over a scripted monitor.

const PROMPT = "Add percentage discount support to checkout pricing";

let harness: Harness;
afterEach(() => {
  expect(harness.errors).toEqual([]);
});

function change(path: string, text: string, kind: RunDiffChange["kind"] = "added"): RunDiffChange {
  return {
    path,
    kind,
    entryType: "file",
    content: "complete",
    reasons: [],
    hunks: [{ oldStart: kind === "added" ? 0 : 1, oldLines: kind === "added" ? 0 : 1, newStart: 1, newLines: 1, text }],
    size: text.length,
  };
}

function diffOf(changes: RunDiffChange[], overrides: Partial<RunDiffResponse> = {}): RunDiffResponse {
  return {
    version: 2,
    generatedAt: "2026-11-18T00:00:00.000Z",
    baseline: "available",
    changes,
    changedFileCount: changes.length,
    uncertainCount: 0,
    listTruncated: false,
    coverage: {
      inventory: { status: "complete", reasons: [], baseline: null, final: null },
      content: { status: "complete", changedEntries: changes.length, completeEntries: changes.length },
    },
    scope: { excludedDirectories: [], maxFiles: 500, maxDepth: 16, maxHashFileBytes: 1, maxTextFileBytes: 1 },
    ...overrides,
  };
}

const outcome = (status: FinalReviewOutcome["status"], extra: Partial<FinalReviewOutcome> = {}): FinalReviewOutcome => ({
  status,
  reasons: status === "conflict" ? ["scope_conflict"] : [],
  coverage: { changedFiles: 1, effects: 1, assessedEffects: 1, modelCalls: 1, actions: 0, actionLedgerComplete: true, approvals: 0 },
  riskScore: status === "conflict" ? 0.62 : 0.05,
  classification: status === "conflict" ? "scope_expansion" : "aligned",
  rationale: status === "conflict" ? "An unrelated receipt helper was added." : "Fits the task.",
  conflictingPaths: status === "conflict" ? ["src/receipt.js"] : [],
  approvalsApplied: [],
  monitorUsage: { inputTokens: 100, outputTokens: 20, durationMs: 5 },
  ...extra,
});

/** A monitor that marks effects mentioning `conflicting` paths, citing `approvalRef` where given. */
function scriptedMonitor(verdicts: Record<string, { approvalRef?: string }>): SemanticIntentMonitor {
  return {
    assess: async (input) => {
      const effectAssessments = (input.proposedEffects ?? []).map((effect) => {
        const hit = Object.entries(verdicts).find(([path]) => effect.summary.includes(` ${path} `));
        return {
          index: effect.index,
          riskScore: hit ? 0.6 : 0.05,
          classification: hit ? "scope_expansion" as const : "aligned" as const,
          conflictsWithTask: hit !== undefined,
          evidenceSeqs: [],
          approvalRef: hit?.[1].approvalRef ?? "",
        };
      });
      const conflict = effectAssessments.some((item) => item.conflictsWithTask);
      return {
        riskScore: conflict ? 0.6 : 0.05,
        confidence: 0.9,
        classification: conflict ? "scope_expansion" : "aligned",
        apparentObjective: "Checkout discounts",
        conflictsWithTask: conflict,
        evidenceSeqs: [],
        rationale: conflict ? "Release work was added." : "Fits the task.",
        effectAssessments,
      };
    },
  };
}

const realReviewer = (monitor: SemanticIntentMonitor): RunDiffReviewer => ({
  review: (input) => reviewFinalRunDiff(monitor, { ...input, userPrompt: input.run.userPrompt }),
});

async function start(options: Parameters<typeof startHarness>[0], script: ScriptStep = {}) {
  harness = startHarness({ script: { [PROMPT]: script }, ...options });
  const run = await harness.orchestrator.createRun({
    workspaceId: WORKSPACE_ID,
    createdByUserId: USER_ID,
    userPrompt: PROMPT,
    orchestrationMode: "single",
    agentId: AGENTS.developer,
  });
  return { run, events: harness.record(run.id) };
}

async function settle(runId: string, events: ReturnType<Harness["record"]>): Promise<RunSnapshot> {
  await harness.orchestrator.whenSettled(runId);
  const snapshot = harness.store.snapshot(runId)!;
  expect(checkRunInvariants(runId, events, snapshot)).toEqual([]);
  return snapshot;
}

async function approveEach(runId: string, count: number): Promise<Approval[]> {
  const answered: Approval[] = [];
  for (let index = 0; index < count; index += 1) {
    const pending = await waitFor(async () => (await harness.store.listApprovals(runId)).find((approval) => approval.status === "pending"));
    answered.push(await harness.orchestrator.resolveApproval(pending.id, "approve", USER_ID));
  }
  return answered;
}

describe("final review outcomes", () => {
  it("completes an aligned Run and saves the successful review on it", async () => {
    const { run, events } = await start({
      diff: async () => diffOf([change("src/pricing.js", "+export const discount = 1;")]),
      finalDiffReviewer: { review: async () => outcome("aligned") },
    });
    const snapshot = await settle(run.id, events);
    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.run.finalReview).toMatchObject({ status: "aligned", findingId: null, coverage: { assessedEffects: 1 }, monitorUsage: { inputTokens: 100 } });
    expect(snapshot.findings.filter((finding) => finding.check === "semantic-final-diff")).toEqual([]);
  });

  it("fails a conflicting Run with a linked finding, and the next Run does not start from it", async () => {
    let next = outcome("aligned");
    const first = await start({
      diff: async () => diffOf([change("src/pricing.js", "+export const discount = 1;")]),
      finalDiffReviewer: { review: async () => next },
    });
    await settle(first.run.id, first.events);

    next = outcome("conflict");
    const createRun = (userPrompt: string) =>
      harness.orchestrator.createRun({ workspaceId: WORKSPACE_ID, createdByUserId: USER_ID, userPrompt, orchestrationMode: "single", agentId: AGENTS.developer });
    const conflicting = await createRun(PROMPT);
    expect(conflicting.parentRunId).toBe(first.run.id);
    const failed = await settle(conflicting.id, harness.record(conflicting.id));
    expect(failed.run.status).toBe("failed");
    expect(failed.run.error).toMatch(/^Final review: .*scope_expansion, risk 0\.62.*tasks finished.*not seed follow-up/);
    const finding = failed.findings.find((candidate) => candidate.code === "semantic-final-scope-expansion")!;
    expect(finding).toMatchObject({ intervened: true, severity: "medium", evidence: expect.objectContaining({ status: "conflict", paths: ["src/receipt.js"] }) });
    expect(failed.run.finalReview).toMatchObject({ status: "conflict", findingId: finding.id });
    expect(failed.tasks.every((task) => task.status === "completed")).toBe(true);

    // The failed Run keeps its artifacts but is never a parent: the next Run starts from the first.
    next = outcome("aligned");
    const followUp = await createRun("Add tests for the discount");
    expect(followUp.parentRunId).toBe(first.run.id);
    await settle(followUp.id, harness.record(followUp.id));
  });

  it("fails closed on incomplete coverage without calling the reviewer's model", async () => {
    let calls = 0;
    const monitor: SemanticIntentMonitor = { assess: async () => { calls += 1; throw new Error("must not be called"); } };
    const { run, events } = await start({
      diff: async () => diffOf([change("logo.png", "")], { coverage: { inventory: { status: "incomplete", reasons: ["final_scan_incomplete"], baseline: null, final: null }, content: { status: "complete", changedEntries: 1, completeEntries: 1 } } }),
      finalDiffReviewer: realReviewer(monitor),
    });
    const snapshot = await settle(run.id, events);
    expect(snapshot.run.status).toBe("failed");
    expect(snapshot.run.finalReview).toMatchObject({ status: "incomplete", reasons: ["inventory_incomplete"] });
    expect(snapshot.findings).toContainEqual(expect.objectContaining({ code: "semantic-final-diff-incomplete", intervened: true }));
    expect(calls).toBe(0);
  });

  it("fails closed when the monitor or the diff is unavailable", async () => {
    const failing: SemanticIntentMonitor = { assess: async () => { throw new Error("timed out"); } };
    let { run, events } = await start({ diff: async () => diffOf([change("a.js", "+a")]), finalDiffReviewer: realReviewer(failing) });
    let snapshot = await settle(run.id, events);
    expect(snapshot.run).toMatchObject({ status: "failed", finalReview: { status: "unavailable", reasons: ["monitor_error"] } });
    expect(snapshot.run.error).toMatch(/^Final review unavailable/);

    ({ run, events } = await start({ diff: async () => { throw new Error("disk"); }, finalDiffReviewer: { review: async () => outcome("aligned") } }));
    snapshot = await settle(run.id, events);
    expect(snapshot.run).toMatchObject({ status: "failed", finalReview: { status: "unavailable", reasons: ["diff_error"] } });
  });

  it("records a disabled review on a completed Run, and not_run on a failed one", async () => {
    let { run, events } = await start({});
    let snapshot = await settle(run.id, events);
    expect(snapshot.run).toMatchObject({ status: "completed", finalReview: { status: "disabled", reasons: ["semantic_review_disabled"] } });

    ({ run, events } = await start({ finalDiffReviewer: { review: async () => outcome("aligned") }, diff: async () => diffOf([]) }, { disposition: "incomplete" }));
    snapshot = await settle(run.id, events);
    expect(snapshot.run).toMatchObject({ status: "failed", finalReview: { status: "not_run", reasons: ["run_failed"] } });
  });

  it("marks the ledger incomplete past its bound instead of dropping the earliest actions", async () => {
    const commands = Array.from({ length: 49 }, (_, index) => ({ type: "command" as const, command: `touch file-${index}`, cwd: null }));
    let ledger: string[] = [];
    let truncated: boolean | null = null;
    const { run, events } = await start({
      diff: async () => diffOf([change("file-0", "+")]),
      finalDiffReviewer: {
        review: async (input) => {
          ledger = input.reviewedActions.map((action) => action.summary);
          truncated = input.actionLedgerTruncated;
          return reviewFinalRunDiff(scriptedMonitor({}), { ...input, userPrompt: PROMPT });
        },
      },
    }, { actions: commands });
    const snapshot = await settle(run.id, events);
    expect(ledger).toHaveLength(48);
    expect(ledger[0]).toContain("touch file-0");
    expect(truncated).toBe(true);
    expect(snapshot.run.finalReview).toMatchObject({ status: "incomplete", reasons: ["action_ledger_incomplete"] });
  });
});

describe("final review and exact approvals", () => {
  const bump = { type: "file_change" as const, changes: [{ path: "package.json", kind: "update" as const, movePath: null, diff: '-  "version": "1.0.0"\n+  "version": "1.0.1"' }] };
  const bumpHunk = change("package.json", '-  "version": "1.0.0"\n+  "version": "1.0.1"', "modified");
  const changelogHunk = change("CHANGELOG.md", "+## 1.0.1");

  it("completes when the only out-of-scope change is exactly the approved proposal", async () => {
    const { run, events } = await start({
      diff: async () => diffOf([bumpHunk]),
      finalDiffReviewer: realReviewer(scriptedMonitor({ "package.json": { approvalRef: "A1" } })),
    }, { actions: [bump] });
    const [approved] = await approveEach(run.id, 1);
    expect(approved!.safeDetails).toMatchObject({ complete: true, files: [{ path: "package.json", diffComplete: true }] });
    const snapshot = await settle(run.id, events);
    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.run.finalReview).toMatchObject({ status: "aligned", approvalsApplied: [approved!.id] });
  });

  it("matches an approval of the runtime's /workspace/... editor path to the copy-relative diff", async () => {
    const containerBump = { ...bump, changes: [{ ...bump.changes[0]!, path: "/workspace/package.json" }] };
    const { run, events } = await start({
      diff: async () => diffOf([bumpHunk]),
      finalDiffReviewer: realReviewer(scriptedMonitor({ "package.json": { approvalRef: "A1" } })),
    }, { actions: [containerBump] });
    const [approved] = await approveEach(run.id, 1);
    const snapshot = await settle(run.id, events);
    expect(snapshot.run).toMatchObject({ status: "completed", finalReview: { status: "aligned", approvalsApplied: [approved!.id] } });
  });

  it("fails when an unapproved change rides along with the approved one", async () => {
    const { run, events } = await start({
      diff: async () => diffOf([changelogHunk, bumpHunk]),
      finalDiffReviewer: realReviewer(scriptedMonitor({ "package.json": { approvalRef: "A1" }, "CHANGELOG.md": {} })),
    }, { actions: [bump, { type: "command", command: "echo '## 1.0.1' >> CHANGELOG.md", cwd: null }] });
    await approveEach(run.id, 1);
    const snapshot = await settle(run.id, events);
    expect(snapshot.run.status).toBe("failed");
    expect(snapshot.run.finalReview).toMatchObject({ status: "conflict", conflictingPaths: ["CHANGELOG.md"], approvalsApplied: [snapshot.approvals[0]!.id] });
  });

  it("grants nothing for a denied approval even if the change appears anyway", async () => {
    const { run, events } = await start({
      diff: async () => diffOf([bumpHunk]),
      finalDiffReviewer: realReviewer(scriptedMonitor({ "package.json": { approvalRef: "A1" } })),
    }, { actions: [bump] });
    const pending = await waitFor(async () => (await harness.store.listApprovals(run.id)).find((approval) => approval.status === "pending"));
    await harness.orchestrator.resolveApproval(pending.id, "deny", USER_ID);
    const snapshot = await settle(run.id, events);
    expect(snapshot.run.finalReview).toMatchObject({ status: "conflict", approvalsApplied: [], reasons: ["scope_conflict", "approval_unmatched"] });
  });

  it("refuses to approve a held action with no saved proposal, but still lets it be denied", async () => {
    /** Saves approvals as older rows did when details were missing. */
    class DetailLessStore extends InMemoryRunStore {
      override async requestApproval(...[approval, audit]: Parameters<InMemoryRunStore["requestApproval"]>): Promise<Approval> {
        return super.requestApproval({ ...approval, safeDetails: null }, audit);
      }
    }
    const { run, events } = await start({ store: (hub) => new DetailLessStore(hub) }, { actions: [bump] });
    const pending = await waitFor(async () => (await harness.store.listApprovals(run.id)).find((approval) => approval.status === "pending"));
    await expect(harness.orchestrator.resolveApproval(pending.id, "approve", USER_ID)).rejects.toMatchObject({ statusCode: 409 });
    await harness.orchestrator.resolveApproval(pending.id, "deny", USER_ID);
    expect((await settle(run.id, events)).approvals[0]!.status).toBe("denied");
  });
});

describe("final review and cancellation", () => {
  it("does not hold a cancel behind a slow review, and never completes afterwards", async () => {
    let started!: () => void;
    const reviewStarted = new Promise<void>((resolve) => { started = resolve; });
    let sawAbort = false;
    const { run, events } = await start({
      diff: async () => diffOf([change("a.js", "+a")]),
      finalDiffReviewer: {
        review: ({ signal }) => new Promise((_, reject) => {
          started();
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted"));
          }, { once: true });
        }),
      },
    });
    await reviewStarted;
    const cancelled = await harness.orchestrator.cancel(run.id, USER_ID);
    expect(cancelled.cancelRequestedAt).not.toBeNull();
    const snapshot = await settle(run.id, events);
    expect(sawAbort).toBe(true);
    expect(snapshot.run.status).toBe("cancelled");
    expect(snapshot.run.finalReview).toMatchObject({ status: "not_run", reasons: ["run_cancelled"] });
  });

  it("ends cancelled when the review returns aligned after the cancel was requested", async () => {
    let finish!: (value: FinalReviewOutcome) => void;
    let started!: () => void;
    const reviewStarted = new Promise<void>((resolve) => { started = resolve; });
    const { run, events } = await start({
      diff: async () => diffOf([change("a.js", "+a")]),
      // Ignores the abort signal, like a reviewer that finishes regardless.
      finalDiffReviewer: { review: () => new Promise((resolve) => { started(); finish = resolve; }) },
    });
    await reviewStarted;
    await harness.orchestrator.cancel(run.id, USER_ID);
    finish(outcome("aligned"));
    const snapshot = await settle(run.id, events);
    expect(snapshot.run.status).toBe("cancelled");
    expect(snapshot.run.finalReview?.status).toBe("not_run");
  });
});

import { describe, expect, it } from "vitest";
import type { RunTimeline, RunTimelineEntry } from "@launchpad/shared";
import { describeEntry, describeFileDecision, fileListLimits, freshEntryIds, heldProposals, type Names } from "./timeline-view";

const names: Names = {
  task: (id) => `task ${id}`,
  writtenByPlan: () => true,
  agent: (id) => `agent ${id}`,
};

const approval = (status: NonNullable<RunTimelineEntry["approval"]>["status"]): RunTimelineEntry["approval"] => ({
  id: "approval-1",
  status,
  reason: "policy_required",
  requestedAt: "2026-10-31T10:00:00.000Z",
  expiresAt: null,
  resolvedAt: null,
  resolvedByUserId: null,
});

const entry = (overrides: Partial<RunTimelineEntry>): RunTimelineEntry => ({
  id: "entry-1",
  at: "2026-10-31T10:00:00.000Z",
  taskId: "task-1",
  executionId: "execution-1",
  agentId: "agent-1",
  source: "evaluated",
  actionType: "command",
  actionId: "action-1",
  proposed: { type: "command", command: "npm test", cwd: null },
  decision: "allow",
  reason: "Inside the workspace.",
  severity: null,
  stop: null,
  findingCodes: [],
  approval: null,
  ...overrides,
});

describe("describeEntry", () => {
  it("keeps the proposal separate from the trusted decision", () => {
    const view = describeEntry(entry({}), names);
    expect(view).toMatchObject({ caption: "Command", proposal: "npm test", missing: null, decision: "allow", heldApprovalId: null });
  });

  it("says a command's text was not saved, rather than showing nothing", () => {
    const view = describeEntry(entry({ proposed: null, decision: "block" }), names);
    expect(view.proposal).toBeNull();
    expect(view.missing).toBe("The command text was not saved.");
    expect(view.decision).toBe("block");
  });

  it("names an action noticed in the agent's activity, which has no action type", () => {
    const view = describeEntry(entry({ source: "observed", actionType: null, proposed: null }), names);
    expect(view.caption).toBe("Noticed in the agent's activity");
    expect(view.missing).toBe("The action's details were not saved.");
  });

  it("treats require_approval with a pending approval as held", () => {
    const view = describeEntry(entry({ decision: "require_approval", approval: approval("pending") }), names);
    expect(view).toMatchObject({ decision: "require_approval", decisionLabel: "Held for your approval", heldApprovalId: "approval-1" });
  });

  it.each(["approved", "denied", "timed_out"] as const)("says the action did not run when a %s approval never took effect", (status) => {
    const view = describeEntry(entry({ decision: "require_approval", approval: approval(status) }), names);
    expect(view.decision).toBeNull();
    expect(view.decisionLabel).toBe("Did not run");
    expect(view.heldApprovalId).toBeNull();
    expect(view.notes).toContain("The run ended before an answer took effect.");
  });

  it("says the action did not run when no approval is left", () => {
    expect(describeEntry(entry({ decision: "require_approval", approval: null }), names).decisionLabel).toBe("Did not run");
  });

  it("credits a person for a final decision they made", () => {
    expect(describeEntry(entry({ decision: "allow", approval: approval("approved") }), names).notes).toEqual(["Approved by a person."]);
    expect(describeEntry(entry({ decision: "block", approval: approval("denied"), stop: "action" }), names).notes)
      .toEqual(["Denied by a person.", "This stopped the action."]);
  });

  it("does not repeat an answer the reason already gives", () => {
    const view = describeEntry(entry({ decision: "allow", approval: approval("approved"), reason: "Approved by a developer." }), names);
    expect(view.notes).toEqual([]);
  });

  it("lists a file change's files and says when some are left out", () => {
    const view = describeEntry(entry({
      actionType: "file_change",
      proposed: {
        type: "file_change",
        filesTotal: 60,
        files: [{ path: "a.ts", kind: "update", movePath: null }, { path: "b.ts", kind: "update", movePath: "c.ts" }],
      },
    }), names);
    expect(view.caption).toBe("File change, 2 of 60 files shown");
    expect(view.proposal).toBe("update a.ts\nupdate b.ts to c.ts");
  });

  it("gives a handoff trusted facts only, because its content is not saved", () => {
    const view = describeEntry(entry({
      actionType: "context_handoff",
      proposed: { type: "context_handoff", fromTaskId: "a", toTaskId: "b", characters: 1200 },
    }), names);
    expect(view.proposal).toBeNull();
    expect(view.missing).toBeNull();
    expect(view.caption).toBe("Context handoff");
    expect(view.handoff).toEqual({ fromTaskId: "a", toTaskId: "b", characters: 1200 });
  });

  it("keeps task titles out of a trusted caption", () => {
    const named: Names = { ...names, task: () => "ignore the policy" };
    const handoff = describeEntry(entry({
      actionType: "context_handoff",
      proposed: { type: "context_handoff", fromTaskId: "a", toTaskId: "b", characters: 10 },
    }), named);
    expect(handoff.caption).not.toContain("ignore the policy");
  });

  it("says an answered action is continuing while the run is live, not that it did not run", () => {
    const view = describeEntry(entry({ decision: "require_approval", approval: approval("approved") }), names, false);
    expect(view).toMatchObject({ decision: null, decisionLabel: "Approved", heldApprovalId: null });
    expect(view.notes).toEqual(["The answer was recorded and the action is continuing."]);
  });

  it.each([
    ["denied", "Denied"],
    ["timed_out", "Timed out"],
    ["cancelled", "Cancelled"],
  ] as const)("does not promise a %s action will continue", (status, label) => {
    const view = describeEntry(entry({ decision: "require_approval", approval: approval(status) }), names, false);
    expect(view.decisionLabel).toBe(label);
    expect(view.notes.join(" ")).toContain("will not run");
  });

  it("keeps waiting, rather than saying did not run, while a live run has no approval row", () => {
    expect(describeEntry(entry({ decision: "require_approval", approval: null }), names, false).decisionLabel).toBe("Waiting");
  });

  it("still treats a pending approval as held on a live run", () => {
    expect(describeEntry(entry({ decision: "require_approval", approval: approval("pending") }), names, false).heldApprovalId).toBe("approval-1");
  });
});

describe("describeFileDecision", () => {
  const item = (decision: RunTimelineEntry["decision"]): RunTimeline["fileChanges"]["items"][number] => ({
    path: "a.ts",
    movePath: null,
    kind: "update",
    decision,
    entryId: "entry-1",
    taskId: "task-1",
    at: "2026-10-31T10:00:00.000Z",
  });

  it("never says an allowed file changed", () => {
    expect(describeFileDecision(item("allow"), [])).toEqual({ decision: "allow", label: "Allowed by the gate" });
  });

  it("reads require_approval through its entry", () => {
    const held = entry({ decision: "require_approval", approval: approval("pending") });
    expect(describeFileDecision(item("require_approval"), [held]).label).toBe("Held");
    const ended = entry({ decision: "require_approval", approval: approval("timed_out") });
    expect(describeFileDecision(item("require_approval"), [ended])).toEqual({ decision: null, label: "Did not run" });
    expect(describeFileDecision(item("require_approval"), []).label).toBe("Did not run");
  });

  it("only says did not run once the run has ended", () => {
    const answered = entry({ decision: "require_approval", approval: approval("approved") });
    expect(describeFileDecision(item("require_approval"), [answered], false)).toEqual({ decision: null, label: "Approved" });
    expect(describeFileDecision(item("require_approval"), [], false).label).toBe("Waiting");
  });
});

describe("fileListLimits", () => {
  it("is empty for a complete list", () => {
    expect(fileListLimits({ items: [], truncated: false, entriesWithoutFileList: 0, allowedCommands: 0 })).toEqual([]);
  });

  it("states each gap", () => {
    const limits = fileListLimits({ items: [], truncated: true, entriesWithoutFileList: 2, allowedCommands: 1 });
    expect(limits).toEqual([
      "More files were proposed than are listed here.",
      "2 file changes have no saved file list, so their files are missing here.",
      "1 command was allowed to run. Any files it changed are not listed.",
    ]);
  });
});

describe("freshEntryIds", () => {
  it("marks nothing on the first load", () => {
    expect(freshEntryIds(null, new Set(), [{ id: "a" }]).size).toBe(0);
  });

  it("marks what arrived later and keeps earlier marks, so a mark draws once", () => {
    const first = freshEntryIds(new Set(["a"]), new Set(), [{ id: "a" }, { id: "b" }]);
    expect([...first]).toEqual(["b"]);
    const second = freshEntryIds(new Set(["a", "b"]), first, [{ id: "a" }, { id: "b" }]);
    expect(second).toBe(first);
  });
});

describe("heldProposals", () => {
  const held = { decision: "require_approval", approval: approval("pending") } as const;

  it("gives what a held action proposes, by approval id", () => {
    const proposals = heldProposals([entry(held)], names);
    expect(proposals.get("approval-1")).toBe("npm test");
  });

  it("leaves out an answered action", () => {
    expect(heldProposals([entry({ decision: "require_approval", approval: approval("approved") })], names).size).toBe(0);
    expect(heldProposals([entry({ decision: "allow", approval: approval("approved") })], names).size).toBe(0);
  });

  it("leaves out a held action whose proposal was not saved, so nobody answers it blind", () => {
    expect(heldProposals([entry({ ...held, proposed: null })], names).size).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import type { TraceRecord } from "../../src/trace.js";
import { REFUSED_PREFIX, TrajectoryState } from "../../src/trajectory-state.js";

function completed(seq: number, item: Record<string, unknown>): TraceRecord {
  return { seq, at: "2026-11-21T00:00:00.000Z", dir: "in", method: "item/completed", payload: { method: "item/completed", params: { item } } };
}

describe("TrajectoryState", () => {
  it("marks refused actions so the reviewer does not read them as having run", () => {
    const state = new TrajectoryState({ userPrompt: "Add divide.", agentInstructions: "" });
    state.sync([
      completed(1, { id: "c1", type: "commandExecution", command: "npm test", status: "completed", aggregatedOutput: "ok" }),
      completed(2, { id: "c2", type: "commandExecution", command: "sed -i s/1.0.0/1.0.1/ package.json", status: "declined", aggregatedOutput: null }),
      completed(3, { id: "f1", type: "fileChange", status: "declined", changes: [{ path: "/workspace/CHANGELOG.md", kind: { type: "add" }, diff: "+x" }] }),
    ]);

    const [ran, refusedCommand, refusedFile] = state.monitorInput("command", false).recentActions;
    expect(ran!.summary.startsWith(REFUSED_PREFIX)).toBe(false);
    expect(refusedCommand!.summary.startsWith(REFUSED_PREFIX)).toBe(true);
    expect(refusedFile!.summary.startsWith(REFUSED_PREFIX)).toBe(true);
  });
});

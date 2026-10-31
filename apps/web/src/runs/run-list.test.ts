import { describe, expect, it } from "vitest";
import type { RunListResponse, RunSummary } from "@launchpad/shared";
import { appendRunPage, refreshRunList, statusFromSearch } from "./run-list";

const run = (id: string, createdAt: string): RunSummary => ({
  id,
  workspaceId: "w",
  createdByUserId: "u",
  orchestrationMode: "auto",
  status: "completed",
  cancelRequestedAt: null,
  createdAt,
  updatedAt: createdAt,
  startedAt: createdAt,
  completedAt: createdAt,
  userPrompt: id,
  taskCount: 1,
  pendingApprovalCount: 0,
  findingCount: 0,
});

const page = (runs: RunSummary[], nextCursor: string | null): RunListResponse => ({ runs, nextCursor, pendingApprovalCount: 0 });

const at = (minute: number) => `2026-10-31T10:${String(minute).padStart(2, "0")}:00.000Z`;
const ids = (state: { runs: RunSummary[] }) => state.runs.map((item) => item.id);

describe("appendRunPage", () => {
  it("adds the page and moves the cursor on, without repeating a run", () => {
    const state = { runs: [run("c", at(3)), run("b", at(2))], nextCursor: "one" };
    const next = appendRunPage(state, page([run("b", at(2)), run("a", at(1))], null));
    expect(ids(next)).toEqual(["c", "b", "a"]);
    expect(next.nextCursor).toBeNull();
  });
});

describe("refreshRunList", () => {
  it("replaces a list that is only the first page", () => {
    const state = { runs: [run("b", at(2))], nextCursor: null };
    const next = refreshRunList(state, page([run("c", at(3)), run("b", at(2))], null));
    expect(ids(next)).toEqual(["c", "b"]);
  });

  it("keeps pages loaded beyond the first, and the cursor that continues them", () => {
    const state = { runs: [run("c", at(3)), run("b", at(2)), run("a", at(1))], nextCursor: "two" };
    const next = refreshRunList(state, page([run("d", at(4)), run("c", at(3))], "fresh"));
    expect(ids(next)).toEqual(["d", "c", "b", "a"]);
    expect(next.nextCursor).toBe("two");
  });

  it("drops a run that has left the first page's range, as one leaving a status filter does", () => {
    const state = { runs: [run("c", at(3)), run("b", at(2))], nextCursor: "one" };
    const next = refreshRunList(state, page([run("c", at(3))], null));
    expect(ids(next)).toEqual(["c"]);
    expect(next.nextCursor).toBeNull();
  });

  it("takes the fresh cursor when nothing older is held", () => {
    const state = { runs: [run("c", at(3))], nextCursor: "old" };
    expect(refreshRunList(state, page([run("c", at(3))], "fresh")).nextCursor).toBe("fresh");
  });
});

describe("statusFromSearch", () => {
  it("reads a known status and ignores anything else", () => {
    expect(statusFromSearch("?status=waiting_approval")).toBe("waiting_approval");
    expect(statusFromSearch("?status=nonsense")).toBeNull();
    expect(statusFromSearch("")).toBeNull();
  });
});

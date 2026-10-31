import { RUN_ID } from "../router";

// Runs you started in this browser. There is no "list runs" route in the
// contract yet (the Dashboard is P4's), so this is a per-browser convenience
// and may be empty: storage can be unavailable or cleared.

export interface RecentRun {
  id: string;
  prompt: string;
  createdAt: string;
}

const RECENT_KEY = "agentguard.recentRuns";

export function readRecentRuns(): RecentRun[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is RecentRun => typeof item?.id === "string" && RUN_ID.test(item.id)).slice(0, 10)
      : [];
  } catch {
    return [];
  }
}

/** Drop a run the server no longer knows, so its link does not stay as a dead end. */
export function forgetRun(runId: string): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(readRecentRuns().filter((item) => item.id !== runId)));
  } catch {
    // Storage unavailable: nothing to forget.
  }
}

export function rememberRun(run: RecentRun): void {
  try {
    const next = [run, ...readRecentRuns().filter((item) => item.id !== run.id)].slice(0, 10);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked or full: the list is a convenience only.
  }
}

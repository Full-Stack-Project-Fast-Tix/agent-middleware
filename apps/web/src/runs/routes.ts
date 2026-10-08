import { useEffect, useState } from "react";

// Runs pages live under the URL hash, so a Run Detail link can be shared and
// the back button works, without adding a router dependency. P4's app shell
// can replace this when it lands.

export type RunsRoute = { page: "new" } | { page: "run"; runId: string };

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRunsHash(hash: string): RunsRoute | null {
  const path = hash.replace(/^#/, "");
  if (path === "/runs" || path === "/runs/" || path === "/runs/new") return { page: "new" };
  const match = /^\/runs\/([^/?#]+)$/.exec(path);
  if (match && RUN_ID.test(match[1]!)) return { page: "run", runId: match[1]! };
  return null;
}

export const runHash = (runId: string): string => `#/runs/${runId}`;
export const NEW_RUN_HASH = "#/runs/new";

export function navigate(hash: string): void {
  if (window.location.hash !== hash) window.location.hash = hash;
}

export function useRunsRoute(): RunsRoute | null {
  const [route, setRoute] = useState(() => parseRunsHash(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRunsHash(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

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

export function rememberRun(run: RecentRun): void {
  try {
    const next = [run, ...readRecentRuns().filter((item) => item.id !== run.id)].slice(0, 10);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked or full: the list is a convenience only.
  }
}

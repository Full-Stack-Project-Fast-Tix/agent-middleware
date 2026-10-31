import { runStatusSchema, type RunListResponse, type RunStatus, type RunSummary } from "@launchpad/shared";

// The list of a workspace's runs, as pages from the server. Pure, so it is
// tested without a DOM.

export interface RunListState {
  runs: RunSummary[];
  nextCursor: string | null;
}

/** Add the next page, dropping a run the first pages already hold. */
export function appendRunPage(state: RunListState, page: RunListResponse): RunListState {
  const known = new Set(state.runs.map((run) => run.id));
  return {
    runs: [...state.runs, ...page.runs.filter((run) => !known.has(run.id))],
    nextCursor: page.nextCursor,
  };
}

/**
 * Apply a fresh first page. It is the truth for everything down to its oldest
 * row, including a run that has left a status filter. Pages loaded beyond that
 * are kept as they are, along with the cursor that continues them.
 */
export function refreshRunList(state: RunListState, firstPage: RunListResponse): RunListState {
  if (firstPage.nextCursor === null) return { runs: firstPage.runs, nextCursor: null };
  const oldest = firstPage.runs.at(-1);
  if (oldest === undefined) return { runs: [], nextCursor: null };
  const fresh = new Set(firstPage.runs.map((run) => run.id));
  const older = state.runs.filter((run) => !fresh.has(run.id) && run.createdAt < oldest.createdAt);
  return older.length === 0
    ? { runs: firstPage.runs, nextCursor: firstPage.nextCursor }
    : { runs: [...firstPage.runs, ...older], nextCursor: state.nextCursor };
}

/** The status in a /runs link, or null for all statuses. An unknown value counts as none. */
export function statusFromSearch(search: string): RunStatus | null {
  const parsed = runStatusSchema.safeParse(new URLSearchParams(search).get("status"));
  return parsed.success ? parsed.data : null;
}

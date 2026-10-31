import { useCallback, useEffect, useRef, useState } from "react";
import type { RunStatus } from "@launchpad/shared";
import { appendRunPage, refreshRunList, type RunListState } from "./run-list";
import { runsApi } from "./runs-api";

const REFRESH_MS = 5000;

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/**
 * A workspace's runs, refreshed while the page is open. A failed refresh keeps
 * the last list on screen and reports the error, so a dropped connection does not
 * blank the page.
 */
export function useRunList(workspaceId: string | null, options: { limit: number; status?: RunStatus }) {
  const { limit, status } = options;
  const [list, setList] = useState<RunListState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // A response for an earlier workspace or filter must not land on this one.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (workspaceId === null) return;
    const current = generation.current;
    try {
      const page = await runsApi.listRuns(workspaceId, { limit, status });
      if (current !== generation.current) return;
      setList((previous) => (previous === null ? page : refreshRunList(previous, page)));
      setError(null);
    } catch (reason) {
      if (current === generation.current) setError(message(reason));
    }
  }, [limit, status, workspaceId]);

  useEffect(() => {
    generation.current += 1;
    setList(null);
    setError(null);
    setLoadingMore(false);
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    const cursor = list?.nextCursor;
    if (workspaceId === null || cursor === null || cursor === undefined) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await runsApi.listRuns(workspaceId, { limit, status, cursor });
      if (current !== generation.current) return;
      setList((previous) => (previous === null ? page : appendRunPage(previous, page)));
      setError(null);
    } catch (reason) {
      if (current === generation.current) setError(message(reason));
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  }, [limit, list?.nextCursor, status, workspaceId]);

  return { list, error, loadingMore, loadMore, refresh };
}

const APPROVALS_CHANGED = "agentguard:approvals-changed";

/** Tell the Held count an approval was answered, rather than leaving it until the next poll. */
export function announceApprovalsChanged(): void {
  window.dispatchEvent(new Event(APPROVALS_CHANGED));
}

/**
 * Pending approvals across the workspace, for the top bar. Null until counted,
 * and again if counting fails: the bar must not claim a number it does not know.
 */
export function useHeldCount(workspaceId: string | null): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    setCount(null);
    if (workspaceId === null) return;
    let mounted = true;
    const load = () => {
      runsApi
        .listRuns(workspaceId, { limit: 1 })
        .then((page) => {
          if (mounted) setCount(page.pendingApprovalCount);
        })
        .catch(() => {
          if (mounted) setCount(null);
        });
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener(APPROVALS_CHANGED, load);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      window.removeEventListener(APPROVALS_CHANGED, load);
    };
  }, [workspaceId]);

  return count;
}

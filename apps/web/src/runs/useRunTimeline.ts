import { useCallback, useEffect, useRef, useState } from "react";
import type { RunTimeline } from "@launchpad/shared";
import { runsApi } from "./runs-api";
import { freshEntryIds } from "./timeline-view";

const ACTIVE_REFRESH_MS = 3000;

/**
 * A Run's saved gate decisions. The timeline is not pushed: an action allowed
 * without a person publishes no event. So this refetches on every Run event, by
 * way of `lastEventSeq`, and on a timer while the Run is active.
 */
export function useRunTimeline(runId: string, active: boolean, lastEventSeq: number) {
  const [timeline, setTimeline] = useState<RunTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const known = useRef<ReadonlySet<string> | null>(null);
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    try {
      const next = await runsApi.timeline(runId);
      // An older response arriving late must not undo a newer one.
      if (request !== latestRequest.current) return;
      const before = known.current;
      known.current = new Set(next.entries.map((entry) => entry.id));
      setFresh((previous) => freshEntryIds(before, previous, next.entries));
      setTimeline(next);
      setError(null);
    } catch (reason) {
      if (request === latestRequest.current) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [lastEventSeq, load]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), ACTIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  return { timeline, error, fresh, reload: load };
}

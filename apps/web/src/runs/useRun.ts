import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { forgetRun } from "./routes";
import { runsApi } from "./runs-api";
import { applyRunEvent, viewFromSnapshot, type RunView } from "./run-view";

/**
 * A Run kept live: load the snapshot, then follow its events from the
 * snapshot's lastEventSeq. The shared client reconnects after a dropped
 * connection and asks for a fresh snapshot when the server cannot replay.
 */
export function useRun(runId: string): { view: RunView | null; error: string | null } {
  const [view, setView] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let current: RunView | null = null;
    const show = (next: RunView) => {
      current = next;
      setView(next);
    };
    setView(null);
    setError(null);

    void (async () => {
      try {
        const snapshot = await runsApi.snapshot(runId);
        if (controller.signal.aborted) return;
        show(viewFromSnapshot(snapshot));
        await runsApi.follow(
          runId,
          snapshot.lastEventSeq,
          {
            onEvent: (event) => {
              if (current !== null) show(applyRunEvent(current, event));
            },
            onResync: async () => {
              const fresh = await runsApi.snapshot(runId);
              show(viewFromSnapshot(fresh));
              return fresh.lastEventSeq;
            },
          },
          controller.signal,
        );
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.status === 404) {
          forgetRun(runId);
          setError("This run no longer exists. If the server was restarted, runs kept only in memory are gone.");
          return;
        }
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();

    return () => controller.abort();
  }, [runId]);

  return { view, error };
}

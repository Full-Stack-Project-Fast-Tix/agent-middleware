import { useCallback, useEffect, useRef, useState } from "react";

// Evidence pages load several things per Run. When the route changes before an
// answer arrives, the old answer must not appear under the new Run. Every load
// takes a ticket; only the newest ticket may publish.

export type Loadable<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

/** Hands out tickets; only the latest one is current. Cancelling makes every outstanding ticket stale. */
export class LatestRequest {
  private current = 0;

  begin(): number {
    this.current += 1;
    return this.current;
  }

  isCurrent(ticket: number): boolean {
    return ticket === this.current;
  }

  cancel(): void {
    this.current += 1;
  }
}

/** Run `load`, publishing loading, then its value or error, unless a newer load or a cancel came first. */
export async function loadLatest<T>(gate: LatestRequest, load: () => Promise<T>, publish: (state: Loadable<T>) => void): Promise<void> {
  const ticket = gate.begin();
  publish({ status: "loading" });
  try {
    const value = await load();
    if (gate.isCurrent(ticket)) publish({ status: "ready", value });
  } catch (reason) {
    if (gate.isCurrent(ticket)) publish({ status: "error", message: reason instanceof Error ? reason.message : String(reason) });
  }
}

/**
 * Load whenever `key` changes (null loads nothing), dropping answers for any
 * earlier key. `reload` retries the current key.
 */
export function useLatest<T>(key: string | null, load: (key: string) => Promise<T>): { state: Loadable<T>; reload: () => void } {
  const gate = useRef(new LatestRequest());
  const loader = useRef(load);
  loader.current = load;
  const [state, setState] = useState<Loadable<T>>({ status: "idle" });

  const run = useCallback((current: string | null) => {
    if (current === null) {
      gate.current.cancel();
      setState({ status: "idle" });
      return;
    }
    void loadLatest(gate.current, () => loader.current(current), setState);
  }, []);

  useEffect(() => {
    run(key);
    const owned = gate.current;
    return () => owned.cancel();
  }, [key, run]);

  return { state, reload: () => run(key) };
}

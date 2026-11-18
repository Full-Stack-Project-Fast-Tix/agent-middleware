import { describe, expect, it } from "vitest";
import { LatestRequest, loadLatest, type Loadable } from "./latest-request";

/** A promise this test settles by hand, to replay answers in any order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("only the newest Run's evidence is shown", () => {
  it("drops Run A's diff when it arrives after the page moved to Run B", async () => {
    const gate = new LatestRequest();
    const shown: Array<Loadable<string>> = [];
    const runA = deferred<string>();
    const runB = deferred<string>();

    void loadLatest(gate, () => runA.promise, (state) => shown.push(state));
    void loadLatest(gate, () => runB.promise, (state) => shown.push(state));
    runB.resolve("diff of B");
    await flush();
    runA.resolve("diff of A");
    await flush();

    expect(shown).toEqual([{ status: "loading" }, { status: "loading" }, { status: "ready", value: "diff of B" }]);
  });

  it("drops a late error from the Run the page left, and anything after a cancel", async () => {
    const gate = new LatestRequest();
    const shown: Array<Loadable<string>> = [];
    const old = deferred<string>();
    void loadLatest(gate, () => old.promise, (state) => shown.push(state));
    const current = deferred<string>();
    void loadLatest(gate, () => current.promise, (state) => shown.push(state));
    old.reject(new Error("404 for the old Run"));
    await flush();
    gate.cancel();
    current.resolve("too late");
    await flush();
    expect(shown.filter((state) => state.status !== "loading")).toEqual([]);
  });

  it("shows an error for the current Run so the page can offer a retry, and a retry can succeed", async () => {
    const gate = new LatestRequest();
    const shown: Array<Loadable<string>> = [];
    await loadLatest(gate, () => Promise.reject(new Error("The server is unavailable")), (state) => shown.push(state));
    expect(shown.at(-1)).toEqual({ status: "error", message: "The server is unavailable" });
    await loadLatest(gate, () => Promise.resolve("loaded"), (state) => shown.push(state));
    expect(shown.at(-1)).toEqual({ status: "ready", value: "loaded" });
  });
});

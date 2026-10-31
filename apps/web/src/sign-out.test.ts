import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authHeaders, setAuthToken } from "./api";
import { SESSION_NOT_ENDED_NOTICE, signOut } from "./sign-out";

function answer(status: number) {
  return vi.fn(async () => new Response(status === 204 ? null : "{}", { status }));
}

describe("signOut", () => {
  const removeItem = vi.fn();

  beforeEach(() => {
    removeItem.mockClear();
    setAuthToken("session-token");
    vi.stubGlobal("window", { localStorage: { removeItem } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("ends the session with the current token, then forgets it", async () => {
    const fetch = answer(204);
    vi.stubGlobal("fetch", fetch);
    expect(await signOut()).toBeNull();
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/session");
    expect(options.method).toBe("DELETE");
    expect(options.headers).toMatchObject({ Authorization: "Bearer session-token" });
    expect(authHeaders()).toEqual({});
  });

  it("forgets what this browser kept for the signed-in person", async () => {
    vi.stubGlobal("fetch", answer(204));
    await signOut();
    expect(removeItem.mock.calls.map(([key]) => key)).toEqual(["agentguard.currentWorkspace", "agentguard.recentRuns"]);
  });

  it("treats a session the server no longer knows as ended", async () => {
    vi.stubGlobal("fetch", answer(401));
    expect(await signOut()).toBeNull();
    expect(authHeaders()).toEqual({});
  });

  it.each([
    ["a server error", answer(500)],
    ["no answer", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")))],
  ])("still signs out locally on %s, without claiming the session ended", async (_name, fetch) => {
    vi.stubGlobal("fetch", fetch);
    expect(await signOut()).toBe(SESSION_NOT_ENDED_NOTICE);
    expect(authHeaders()).toEqual({});
    expect(removeItem).toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import {
  RunEventStreamError,
  SseParser,
  encodeResyncFrame,
  encodeRunEventFrame,
  followRunEvents,
  type RunEvent,
} from "../src/index.js";
import { ids, now, run } from "./fixtures.js";

const eventAt = (seq: number): RunEvent => ({
  id: ids.event,
  runId: ids.run,
  seq,
  timestamp: now,
  type: "run.updated",
  payload: { run },
});

describe("SseParser", () => {
  it("assembles frames split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push("id: 1\nda")).toEqual([]);
    expect(parser.push("ta: {\"a\":1}\n")).toEqual([]);
    expect(parser.push("\nid: 2\ndata: x\n\n")).toEqual([
      { id: "1", event: "message", data: '{"a":1}' },
      { id: "2", event: "message", data: "x" },
    ]);
  });

  it("handles CRLF split across chunks, named events and multi-line data", () => {
    const parser = new SseParser();
    expect(parser.push("event: resync\r\ndata: one\r")).toEqual([]);
    expect(parser.push("\ndata: two\r\n\r\n")).toEqual([{ id: null, event: "resync", data: "one\ntwo" }]);
  });

  it("does not dispatch comments or retry hints", () => {
    const parser = new SseParser();
    expect(parser.push(": connected\n\nretry: 3000\n\n: ping\n\n")).toEqual([]);
  });
});

type FakeResponse = Response | Error;

/** fetch that serves queued responses in order and records each request. */
function fakeFetch(responses: FakeResponse[]) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses.shift();
    if (!next) {
      // Nothing left: hang until the caller aborts, like an idle stream.
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    }
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl: impl as typeof fetch, requests };
}

const stream = (...frames: string[]) =>
  new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });

describe("followRunEvents", () => {
  it("applies new events, skips ones the snapshot covered, and resumes after a drop", async () => {
    const controller = new AbortController();
    const received: number[] = [];
    const { impl, requests } = fakeFetch([
      stream(encodeRunEventFrame(eventAt(3)), encodeRunEventFrame(eventAt(4))),
      new TypeError("fetch failed"),
      stream(encodeRunEventFrame(eventAt(4)), encodeRunEventFrame(eventAt(5))),
    ]);

    const following = followRunEvents({
      url: "/api/runs/x/events",
      afterSeq: 3,
      headers: { authorization: "Bearer t" },
      retryMs: 1,
      fetch: impl,
      signal: controller.signal,
      onResync: async () => 0,
      onEvent: (event) => {
        received.push(event.seq);
        if (event.seq === 5) controller.abort();
      },
    });

    await expect(following).resolves.toBeUndefined();
    expect(received).toEqual([4, 5]);
    expect(requests.map((request) => request.headers["last-event-id"])).toEqual(["3", "4", "4"]);
    expect(requests[0]!.headers.authorization).toBe("Bearer t");
  });

  it("reloads the snapshot on resync and resumes from its seq", async () => {
    const controller = new AbortController();
    const received: number[] = [];
    const { impl, requests } = fakeFetch([stream(encodeResyncFrame()), stream(encodeRunEventFrame(eventAt(11)))]);

    await followRunEvents({
      url: "/api/runs/x/events",
      afterSeq: 50,
      retryMs: 60_000,
      fetch: impl,
      signal: controller.signal,
      onResync: async () => 10,
      onEvent: (event) => {
        received.push(event.seq);
        controller.abort();
      },
    });

    expect(received).toEqual([11]);
    expect(requests.map((request) => request.headers["last-event-id"])).toEqual(["50", "10"]);
  });

  it("waits before reconnecting when a resync leaves it where it was", async () => {
    const controller = new AbortController();
    const { impl, requests } = fakeFetch([stream(encodeResyncFrame()), stream(encodeResyncFrame())]);
    const following = followRunEvents({
      url: "/api/runs/x/events",
      afterSeq: 50,
      retryMs: 60_000,
      fetch: impl,
      signal: controller.signal,
      onResync: async () => 50,
      onEvent: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requests).toHaveLength(1);
    controller.abort();
    await expect(following).resolves.toBeUndefined();
  });

  it("gives up on a refused stream instead of retrying", async () => {
    const { impl } = fakeFetch([new Response('{"error":"Run not found"}', { status: 404 })]);
    await expect(
      followRunEvents({
        url: "/api/runs/x/events",
        afterSeq: 0,
        fetch: impl,
        signal: new AbortController().signal,
        onResync: async () => 0,
        onEvent: () => undefined,
      }),
    ).rejects.toMatchObject({ name: "RunEventStreamError", status: 404 } satisfies Partial<RunEventStreamError>);
  });

  it("surfaces errors thrown by onEvent instead of reconnecting", async () => {
    const { impl, requests } = fakeFetch([stream(encodeRunEventFrame(eventAt(1)))]);
    await expect(
      followRunEvents({
        url: "/api/runs/x/events",
        afterSeq: 0,
        retryMs: 1,
        fetch: impl,
        signal: new AbortController().signal,
        onResync: async () => 0,
        onEvent: () => {
          throw new TypeError("bug in the UI");
        },
      }),
    ).rejects.toThrow("bug in the UI");
    expect(requests).toHaveLength(1);
  });

  it("rejects events that break the contract", async () => {
    const { impl } = fakeFetch([stream('id: 1\ndata: {"type":"run.exploded"}\n\n')]);
    await expect(
      followRunEvents({
        url: "/api/runs/x/events",
        afterSeq: 0,
        fetch: impl,
        signal: new AbortController().signal,
        onResync: async () => 0,
        onEvent: () => undefined,
      }),
    ).rejects.toThrow();
  });
});

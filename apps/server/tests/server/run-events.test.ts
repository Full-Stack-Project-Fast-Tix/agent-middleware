import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SseParser,
  followRunEvents,
  runEventSchema,
  type Run,
  type RunEvent,
  type RunEventDraft,
  type SseFrame,
  type Task,
} from "@launchpad/shared";
import type { FastifyInstance } from "fastify";
import type { AgentService } from "../../src/agent-service.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { RunEventHub } from "../../src/run-events.js";

const runId = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b";
const otherRunId = "4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c";
const now = "2026-09-29T06:00:00.000Z";

function runRow(id: string, status: Run["status"] = "running"): Run {
  return {
    id,
    workspaceId: "7d3c1a0e-5b1f-4c8e-9a2d-1f0e3b4c5d6e",
    createdByUserId: "0b9e8d7c-6a5b-4c3d-8e2f-1a0b9c8d7e6f",
    supervisorAgentId: null,
    userPrompt: "Add input validation to the signup endpoint",
    orchestrationMode: "single",
    status,
    finalOutput: null,
    error: null,
    cancelRequestedAt: null,
    evaluation: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
  };
}

function taskRow(result: string | null = null): Task {
  return {
    id: "5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d",
    runId,
    parentTaskId: null,
    createdByExecutionId: null,
    title: "Review signup handler",
    objective: "Identify missing validation",
    assignedAgentId: null,
    status: "completed",
    result,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
  };
}

/** A draft before persistence has assigned its seq. */
type Uncommitted = RunEventDraft extends infer D ? (D extends RunEventDraft ? Omit<D, "seq"> : never) : never;

const runUpdated = (id = runId, status: Run["status"] = "running"): Uncommitted => ({
  runId: id,
  type: "run.updated",
  payload: { run: runRow(id, status) },
});

/** Publishes the way persistence will: seq assigned per run, in commit order, starting after `from`. */
function committer(hub: RunEventHub, from: Record<string, number> = {}) {
  const seqs = new Map(Object.entries(from));
  return (draft: Uncommitted): RunEvent => {
    const seq = (seqs.get(draft.runId) ?? 0) + 1;
    seqs.set(draft.runId, seq);
    return hub.publish({ ...draft, seq } as RunEventDraft);
  };
}

const listen = (onEvent: (event: RunEvent) => void, onResync: () => void = () => undefined) => ({ onEvent, onResync });

describe("RunEventHub", () => {
  it("publishes committed events and stamps id and timestamp", () => {
    const hub = new RunEventHub({ now: () => Date.parse(now) });
    const publish = committer(hub);
    expect(publish(runUpdated()).seq).toBe(1);
    expect(publish(runUpdated()).seq).toBe(2);
    const other = publish(runUpdated(otherRunId));
    expect(other.seq).toBe(1);
    expect(other.timestamp).toBe(now);
    expect(other.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a seq that is not after the last one published", () => {
    const hub = new RunEventHub();
    hub.publish({ ...runUpdated(), seq: 1 } as RunEventDraft);
    expect(() => hub.publish({ ...runUpdated(), seq: 1 } as RunEventDraft)).toThrow(/seq 1 published after seq 1/);
    expect(hub.lastSeq(runId)).toBe(1);
  });

  it("rejects a draft that breaks the contract", () => {
    const hub = new RunEventHub();
    const bad = { ...runUpdated(), seq: 1, payload: { run: { ...runRow(runId), status: "exploded" } } };
    expect(() => hub.publish(bad as RunEventDraft)).toThrow();
    expect(hub.lastSeq(runId)).toBe(0);
  });

  it("strips fields that are not part of the contract", () => {
    const hub = new RunEventHub();
    const leaky = { ...runUpdated(), seq: 1, payload: { run: { ...runRow(runId), internalNotes: "do not ship" } } };
    const event = hub.publish(leaky as RunEventDraft);
    expect(JSON.stringify(event)).not.toContain("internalNotes");
  });

  it("replays after the requested seq, then delivers live events", () => {
    const hub = new RunEventHub();
    const publish = committer(hub);
    publish(runUpdated());
    publish(runUpdated());
    const seen: number[] = [];
    const subscription = hub.subscribe(runId, 1, listen((event) => seen.push(event.seq)));
    publish(runUpdated());
    expect(subscription.status).toBe("subscribed");
    expect(seen).toEqual([2, 3]);
  });

  it("asks for a resync when it cannot replay from the requested seq", () => {
    const hub = new RunEventHub({ bufferSize: 2 });
    const publish = committer(hub);
    for (let index = 0; index < 4; index += 1) publish(runUpdated());
    // Ahead of anything this process has published.
    expect(hub.subscribe(runId, 9, listen(() => undefined)).status).toBe("resync");
    // Behind the buffer, which now holds only seq 3 and 4.
    expect(hub.subscribe(runId, 1, listen(() => undefined)).status).toBe("resync");
    expect(hub.subscribe(runId, 2, listen(() => undefined)).status).toBe("subscribed");
  });

  it("continues from durable seqs after a restart, so old positions never collide", () => {
    // The previous process published up to seq 57; persistence continues from there.
    const hub = new RunEventHub();
    const publish = committer(hub, { [runId]: 57 });
    const seen: number[] = [];
    publish(runUpdated());
    expect(hub.subscribe(runId, 57, listen((event) => seen.push(event.seq))).status).toBe("subscribed");
    expect(seen).toEqual([58]);
    // Positions the new process cannot replay are told to resync, never served a wrong tail.
    expect(hub.subscribe(runId, 30, listen(() => undefined)).status).toBe("resync");
    expect(hub.subscribe(runId, 60, listen(() => undefined)).status).toBe("resync");
  });

  it("tells subscribers to resync when a committed seq was never published", () => {
    const hub = new RunEventHub();
    hub.publish({ ...runUpdated(), seq: 1 } as RunEventDraft);
    let resyncs = 0;
    const seen: number[] = [];
    hub.subscribe(runId, 1, listen((event) => seen.push(event.seq), () => (resyncs += 1)));
    hub.publish({ ...runUpdated(), seq: 3 } as RunEventDraft);
    expect(resyncs).toBe(1);
    expect(seen).toEqual([]);
    expect(hub.listenerCount(runId)).toBe(0);
    // Anyone reconnecting from before the gap is sent to the snapshot too.
    expect(hub.subscribe(runId, 1, listen(() => undefined)).status).toBe("resync");
    expect(hub.subscribe(runId, 2, listen(() => undefined)).status).toBe("subscribed");
  });

  it("stops delivering after unsubscribe and forgets runs that never published", () => {
    const hub = new RunEventHub();
    const subscription = hub.subscribe(runId, 0, listen(() => undefined));
    if (subscription.status !== "subscribed") throw new Error("expected a subscription");
    expect(hub.listenerCount(runId)).toBe(1);
    subscription.unsubscribe();
    expect(hub.listenerCount(runId)).toBe(0);
    expect(hub.has(runId)).toBe(false);
  });

  it("drops a throwing listener without affecting others", () => {
    const hub = new RunEventHub();
    const publish = committer(hub);
    const seen: number[] = [];
    hub.subscribe(
      runId,
      0,
      listen(() => {
        throw new Error("broken socket");
      }),
    );
    hub.subscribe(runId, 0, listen((event) => seen.push(event.seq)));
    publish(runUpdated());
    publish(runUpdated());
    expect(seen).toEqual([1, 2]);
    expect(hub.listenerCount(runId)).toBe(1);
  });

  it("forgets a finished run after the retention period", () => {
    let clock = Date.parse(now);
    const hub = new RunEventHub({ retainFinishedMs: 1_000, now: () => clock });
    const publish = committer(hub);
    publish(runUpdated(runId, "completed"));
    clock += 999;
    publish(runUpdated(otherRunId));
    expect(hub.has(runId)).toBe(true);
    clock += 2;
    publish(runUpdated(otherRunId));
    expect(hub.has(runId)).toBe(false);
    expect(hub.has(otherRunId)).toBe(true);
  });
});

describe("GET /api/runs/:id/events", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function start(options: { authToken?: string; heartbeatMs?: number } = {}) {
    const hub = new RunEventHub();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", ...(options.authToken ? { APP_AUTH_TOKEN: options.authToken } : {}) }),
      {} as AgentService,
      {
        runEvents: {
          hub,
          canReadRun: (id) => hub.has(id),
          ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
        },
      },
    );
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    return { app, hub, publish: committer(hub), url: (id = runId) => `http://127.0.0.1:${port}/api/runs/${id}/events` };
  }

  /** Read frames until `done` says stop, then disconnect. Returns the frames and raw text. */
  async function read(
    url: string,
    headers: Record<string, string>,
    done: (frames: SseFrame[], text: string) => boolean,
  ) {
    const controller = new AbortController();
    const response = await fetch(url, { headers, signal: controller.signal });
    const frames: SseFrame[] = [];
    let text = "";
    const parser = new SseParser();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    while (!done(frames, text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const decoded = decoder.decode(chunk.value, { stream: true });
      text += decoded;
      frames.push(...parser.push(decoded));
    }
    controller.abort();
    return { response, frames, text };
  }

  const events = (frames: SseFrame[]): RunEvent[] => frames.map((frame) => runEventSchema.parse(JSON.parse(frame.data)));

  it("refuses unknown runs, malformed resume positions and unauthenticated callers", async () => {
    const { app, hub, publish } = await start({ authToken: "a-strong-test-token" });
    publish(runUpdated());
    const auth = { authorization: "Bearer a-strong-test-token" };

    const unauthenticated = await app.inject({ method: "GET", url: `/api/runs/${runId}/events` });
    expect(unauthenticated.statusCode).toBe(401);

    const unknown = await app.inject({ method: "GET", url: `/api/runs/${otherRunId}/events`, headers: auth });
    expect(unknown.statusCode).toBe(404);

    const malformed = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/events`,
      headers: { ...auth, "last-event-id": "abc" },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("replays history, then streams live events in order", async () => {
    const { hub, publish, url } = await start();
    publish(runUpdated());
    publish({ runId, type: "task.created", payload: { task: taskRow(), dependsOnTaskIds: [] } });

    const { response, frames } = await read(url(), {}, (received) => {
      if (received.length === 2 && hub.lastSeq(runId) === 2) publish(runUpdated(runId, "completed"));
      return received.length === 3;
    });

    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(frames.map((frame) => frame.id)).toEqual(["1", "2", "3"]);
    expect(events(frames).map((event) => event.type)).toEqual(["run.updated", "task.created", "run.updated"]);
  });

  it("resumes after Last-Event-ID, or ?after= on the first connection", async () => {
    const { hub, publish, url } = await start();
    for (let index = 0; index < 3; index += 1) publish(runUpdated());

    const byHeader = await read(url(), { "last-event-id": "2" }, (frames) => frames.length === 1);
    expect(byHeader.frames.map((frame) => frame.id)).toEqual(["3"]);

    const byQuery = await read(`${url()}?after=1`, {}, (frames) => frames.length === 2);
    expect(byQuery.frames.map((frame) => frame.id)).toEqual(["2", "3"]);
  });

  it("tells a client that is ahead of the server to resync, then closes", async () => {
    const { hub, publish, url } = await start();
    publish(runUpdated());
    const { frames } = await read(url(), { "last-event-id": "40" }, () => false);
    expect(frames).toEqual([{ id: null, event: "resync", data: "{}" }]);
  });

  it("redacts credential-shaped text in every frame", async () => {
    const { hub, publish, url } = await start();
    const secret = "sk_live_" + "A1b2C3d4E5f6G7h8I9j0";
    publish({ runId, type: "task.updated", payload: { task: taskRow(`Found key ${secret} in .env`) } });

    const { frames, text } = await read(url(), {}, (received) => received.length === 1);
    expect(text).not.toContain(secret);
    expect(events(frames)[0]).toMatchObject({ type: "task.updated" });
  });

  it("sends heartbeats and unsubscribes when the client goes away", async () => {
    const { hub, publish, url } = await start({ heartbeatMs: 10 });
    publish(runUpdated());

    const { text } = await read(url(), {}, (_frames, received) => received.includes(": ping"));
    expect(text).toContain(": ping");
    await vi.waitFor(() => expect(hub.listenerCount(runId)).toBe(0));
  });

  it("ends open streams so the server can shut down", async () => {
    const { app, hub, publish, url } = await start();
    publish(runUpdated());
    const response = await fetch(url());
    expect(hub.listenerCount(runId)).toBe(1);

    apps.splice(apps.indexOf(app), 1);
    await app.close();
    const body = await response.text();
    expect(body).toContain("id: 1");
    expect(hub.listenerCount(runId)).toBe(0);
  });

  it("works end to end with the shared client, including resync", async () => {
    const { hub, publish, url } = await start();
    publish(runUpdated());
    publish(runUpdated());

    const controller = new AbortController();
    const received: RunEvent[] = [];
    let resyncs = 0;
    await followRunEvents({
      url: url(),
      // Stale position from before a "restart": the server asks for a resync.
      afterSeq: 99,
      retryMs: 10,
      signal: controller.signal,
      onResync: async () => {
        resyncs += 1;
        // A real client reloads the RunSnapshot here.
        const seq = hub.lastSeq(runId);
        setTimeout(() => publish(runUpdated(runId, "completed")), 20);
        return seq;
      },
      onEvent: (event) => {
        received.push(event);
        if (event.type === "run.updated" && event.payload.run.status === "completed") controller.abort();
      },
    });

    expect(resyncs).toBe(1);
    expect(received.map((event) => event.seq)).toEqual([3]);
  });
});

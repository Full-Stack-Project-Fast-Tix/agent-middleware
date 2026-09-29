import { RUN_STREAM_RESYNC_EVENT, runEventSchema, type RunEvent } from "./events.js";

export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

/**
 * Incremental text/event-stream parser. Feed it decoded text in whatever
 * chunks the network delivers; it returns each frame once complete. Supports
 * LF and CRLF line endings.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    // A CR at the end of one chunk pairs with an LF at the start of the next,
    // so normalise the whole buffer rather than each chunk.
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, "\n");
    const frames: SseFrame[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = parseFrame(this.buffer.slice(0, boundary));
      if (frame) frames.push(frame);
      this.buffer = this.buffer.slice(boundary + 2);
      boundary = this.buffer.indexOf("\n\n");
    }
    return frames;
  }
}

function parseFrame(block: string): SseFrame | null {
  let id: string | null = null;
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  // Per the SSE spec, a block without data (comments, retry hints) is not dispatched.
  return data.length === 0 ? null : { id, event, data: data.join("\n") };
}

/** The server refused the stream (401, 403, 404...). Retrying will not help. */
export class RunEventStreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RunEventStreamError";
  }
}

export interface FollowRunEventsOptions {
  /** e.g. `/api/runs/${runId}/events` */
  url: string;
  /** Where to resume from: RunSnapshot.lastEventSeq. */
  afterSeq: number;
  onEvent: (event: RunEvent) => void;
  /**
   * The server cannot replay from our position. Reload and apply the
   * RunSnapshot, then return its lastEventSeq.
   */
  onResync: () => Promise<number>;
  signal: AbortSignal;
  /** Sent on every connection, e.g. Authorization. */
  headers?: Record<string, string>;
  /** Delay before reconnecting after a dropped connection. */
  retryMs?: number;
  fetch?: typeof fetch;
}

/**
 * Follow a Run's event stream until `signal` aborts, reconnecting after
 * network errors and resuming from the last applied seq.
 *
 * Uses fetch rather than EventSource because EventSource cannot send an
 * Authorization header. Resolves when aborted; rejects on a 4xx response or
 * an event that does not match the contract.
 */
export async function followRunEvents(options: FollowRunEventsOptions): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const retryMs = options.retryMs ?? 2_000;
  let afterSeq = options.afterSeq;

  while (!options.signal.aborted) {
    let resynced = false;
    try {
      const response = await network(
        fetchImpl(options.url, {
          headers: { ...options.headers, accept: "text/event-stream", "last-event-id": String(afterSeq) },
          signal: options.signal,
        }),
      );
      if (response.status >= 400 && response.status < 500) {
        throw new RunEventStreamError(`Run event stream refused with ${response.status}`, response.status);
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        reading: for (;;) {
          const { value, done } = await network(reader.read());
          if (done) break;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            if (frame.event === RUN_STREAM_RESYNC_EVENT) {
              await reader.cancel().catch(() => undefined);
              afterSeq = await options.onResync();
              resynced = true;
              break reading;
            }
            if (frame.event !== "message") continue;
            const event = runEventSchema.parse(JSON.parse(frame.data));
            // Replay can overlap what the snapshot already covered.
            if (event.seq <= afterSeq) continue;
            afterSeq = event.seq;
            options.onEvent(event);
          }
        }
      }
    } catch (error) {
      if (options.signal.aborted) return;
      // Only connection failures are retried. Anything else (a refused stream,
      // an event that breaks the contract, an error thrown by onEvent) is a bug
      // that reconnecting would hide.
      if (!(error instanceof Disconnected)) throw error;
    }
    if (!resynced) await wait(retryMs, options.signal);
  }
}

class Disconnected extends Error {}

/** Marks a failure of the connection itself, as opposed to the code handling its data. */
async function network<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw new Disconnected("Run event stream disconnected", { cause: error });
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  // An already-aborted signal never fires "abort" again.
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

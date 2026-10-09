// Bounded rolling raw trace of one agent run.
//
// Messages are captured verbatim and in order while the run is active. The
// file retains only the newest events that fit within the byte budget, with a
// marker when older events have rolled off. Security checks consume the live
// protocol stream separately and do not depend on this bounded file.
//
// Traces are NOT stored in the JSON database. That store rewrites the entire
// file on every mutation (see store.ts), so appending a few hundred events per
// run would rewrite every agent, message and past run a few hundred times.
//
// Format is JSON Lines: one JSON object per line, readable with jq, Python, or
// anything that can split on newlines. No parser of ours sits in the way.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Direction of travel: `in` from the agent runtime, `out` from us. */
export type TraceDirection = "in" | "out";

export interface TraceSummary {
  path: string;
  events: number;
  bytes: number;
  /** True when older events were evicted to keep the newest events within the size cap. */
  truncated: boolean;
}

export interface TraceRecord {
  /** Our counter, so ordering survives identical timestamps. */
  seq: number;
  at: string;
  dir: TraceDirection;
  /** JSON-RPC method when the message has one, else null. */
  method: string | null;
  /** The untouched message, unless the whole event is larger than the trace budget. */
  payload: unknown;
}

export function traceFilePath(dataDirectory: string, runId: string): string {
  return path.join(dataDirectory, "traces", `${runId}.jsonl`);
}

/**
 * JSON-RPC messages have a "method" when they are a request or a notification,
 * and no method when they are a response. We store it at the top level so a
 * reader can filter on it without digging into the payload.
 */
function readMethodName(message: unknown): string | null {
  if (message === null) return null;
  if (typeof message !== "object") return null;

  const method = (message as Record<string, unknown>).method;
  if (typeof method === "string") return method;
  return null;
}

/**
 * One record, one line. A payload that will not serialise still gets a line,
 * so the sequence numbers never have silent holes in them.
 */
function toJsonLine(record: TraceRecord): string {
  try {
    return JSON.stringify(record) + "\n";
  } catch {
    const placeholder = { ...record, payload: { unserializable: true } };
    return JSON.stringify(placeholder) + "\n";
  }
}

export class TraceWriter {
  private opened = false;
  private seq = 0;
  private bytes = 0;
  private truncated = false;
  private readonly lines: string[] = [];
  private firstLine = 0;
  private marker: string | null = null;

  constructor(
    private readonly filePath: string,
    /** Keep the newest trace events within this size. */
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  async open(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.opened = true;
  }

  /**
   * Record one message in a bounded in-memory rolling window. This is
   * synchronous and non-throwing because it sits on the protocol hot path.
   */
  record(dir: TraceDirection, message: unknown): void {
    if (!this.opened) return;
    this.seq += 1;

    const record: TraceRecord = {
      seq: this.seq,
      at: new Date().toISOString(),
      dir: dir,
      method: readMethodName(message),
      payload: message,
    };

    const line = toJsonLine(record);

    const lineBytes = Buffer.byteLength(line, "utf8");

    if (lineBytes > this.maxBytes) {
      this.truncated = true;
      this.marker ??= this.truncationNotice();
      while (this.bytes + this.markerBytes() > this.maxBytes) {
        const oldest = this.lines[this.firstLine++];
        if (oldest === undefined) break;
        this.bytes -= Buffer.byteLength(oldest, "utf8");
      }
      return;
    }

    this.lines.push(line);
    this.bytes += lineBytes;
    while (this.bytes + this.markerBytes() > this.maxBytes) {
      const oldest = this.lines[this.firstLine++];
      if (oldest === undefined) break;
      this.bytes -= Buffer.byteLength(oldest, "utf8");
      this.truncated = true;
      this.marker ??= this.truncationNotice();
    }

    // Release evicted strings periodically instead of retaining them in the
    // backing array until the run ends.
    if (this.firstLine > 1024 && this.firstLine * 2 > this.lines.length) {
      this.lines.splice(0, this.firstLine);
      this.firstLine = 0;
    }
  }

  private markerBytes(): number {
    return this.marker === null ? 0 : Buffer.byteLength(this.marker, "utf8");
  }

  private truncationNotice(): string {
    const notice: TraceRecord = {
      seq: 0,
      at: new Date().toISOString(),
      dir: "out",
      method: "trace/rolled",
      payload: {
        reason: "events omitted to retain the newest window",
        maxBytes: this.maxBytes,
      },
    };
    return JSON.stringify(notice) + "\n";
  }

  async close(): Promise<TraceSummary> {
    const retained = this.lines.slice(this.firstLine);
    const contents = (this.marker ?? "") + retained.join("");
    await writeFile(this.filePath, contents, { encoding: "utf8", mode: 0o600 });
    return {
      path: this.filePath,
      events: this.seq,
      bytes: Buffer.byteLength(contents, "utf8"),
      truncated: this.truncated,
    };
  }
}

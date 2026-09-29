import { randomUUID } from "node:crypto";
import {
  isTerminalRunStatus,
  runEventSchema,
  type RunEvent,
  type RunEventDraft,
} from "@launchpad/shared";

export type RunEventListener = (event: RunEvent) => void;

export type RunEventSubscription =
  | { status: "subscribed"; unsubscribe: () => void }
  /** The hub cannot replay from the requested seq; the client must reload the RunSnapshot. */
  | { status: "resync" };

export interface RunEventHubOptions {
  /** Events kept per Run for Last-Event-ID replay. */
  bufferSize?: number;
  /** How long a finished Run stays replayable once nobody is listening. */
  retainFinishedMs?: number;
  now?: () => number;
}

interface RunChannel {
  lastSeq: number;
  /** Most recent events, oldest first. */
  buffer: RunEvent[];
  listeners: Set<RunEventListener>;
  /** When a terminal `run.updated` was published. */
  finishedAt: number | null;
}

/**
 * In-process fan-out of RunEvents with a short replay buffer per Run.
 *
 * The orchestrator publishes; SSE connections subscribe. Seq numbers are
 * assigned here, so they only mean something within one server process: after
 * a restart the hub has no history, and a client reconnecting with an old
 * Last-Event-ID is told to resync. That fits the plan's single deployment;
 * several server instances would need a shared bus instead.
 */
export class RunEventHub {
  private readonly channels = new Map<string, RunChannel>();
  private readonly bufferSize: number;
  private readonly retainFinishedMs: number;
  private readonly now: () => number;

  constructor(options: RunEventHubOptions = {}) {
    this.bufferSize = options.bufferSize ?? 1_000;
    this.retainFinishedMs = options.retainFinishedMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Stamp, validate and deliver one event. Throws if the draft does not match
   * the RunEvent contract, so a bad payload fails where it was produced rather
   * than in every browser. Unknown fields are stripped, so internal columns on
   * a row cannot leak to clients.
   */
  publish(draft: RunEventDraft): RunEvent {
    this.sweep();
    const channel = this.channelFor(draft.runId);
    const event = runEventSchema.parse({
      ...draft,
      id: randomUUID(),
      seq: channel.lastSeq + 1,
      timestamp: new Date(this.now()).toISOString(),
    });

    channel.lastSeq = event.seq;
    channel.buffer.push(event);
    if (channel.buffer.length > this.bufferSize) channel.buffer.shift();
    if (event.type === "run.updated") {
      channel.finishedAt = isTerminalRunStatus(event.payload.run.status) ? this.now() : null;
    }

    for (const listener of [...channel.listeners]) {
      try {
        listener(event);
      } catch {
        // One broken subscriber must not stop the orchestrator or other viewers.
        channel.listeners.delete(listener);
      }
    }
    return event;
  }

  /**
   * Replay buffered events after `afterSeq` to `listener`, then deliver live
   * ones. Replay and registration happen in the same tick, so nothing
   * published in between is missed.
   */
  subscribe(runId: string, afterSeq: number, listener: RunEventListener): RunEventSubscription {
    this.sweep();
    const existing = this.channels.get(runId);
    const lastSeq = existing?.lastSeq ?? 0;
    const oldestSeq = existing?.buffer[0]?.seq ?? lastSeq + 1;
    // Ahead of the hub: the server restarted since the client last connected.
    // Behind the buffer: the events it missed have been dropped.
    if (afterSeq > lastSeq || afterSeq < oldestSeq - 1) return { status: "resync" };

    const channel = existing ?? this.channelFor(runId);
    for (const event of channel.buffer) {
      if (event.seq > afterSeq) listener(event);
    }
    channel.listeners.add(listener);
    return {
      status: "subscribed",
      unsubscribe: () => {
        channel.listeners.delete(listener);
        // A channel opened by a subscriber for a Run that never published anything.
        if (channel.listeners.size === 0 && channel.lastSeq === 0) this.channels.delete(runId);
      },
    };
  }

  /** Whether the hub has seen any event for this Run. */
  has(runId: string): boolean {
    return (this.channels.get(runId)?.lastSeq ?? 0) > 0;
  }

  /**
   * The seq to put in RunSnapshot.lastEventSeq. Read it BEFORE loading the
   * snapshot from the database: an event published in between is then
   * replayed on top of a snapshot that may already include it (harmless, since
   * events are upserts), instead of being skipped when it is missing from it.
   */
  lastSeq(runId: string): number {
    return this.channels.get(runId)?.lastSeq ?? 0;
  }

  listenerCount(runId: string): number {
    return this.channels.get(runId)?.listeners.size ?? 0;
  }

  private channelFor(runId: string): RunChannel {
    let channel = this.channels.get(runId);
    if (!channel) {
      channel = { lastSeq: 0, buffer: [], listeners: new Set(), finishedAt: null };
      this.channels.set(runId, channel);
    }
    return channel;
  }

  private sweep(): void {
    const cutoff = this.now() - this.retainFinishedMs;
    for (const [runId, channel] of this.channels) {
      if (channel.finishedAt !== null && channel.finishedAt < cutoff && channel.listeners.size === 0) {
        this.channels.delete(runId);
      }
    }
  }
}

import { randomUUID } from "node:crypto";
import {
  isTerminalRunStatus,
  runEventSchema,
  type RunEvent,
  type RunEventDraft,
} from "@launchpad/shared";

export interface RunEventListener {
  onEvent: (event: RunEvent) => void;
  /**
   * The hub can no longer guarantee this subscriber a gap-free stream: a seq
   * was skipped. The subscription has already been removed; the client must
   * reload the RunSnapshot.
   */
  onResync: () => void;
}

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
  /** Most recent events, oldest first, with consecutive seqs. */
  buffer: RunEvent[];
  listeners: Set<RunEventListener>;
  /** When a terminal `run.updated` was published. */
  finishedAt: number | null;
}

/**
 * In-process fan-out of RunEvents with a short replay buffer per Run.
 *
 * Persistence assigns each event's seq in the same transaction as the write it
 * describes, and the event is published here after that commits. Seqs are
 * therefore durable: after a restart the hub starts empty, but the next seq it
 * sees continues from the last one clients saw, so an old Last-Event-ID can
 * never collide with a new event. A client whose position the buffer does not
 * cover is told to resync.
 *
 * One process per deployment, as the plan intends. Several server instances
 * would need a shared bus instead.
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
   * Stamp, validate and deliver one committed event.
   *
   * Throws if the draft does not match the RunEvent contract, so a bad payload
   * fails where it was produced rather than in every browser. Unknown fields
   * are stripped, so internal columns on a row cannot leak to clients. Throws
   * if the seq is not after the last one published, which means an event was
   * published twice or out of commit order.
   *
   * A seq that skips ahead (an event committed but never published) cannot be
   * repaired here. Current subscribers are told to resync and the buffer
   * restarts, so nobody silently misses the lost event.
   */
  publish(draft: RunEventDraft): RunEvent {
    this.sweep();
    const channel = this.channelFor(draft.runId);
    if (draft.seq <= channel.lastSeq) {
      throw new Error(`Run ${draft.runId}: seq ${draft.seq} published after seq ${channel.lastSeq}`);
    }
    const event = runEventSchema.parse({
      ...draft,
      id: randomUUID(),
      timestamp: new Date(this.now()).toISOString(),
    });

    if (channel.lastSeq > 0 && event.seq !== channel.lastSeq + 1) {
      channel.buffer = [];
      for (const listener of [...channel.listeners]) {
        channel.listeners.delete(listener);
        listener.onResync();
      }
    }
    channel.lastSeq = event.seq;
    channel.buffer.push(event);
    if (channel.buffer.length > this.bufferSize) channel.buffer.shift();
    if (event.type === "run.updated") {
      channel.finishedAt = isTerminalRunStatus(event.payload.run.status) ? this.now() : null;
    }

    for (const listener of [...channel.listeners]) {
      try {
        listener.onEvent(event);
      } catch {
        // One broken subscriber must not stop the orchestrator or other viewers.
        channel.listeners.delete(listener);
      }
    }
    return event;
  }

  /**
   * Replay buffered events after `afterSeq`, then deliver live ones. Replay
   * and registration happen in the same tick, so nothing published in between
   * is missed.
   *
   * `durableSeq` is the Run's last committed seq, from persistence. When this
   * process has published nothing for the Run (it restarted, or forgot a
   * finished Run), the channel starts there, so a client that is up to date
   * waits for new events instead of being told to resync forever.
   */
  subscribe(runId: string, afterSeq: number, listener: RunEventListener, durableSeq = 0): RunEventSubscription {
    this.sweep();
    const existing = this.channels.get(runId);
    const published = (existing?.buffer.length ?? 0) > 0;
    const lastSeq = published ? existing!.lastSeq : Math.max(existing?.lastSeq ?? 0, durableSeq);
    const oldestSeq = existing?.buffer[0]?.seq ?? lastSeq + 1;
    // Ahead of the hub: the client saw events this process never published
    // (it restarted and nothing new has happened yet, or the client is wrong).
    // Behind the buffer: the events it missed are not held here.
    if (afterSeq > lastSeq || afterSeq < oldestSeq - 1) return { status: "resync" };

    const channel = existing ?? this.channelFor(runId);
    channel.lastSeq = lastSeq;
    for (const event of channel.buffer) {
      if (event.seq > afterSeq) listener.onEvent(event);
    }
    channel.listeners.add(listener);
    return {
      status: "subscribed",
      unsubscribe: () => {
        channel.listeners.delete(listener);
        // A channel opened by a subscriber for a Run that never published anything here.
        if (channel.listeners.size === 0 && channel.buffer.length === 0) this.channels.delete(runId);
      },
    };
  }

  /** Whether this process has published any event for the Run. */
  has(runId: string): boolean {
    return (this.channels.get(runId)?.buffer.length ?? 0) > 0;
  }

  /** The last seq published in this process; 0 if none. Snapshots read theirs from the database. */
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

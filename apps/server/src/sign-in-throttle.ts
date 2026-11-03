import { createHash } from "node:crypto";

const WINDOW_MS = 15 * 60_000;
const ACCOUNT_LIMIT = 5;
const CLIENT_LIMIT = 30;
const MAX_TRACKED_KEYS = 10_000;

interface Counter { failures: number; resetAt: number }

/** Process-local fixed-window limiter. Deploy one app instance while this is the active backend. */
export class SignInThrottle {
  private readonly counters = new Map<string, Counter>();
  constructor(private readonly now: () => number = Date.now) {}

  private key(kind: "account" | "client", value: string): string {
    const normalized = kind === "account" ? value.trim().toLowerCase() : value;
    return `${kind}:${createHash("sha256").update(normalized).digest("hex")}`;
  }

  retryAfterSeconds(email: string, address: string): number {
    const now = this.now();
    this.prune(now);
    let wait = 0;
    for (const key of [this.key("account", email), this.key("client", address)]) {
      const counter = this.counters.get(key);
      if (counter !== undefined && counter.failures >= (key.startsWith("account:") ? ACCOUNT_LIMIT : CLIENT_LIMIT)) {
        wait = Math.max(wait, counter.resetAt - now);
      }
    }
    return Math.max(0, Math.ceil(wait / 1000));
  }

  failed(email: string, address: string): void {
    const now = this.now();
    this.prune(now);
    for (const key of [this.key("account", email), this.key("client", address)]) {
      const current = this.counters.get(key);
      const limit = key.startsWith("account:") ? ACCOUNT_LIMIT : CLIENT_LIMIT;
      const next = current === undefined || current.resetAt <= now
        ? { failures: 1, resetAt: now + WINDOW_MS }
        : { ...current, failures: Math.min(limit, current.failures + 1) };
      this.counters.delete(key);
      this.counters.set(key, next);
    }
    while (this.counters.size > MAX_TRACKED_KEYS) this.counters.delete(this.counters.keys().next().value!);
  }

  succeeded(email: string, address: string): void {
    this.counters.delete(this.key("account", email));
    this.counters.delete(this.key("client", address));
  }

  private prune(now: number): void {
    for (const [key, counter] of this.counters) if (counter.resetAt <= now) this.counters.delete(key);
  }
}

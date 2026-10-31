import { isIP } from "node:net";

// Limits on password guessing, per account and per source address. Failures are
// counted whether or not the account exists, so being refused says nothing
// about which emails have accounts.
//
// An attempt is counted before its password is checked and handed back if it
// succeeds. Checking takes a while, so counting afterwards would let a burst of
// parallel guesses all pass the limit together.
//
// The cost of an account limit is that anyone can lock a known email out for one
// window. That is the usual trade, and the window keeps it short.
//
// Single-process implementation for tests and small token-mode use. Password
// mode uses PostgresSignInThrottle so counters are shared across replicas.

export const SIGN_IN_WINDOW_MS = 15 * 60_000;
export const MAX_ACCOUNT_FAILURES = 5;
// Higher, because one office or NAT can share an address.
export const MAX_SOURCE_FAILURES = 30;
const MAX_TRACKED_KEYS = 10_000;

interface Counter {
  count: number;
  resetAt: number;
}

/**
 * Failures per key in a fixed window, holding at most `maxKeys` keys. Every
 * window is the same length and a restarted window re-inserts its key, so the
 * Map's insertion order is also expiry order: the oldest key expires first, and
 * making room never needs a scan.
 */
class WindowCounters {
  private readonly counters = new Map<string, Counter>();

  constructor(
    private readonly limit: number,
    private readonly maxKeys: number,
  ) {}

  /** Seconds until this key may try again, or null while it is under the limit. */
  retryAfter(key: string, now: number): number | null {
    const counter = this.counters.get(key);
    if (counter === undefined || counter.resetAt <= now || counter.count < this.limit) return null;
    return Math.ceil((counter.resetAt - now) / 1000);
  }

  add(key: string, now: number): void {
    const counter = this.counters.get(key);
    if (counter !== undefined && counter.resetAt > now) {
      counter.count += 1;
      return;
    }
    this.counters.delete(key);
    this.dropExpired(now);
    if (this.counters.size >= this.maxKeys) {
      this.counters.delete(this.counters.keys().next().value!);
    }
      this.counters.set(key, { count: 1, resetAt: now + SIGN_IN_WINDOW_MS });
  }

  /** Hands back one counted attempt, keeping the rest of the window. */
  subtract(key: string): void {
    const counter = this.counters.get(key);
    if (counter === undefined) return;
    counter.count -= 1;
    if (counter.count <= 0) this.counters.delete(key);
  }

  clear(key: string): void {
    this.counters.delete(key);
  }

  get size(): number {
    return this.counters.size;
  }

  private dropExpired(now: number): void {
    for (const [key, counter] of this.counters) {
      if (counter.resetAt > now) return;
      this.counters.delete(key);
    }
  }
}

const accountKey = (email: string) => email.trim().toLowerCase();

/** An IPv6 client usually controls a whole /64, so that is the unit limited. */
function sourceKey(ip: string): string {
  const address = ip.toLowerCase().replace(/^::ffff:(?=\d+\.)/, "");
  if (isIP(address) !== 6) return address;
  const [head = "", tail = ""] = address.split("%")[0]!.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0");
  return [...left, ...zeros, ...right]
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":");
}

export class SignInThrottle {
  private readonly accounts: WindowCounters;
  private readonly sources: WindowCounters;

  constructor(
    private readonly now: () => number = Date.now,
    options: { maxTrackedKeys?: number } = {},
  ) {
    const maxKeys = options.maxTrackedKeys ?? MAX_TRACKED_KEYS;
    this.accounts = new WindowCounters(MAX_ACCOUNT_FAILURES, maxKeys);
    this.sources = new WindowCounters(MAX_SOURCE_FAILURES, maxKeys);
  }

  /**
   * Counts an attempt and returns null to let it go ahead, or returns the
   * seconds to wait, without counting, when the account or source is at its limit.
   */
  admit(email: string, ip: string): number | null {
    const now = this.now();
    const account = accountKey(email);
    const source = sourceKey(ip);
    const waits = [this.accounts.retryAfter(account, now), this.sources.retryAfter(source, now)];
    const wait = Math.max(...waits.map((seconds) => seconds ?? 0));
    if (wait > 0) return wait;
    this.accounts.add(account, now);
    this.sources.add(source, now);
    return null;
  }

  /** The password was right. The account starts again; the source only gets this attempt back. */
  succeeded(email: string, ip: string): void {
    this.accounts.clear(accountKey(email));
    this.sources.subtract(sourceKey(ip));
  }

  /** The attempt could not be judged, such as a database error, so it does not count. */
  abandoned(email: string, ip: string): void {
    this.accounts.subtract(accountKey(email));
    this.sources.subtract(sourceKey(ip));
  }

  /** Keys currently held, for checking that memory stays bounded. */
  get trackedKeys(): number {
    return this.accounts.size + this.sources.size;
  }
}

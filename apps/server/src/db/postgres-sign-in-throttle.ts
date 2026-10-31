import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type pg from "pg";
import { MAX_ACCOUNT_FAILURES, MAX_SOURCE_FAILURES, SIGN_IN_WINDOW_MS } from "../sign-in-throttle.js";

const MAX_EXPIRED_ROWS_PER_ATTEMPT = 500;

function normalizedSource(ip: string): string {
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

function throttleKey(kind: "account" | "source", value: string): string {
  const digest = createHash("sha256").update(kind).update("\0").update(value).digest("hex");
  return `${kind}:${digest}`;
}

interface CounterRow {
  throttle_key: string;
  attempts: number;
  reset_at: Date | string;
}

interface Entry {
  key: string;
  limit: number;
}

/** Shared fixed-window login throttling for every app replica using this database. */
export class PostgresSignInThrottle {
  constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async admit(email: string, ip: string): Promise<number | null> {
    const entries = this.entries(email, ip);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = this.now();
      await client.query(
        `WITH expired AS (
           SELECT throttle_key FROM sign_in_throttle WHERE reset_at <= $1
           ORDER BY reset_at LIMIT $2 FOR UPDATE SKIP LOCKED
         ) DELETE FROM sign_in_throttle t USING expired e WHERE t.throttle_key = e.throttle_key`,
        [now.toISOString(), MAX_EXPIRED_ROWS_PER_ATTEMPT],
      );
      for (const entry of entries) {
        await client.query(
          `INSERT INTO sign_in_throttle (throttle_key, attempts, reset_at)
           VALUES ($1, 0, $2) ON CONFLICT (throttle_key) DO NOTHING`,
          [entry.key, new Date(now.getTime() + SIGN_IN_WINDOW_MS).toISOString()],
        );
      }
      const { rows } = await client.query<CounterRow>(
        `SELECT throttle_key, attempts, reset_at FROM sign_in_throttle
         WHERE throttle_key = ANY($1::text[]) ORDER BY throttle_key FOR UPDATE`,
        [entries.map((entry) => entry.key)],
      );
      const counters = new Map(rows.map((row) => [row.throttle_key, row]));
      const waits = entries.map((entry) => {
        const row = counters.get(entry.key)!;
        const resetAt = new Date(row.reset_at).getTime();
        return resetAt > now.getTime() && row.attempts >= entry.limit
          ? Math.ceil((resetAt - now.getTime()) / 1000)
          : 0;
      });
      const retryAfter = Math.max(...waits);
      if (retryAfter > 0) {
        await client.query("COMMIT");
        return retryAfter;
      }
      for (const entry of entries) {
        const row = counters.get(entry.key)!;
        const resetAt = new Date(row.reset_at).getTime();
        const expired = resetAt <= now.getTime();
        await client.query(
          `UPDATE sign_in_throttle SET attempts = $2, reset_at = $3 WHERE throttle_key = $1`,
          [entry.key, expired ? 1 : row.attempts + 1, expired ? new Date(now.getTime() + SIGN_IN_WINDOW_MS).toISOString() : row.reset_at],
        );
      }
      await client.query("COMMIT");
      return null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async succeeded(email: string, ip: string): Promise<void> {
    const [account, source] = this.entries(email, ip);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM sign_in_throttle WHERE throttle_key = $1", [account!.key]);
      await client.query(
        `UPDATE sign_in_throttle SET attempts = attempts - 1
         WHERE throttle_key = $1 AND attempts > 0`,
        [source!.key],
      );
      await client.query("DELETE FROM sign_in_throttle WHERE throttle_key = $1 AND attempts <= 0", [source!.key]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async abandoned(email: string, ip: string): Promise<void> {
    const entries = this.entries(email, ip);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const entry of entries) {
        await client.query(
          `UPDATE sign_in_throttle SET attempts = attempts - 1
           WHERE throttle_key = $1 AND attempts > 0`,
          [entry.key],
        );
        await client.query("DELETE FROM sign_in_throttle WHERE throttle_key = $1 AND attempts <= 0", [entry.key]);
      }
      await client.query(
        `WITH expired AS (
           SELECT throttle_key FROM sign_in_throttle WHERE reset_at <= $1
           ORDER BY reset_at LIMIT $2 FOR UPDATE SKIP LOCKED
         ) DELETE FROM sign_in_throttle t USING expired e WHERE t.throttle_key = e.throttle_key`,
        [this.now().toISOString(), MAX_EXPIRED_ROWS_PER_ATTEMPT],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private entries(email: string, ip: string): Entry[] {
    return [
      { key: throttleKey("account", email.trim().toLowerCase()), limit: MAX_ACCOUNT_FAILURES },
      { key: throttleKey("source", normalizedSource(ip)), limit: MAX_SOURCE_FAILURES },
    ].sort((a, b) => a.key.localeCompare(b.key));
  }
}

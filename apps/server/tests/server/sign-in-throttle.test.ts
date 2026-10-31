import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { User } from "@launchpad/shared";
import type { AgentService } from "../../src/agent-service.js";
import { createApp } from "../../src/app.js";
import type { Identity } from "../../src/auth-routes.js";
import { loadConfig } from "../../src/config.js";
import { SignInThrottle } from "../../src/sign-in-throttle.js";

// Limits on sign-in attempts. The identity is a stand-in; how long the Postgres
// one takes for an unknown email is in tests/persistence/identity.test.ts.

const PASSWORD = "right password";
const USER: User = {
  id: "00000000-0000-4000-8000-0000000000ee",
  email: "dev@example.test",
  name: "Dev",
  authSubject: "local:dev@example.test",
  platformRole: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const ACCOUNT_LIMIT = 5;
const SOURCE_LIMIT = 30;
const WINDOW_MS = 15 * 60_000;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(overrides: Partial<Identity> = {}) {
  let now = 1_000_000;
  const identity: Identity = {
    signIn: async (email, password) =>
      email.toLowerCase() === USER.email && password === PASSWORD
        ? { token: "a-session-token", user: USER, expiresAt: "2026-10-01T12:00:00.000Z" }
        : null,
    userForToken: async () => null,
    signOut: async () => undefined,
    ...overrides,
  };
  const config = loadConfig({ NODE_ENV: "test" });
  const throttle = new SignInThrottle(() => now);
  app = await createApp(config, {} as unknown as AgentService, { identity, signInThrottle: throttle });
  return {
    advance: (ms: number) => {
      now += ms;
    },
    signIn: (email: string, password: string, remoteAddress = "203.0.113.7") =>
      app!.inject({ method: "POST", url: "/api/auth/session", payload: { email, password }, remoteAddress }),
  };
}

describe("sign-in limits", () => {
  it("locks an account after repeated failures, with Retry-After, even for the right password", async () => {
    const { signIn } = await start();
    for (let attempt = 0; attempt < ACCOUNT_LIMIT; attempt += 1) {
      expect((await signIn(USER.email, "wrong")).statusCode).toBe(401);
    }

    const refused = await signIn(USER.email, PASSWORD);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: "Too many sign-in attempts. Try again later.", code: "rate_limited" });
    expect(Number(refused.headers["retry-after"])).toBe(WINDOW_MS / 1000);
  });

  it("counts an account whatever case its email is typed in", async () => {
    const { signIn } = await start();
    for (let attempt = 0; attempt < ACCOUNT_LIMIT; attempt += 1) {
      await signIn(attempt % 2 === 0 ? "DEV@example.test" : "dev@EXAMPLE.test", "wrong");
    }
    expect((await signIn(USER.email, PASSWORD)).statusCode).toBe(429);
  });

  it("lets the account in again once the window has passed", async () => {
    const { signIn, advance } = await start();
    for (let attempt = 0; attempt < ACCOUNT_LIMIT; attempt += 1) await signIn(USER.email, "wrong");

    advance(WINDOW_MS - 60_000);
    const refused = await signIn(USER.email, PASSWORD);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBe(60);

    advance(60_000);
    expect((await signIn(USER.email, PASSWORD)).statusCode).toBe(201);
  });

  it("resets the account's count after a successful sign-in", async () => {
    const { signIn } = await start();
    for (let attempt = 0; attempt < ACCOUNT_LIMIT - 1; attempt += 1) await signIn(USER.email, "wrong");
    expect((await signIn(USER.email, PASSWORD)).statusCode).toBe(201);

    for (let attempt = 0; attempt < ACCOUNT_LIMIT - 1; attempt += 1) {
      expect((await signIn(USER.email, "wrong")).statusCode).toBe(401);
    }
    expect((await signIn(USER.email, PASSWORD)).statusCode).toBe(201);
  });

  it("treats an unknown email exactly like a wrong password", async () => {
    const { signIn } = await start();
    const responses = [];
    for (let attempt = 0; attempt < ACCOUNT_LIMIT + 1; attempt += 1) {
      const [known, unknown] = [
        await signIn(USER.email, "wrong", "203.0.113.8"),
        await signIn("nobody@example.test", "wrong", "203.0.113.9"),
      ];
      responses.push([known, unknown]);
    }

    for (const [known, unknown] of responses) {
      expect(unknown!.statusCode).toBe(known!.statusCode);
      expect(unknown!.body).toBe(known!.body);
      expect(unknown!.headers["retry-after"]).toBe(known!.headers["retry-after"]);
    }
    expect(responses.at(0)![1]!.statusCode).toBe(401);
    expect(responses.at(-1)![1]!.statusCode).toBe(429);
  });

  it("limits one source guessing across many accounts, without touching other sources", async () => {
    const { signIn } = await start();
    for (let attempt = 0; attempt < SOURCE_LIMIT; attempt += 1) {
      expect((await signIn(`user${attempt}@example.test`, "wrong")).statusCode).toBe(401);
    }
    const refused = await signIn("someone-new@example.test", "wrong");
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBeDefined();
    expect((await signIn(USER.email, PASSWORD, "203.0.113.200")).statusCode).toBe(201);
  });

  it("limits a whole IPv6 /64, however the address is written", async () => {
    const { signIn } = await start();
    for (let attempt = 0; attempt < SOURCE_LIMIT; attempt += 1) {
      await signIn(`user${attempt}@example.test`, "wrong", `2001:db8:1:2::${(attempt + 1).toString(16)}`);
    }
    const sameNetwork = await signIn("new@example.test", "wrong", "2001:0db8:0001:0002:ffff:0:0:1");
    expect(sameNetwork.statusCode).toBe(429);
    expect((await signIn("new@example.test", "wrong", "2001:db8:1:3::1")).statusCode).toBe(401);
  });

  it("does not let a successful sign-in clear the source's failures", async () => {
    const { signIn } = await start();
    for (let attempt = 0; attempt < SOURCE_LIMIT - 1; attempt += 1) await signIn(`user${attempt}@example.test`, "wrong");
    // An attacker with their own account cannot wipe the count by signing in to it.
    expect((await signIn(USER.email, PASSWORD)).statusCode).toBe(201);
    expect((await signIn("new@example.test", "wrong")).statusCode).toBe(401);
    expect((await signIn("newer@example.test", "wrong")).statusCode).toBe(429);
  });

  it("holds a burst of parallel guesses to the limit", async () => {
    const { signIn } = await start();
    const responses = await Promise.all(
      Array.from({ length: ACCOUNT_LIMIT * 4 }, () => signIn(USER.email, "wrong")),
    );
    expect(responses.filter((response) => response.statusCode === 401)).toHaveLength(ACCOUNT_LIMIT);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(ACCOUNT_LIMIT * 3);
  });

  it("does not count an attempt the server could not judge", async () => {
    let failing = true;
    const { signIn } = await start({
      signIn: async (email, password) => {
        if (failing) throw new Error("database unavailable");
        return email === USER.email && password === PASSWORD
          ? { token: "a-session-token", user: USER, expiresAt: "2026-10-01T12:00:00.000Z" }
          : null;
      },
    });
    for (let attempt = 0; attempt < ACCOUNT_LIMIT * 2; attempt += 1) {
      expect((await signIn(USER.email, PASSWORD)).statusCode).toBe(500);
    }
    failing = false;
    expect((await signIn(USER.email, PASSWORD)).statusCode).toBe(201);
  });

  it("does not count a malformed request", async () => {
    const { signIn } = await start();
    for (let attempt = 0; attempt < ACCOUNT_LIMIT * 2; attempt += 1) {
      expect((await signIn("not an email", "wrong")).statusCode).toBe(400);
    }
    expect((await signIn(USER.email, PASSWORD)).statusCode).toBe(201);
  });
});

describe("SignInThrottle memory", () => {
  it("never holds more than its limit, and expired keys make room first", () => {
    let now = 0;
    const throttle = new SignInThrottle(() => now, { maxTrackedKeys: 4 });
    for (let index = 0; index < 1_000; index += 1) {
      expect(throttle.admit(`user${index}@example.test`, `10.0.${index >> 8}.${index & 255}`)).toBeNull();
      expect(throttle.trackedKeys).toBeLessThanOrEqual(8);
    }
    now += WINDOW_MS;
    throttle.admit("later@example.test", "10.9.9.9");
    expect(throttle.trackedKeys).toBe(2);
  });

  it("makes room by dropping the oldest key, keeping newer counts", () => {
    const throttle = new SignInThrottle(() => 0, { maxTrackedKeys: 2 });
    for (let attempt = 0; attempt < ACCOUNT_LIMIT; attempt += 1) throttle.admit("newest@example.test", "10.0.0.1");
    throttle.admit("other@example.test", "10.0.0.2");
    expect(throttle.admit("newest@example.test", "10.0.0.3")).toBeGreaterThan(0);
    throttle.admit("third@example.test", "10.0.0.4");
    // "newest" was the oldest key held, so it is the one that made room.
    expect(throttle.admit("newest@example.test", "10.0.0.5")).toBeNull();
  });
});

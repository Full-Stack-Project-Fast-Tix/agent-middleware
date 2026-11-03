import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { User } from "@launchpad/shared";
import { createApp } from "../../src/app.js";
import type { Identity } from "../../src/auth-routes.js";
import { loadConfig } from "../../src/config.js";

// Sessions replacing the shared token. The identity is a stand-in; the
// Postgres one is tests/persistence/identity.test.ts.

// Shaped like an API key on purpose: the response redactor would mask it.
const TOKEN = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf";
const USER: User = {
  id: "00000000-0000-4000-8000-0000000000ee",
  email: "dev@example.test",
  name: "Dev",
  authSubject: "local:dev@example.test",
  platformRole: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

async function start() {
  const live = new Set<string>();
  const identity: Identity = {
    signIn: async (email, password) => {
      if (email !== USER.email || password !== "right password") return null;
      live.add(TOKEN);
      return { token: TOKEN, user: USER, expiresAt: "2026-10-01T12:00:00.000Z" };
    },
    userForToken: async (token) => (live.has(token) ? USER : null),
    signOut: async (token) => {
      live.delete(token);
    },
  };
  // A shared token is configured too: with identity it must not let anyone in.
  const config = loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "shared-token-that-is-long-enough" });
  app = await createApp(config, { identity });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("session sign-in", () => {
  it("asks for a password, and refuses requests without a live session", async () => {
    await start();
    expect((await app.inject({ url: "/api/auth" })).json()).toEqual({ required: true, method: "password" });
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/auth/me" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/auth/me", headers: bearer("shared-token-that-is-long-enough") })).statusCode).toBe(401);
  });

  it("signs in, hands over the token unredacted, and signs out", async () => {
    await start();
    const wrong = await app.inject({ method: "POST", url: "/api/auth/session", payload: { email: USER.email, password: "nope" } });
    expect(wrong.statusCode).toBe(401);

    const signedIn = await app.inject({ method: "POST", url: "/api/auth/session", payload: { email: USER.email, password: "right password" } });
    expect(signedIn.statusCode).toBe(201);
    expect(signedIn.json().token).toBe(TOKEN);

    expect((await app.inject({ url: "/api/auth/me", headers: bearer(TOKEN) })).json()).toEqual({ user: USER });
    expect((await app.inject({ method: "DELETE", url: "/api/auth/session", headers: bearer(TOKEN) })).statusCode).toBe(204);
    expect((await app.inject({ url: "/api/auth/me", headers: bearer(TOKEN) })).statusCode).toBe(401);
  });

  it("validates the sign-in body", async () => {
    await start();
    const response = await app.inject({ method: "POST", url: "/api/auth/session", payload: { email: "not an email", password: "x" } });
    expect(response.statusCode).toBe(400);
  });

  it("returns the same invalid-credential response and throttles after five failures", async () => {
    await start();
    const unknown = await app.inject({ method: "POST", url: "/api/auth/session", payload: { email: "missing@example.test", password: "nope" } });
    const wrong = await app.inject({ method: "POST", url: "/api/auth/session", payload: { email: USER.email, password: "nope" } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await app.inject({ method: "POST", url: "/api/auth/session", payload: { email: USER.email, password: "nope" } });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({ method: "POST", url: "/api/auth/session", payload: { email: USER.email, password: "right password" } });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.json().retryAfterSeconds).toBeGreaterThan(0);
  });
});

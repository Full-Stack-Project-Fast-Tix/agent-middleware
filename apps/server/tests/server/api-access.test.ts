// The auth hooks must decide from the route that will run, because the router
// decodes a path before matching it. Checking only the raw URL let `/%61pi/agents`
// run the `/api/agents` handler with no credential.

import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "../../src/agent-service.js";
import { createApp } from "../../src/app.js";
import type { Identity } from "../../src/auth-routes.js";
import { loadConfig } from "../../src/config.js";

const service = {
  listAgents: () => [{ id: "visible-only-with-a-credential" }],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const identity = {
  signIn: async () => null,
  signOut: async () => undefined,
  userForToken: async (token: string) => (token === "good" ? { id: "user" } : null),
} as unknown as Identity;

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const encodedPaths = ["/api/agents", "/%61pi/agents", "/%61%70%69/agents", "/ap%69/agents", "/api/%61gents"];

describe("API access", () => {
  it.each(encodedPaths)("refuses %s without the shared token", async (url) => {
    const app = await createApp(loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }), service, {});
    apps.push(app);

    const refused = await app.inject({ method: "GET", url });
    expect(refused.statusCode).toBe(401);
    expect(refused.body).not.toContain("visible-only");

    const allowed = await app.inject({ method: "GET", url, headers: { authorization: "Bearer a-strong-test-token" } });
    expect(allowed.statusCode).toBe(200);
  });

  it.each(encodedPaths)("authenticates then hides the legacy route %s in password mode", async (url) => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, { identity });
    apps.push(app);

    const refused = await app.inject({ method: "GET", url });
    expect(refused.statusCode).toBe(401);
    expect(refused.body).not.toContain("visible-only");

    const hidden = await app.inject({ method: "GET", url, headers: { authorization: "Bearer good" } });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).not.toContain("visible-only");
  });

  it("keeps the open routes open and refuses unknown API paths", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, { identity });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/%61pi/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/not-a-route" })).statusCode).toBe(401);
    // Only POST signs in: reading or deleting a session still needs one.
    expect((await app.inject({ method: "DELETE", url: "/api/auth/session" })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/%61pi/auth/session" })).statusCode).toBe(401);
  });
});

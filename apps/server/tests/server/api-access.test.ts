// The auth hooks must decide from the route that will run, because the router
// decodes a path before matching it. Checking only the raw URL let `/%61pi/agents`
// run the `/api/agents` handler with no credential.

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Identity } from "../../src/auth-routes.js";
import { loadConfig } from "../../src/config.js";

const identity = {
  signIn: async () => null,
  signOut: async () => undefined,
  userForToken: async (token: string) => (token === "good" ? { id: "visible-only-with-a-credential" } : null),
} as unknown as Identity;

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

async function appWithRoute(...args: Parameters<typeof createApp>) {
  const app = await createApp(...args);
  apps.push(app);
  app.get("/api/agents", async () => ({ id: "visible-only-with-a-credential" }));
  return app;
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const encodedPaths = ["/api/agents", "/%61pi/agents", "/%61%70%69/agents", "/ap%69/agents", "/api/%61gents"];

describe("API access", () => {
  it.each(encodedPaths)("refuses %s without the shared token", async (url) => {
    const app = await appWithRoute(loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }));

    const refused = await app.inject({ method: "GET", url });
    expect(refused.statusCode).toBe(401);
    expect(refused.body).not.toContain("visible-only");

    const allowed = await app.inject({ method: "GET", url, headers: { authorization: "Bearer a-strong-test-token" } });
    expect(allowed.statusCode).toBe(200);
  });

  it.each(encodedPaths)("refuses %s without a session in password mode", async (url) => {
    const app = await appWithRoute(loadConfig({ NODE_ENV: "test" }), { identity });

    const refused = await app.inject({ method: "GET", url });
    expect(refused.statusCode).toBe(401);
    expect(refused.body).not.toContain("visible-only");

    const allowed = await app.inject({ method: "GET", url, headers: { authorization: "Bearer good" } });
    expect(allowed.statusCode).toBe(200);
  });

  it("keeps the open routes open and refuses unknown API paths", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), { identity });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/%61pi/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/not-a-route" })).statusCode).toBe(401);
    // Only POST signs in: reading or deleting a session still needs one.
    expect((await app.inject({ method: "DELETE", url: "/api/auth/session" })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/%61pi/auth/session" })).statusCode).toBe(401);
  });

  it("fails the health check when the database cannot answer, without saying why", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), {
      checkDatabase: async () => {
        throw new Error("password authentication failed for user launchpad");
      },
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json().ok).toBe(false);
    expect(response.body).not.toContain("password");
  });
});

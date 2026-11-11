import { existsSync } from "node:fs";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { HttpError } from "../../src/errors.js";

/** The answers every route shares, whatever it does. */
function addRoutes(app: Awaited<ReturnType<typeof createApp>>) {
  app.post("/api/echo", async (request) => z.object({ name: z.string() }).parse(request.body));
  app.get("/api/missing", async () => {
    throw new HttpError(404, "Agent not found");
  });
}

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }));
    addRoutes(app);
    const denied = await app.inject({ method: "GET", url: "/api/missing" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/missing",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(404);
    await app.close();
  });

  it("answers invalid input with its details, and an HttpError with its status", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }));
    addRoutes(app);

    const invalid = await app.inject({ method: "POST", url: "/api/echo", payload: {} });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().details).toBeDefined();

    const missing = await app.inject({ method: "GET", url: "/api/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Agent not found" });
    await app.close();
  });

  // Serving the web app needs its build, which exists by the time CI runs tests.
  const webBuilt = existsSync(new URL("../../../web/dist/index.html", import.meta.url));

  it.skipIf(!webBuilt)("sends the same error body in production as in development", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "production", HOST: "127.0.0.1" }));
    addRoutes(app);
    const missing = await app.inject({ method: "GET", url: "/api/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Agent not found" });
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }));
    addRoutes(app);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/echo",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/echo",
      headers: { "content-type": "application/json" },
      // The app's 15 MiB limit leaves room for bounded browser ZIP uploads.
      payload: JSON.stringify({ name: "x".repeat(15 * 1024 * 1024) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

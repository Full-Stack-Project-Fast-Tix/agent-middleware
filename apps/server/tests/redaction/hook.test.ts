// Route-level proof that the outbound redactor is actually wired in.
//
// `redact.test.ts` proves the redactor works on a string. This file proves the
// hook runs on the responses that were leaking, which is a different claim and
// the one the original defect was about: the patterns were never the problem,
// the missing hook was.
//
// The route below stands in for any route: the point of a global hook is that
// a route added later is covered without anyone remembering to.

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const SECRET = "sk_live_ABCDEFGHIJKLMNOP1234";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function appWithRoutes(traceContents = "") {
  const app = await createApp(loadConfig({ NODE_ENV: "test" }));
  app.get("/api/trace", async (_request, reply) => reply.type("application/x-ndjson").send(traceContents));
  app.get("/api/run", async () => ({
    run: {
      status: "failed",
      output: `exported STRIPE_KEY=${SECRET}`,
      error: `curl -H "Authorization: Bearer ${SECRET}" failed`,
    },
  }));
  cleanups.push(async () => {
    await app.close();
  });
  return app;
}

describe("the outbound redaction hook", () => {
  it("redacts the raw trace, keeping it valid JSON Lines", async () => {
    const records = [
      { seq: 1, at: "2026-08-30T10:00:00.000Z", dir: "out", method: "session/new", payload: {} },
      {
        seq: 2,
        at: "2026-08-30T10:00:01.000Z",
        dir: "in",
        method: "item/completed",
        payload: { stdout: `STRIPE_KEY=${SECRET}` },
      },
    ];
    const ndjson = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const app = await appWithRoutes(ndjson);

    const response = await app.inject({ method: "GET", url: "/api/trace" });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET);
    expect(response.headers["x-redactions"]).toBe("1");

    const lines = response.body.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(records.length);
    const parsed = lines.map((line) => JSON.parse(line) as (typeof records)[number]);
    expect(parsed.map((record) => record.seq)).toEqual([1, 2]);
    expect(parsed[1]?.method).toBe("item/completed");
  }, 15_000);

  it("redacts a JSON body, keeping what surrounds the secret", async () => {
    const app = await appWithRoutes();

    const response = await app.inject({ method: "GET", url: "/api/run" });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET);
    const body = response.json() as { run: { output: string; error: string; status: string } };
    expect(body.run.output).not.toContain(SECRET);
    expect(body.run.error).not.toContain(SECRET);
    // Redaction replaces, never deletes — the surrounding message survives.
    expect(body.run.status).toBe("failed");
    expect(body.run.output).toContain("exported");
  });

  it("sets no x-redactions header when nothing was redacted", async () => {
    const app = await appWithRoutes();

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-redactions"]).toBeUndefined();
    expect(response.json()).toEqual({ ok: true, service: "volc-agent-launchpad" });
  });

  // The hook is scoped by content type precisely so it never touches the built
  // UI. A JS bundle can contain a long base64 run in a source map or an inlined
  // asset, and rewriting those bytes would corrupt the bundle for no benefit.
  it("passes non-JSON content types through untouched", async () => {
    const app = await appWithRoutes();

    const bundle = `export const asset="QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkw";`;
    app.get("/assets/app.js", async (_request, reply) =>
      reply.type("application/javascript").send(bundle),
    );
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/assets/app.js" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(bundle);
    expect(response.headers["x-redactions"]).toBeUndefined();
  });
});

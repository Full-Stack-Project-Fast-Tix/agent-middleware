import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { User } from "@launchpad/shared";
import type { AgentService } from "../../src/agent-service.js";
import { createApp } from "../../src/app.js";
import type { Identity } from "../../src/auth-routes.js";
import { loadConfig } from "../../src/config.js";

// The single-agent routes check no workspace role, so a signed-in account must
// not reach them at all, whatever its role.

const USER: User = {
  id: "00000000-0000-4000-8000-0000000000ee",
  email: "auditor@example.test",
  name: "Auditor",
  authSubject: "local:auditor@example.test",
  platformRole: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const ID = "00000000-0000-4000-8000-0000000000a1";
const LEGACY_ROUTES: Array<["GET" | "POST" | "PUT" | "PATCH" | "DELETE", string]> = [
  ["GET", "/api/system"],
  ["GET", "/api/admin/overview"],
  ["GET", "/api/agents"],
  ["POST", "/api/agents"],
  ["GET", `/api/agents/${ID}`],
  ["PATCH", `/api/agents/${ID}`],
  ["DELETE", `/api/agents/${ID}`],
  ["POST", `/api/agents/${ID}/start`],
  ["POST", `/api/agents/${ID}/stop`],
  ["GET", `/api/agents/${ID}/messages`],
  ["POST", `/api/agents/${ID}/messages`],
  ["GET", `/api/agents/${ID}/runs`],
  ["GET", `/api/agents/${ID}/workspace`],
  ["GET", `/api/agents/${ID}/workspace/file`],
  ["PUT", `/api/agents/${ID}/workspace/file`],
  ["GET", `/api/runs/${ID}`],
  ["POST", `/api/runs/${ID}/approval`],
  ["GET", `/api/runs/${ID}/trace`],
];

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("single-agent routes", () => {
  it.each(LEGACY_ROUTES)("%s %s does not exist for a signed-in user", async (method, url) => {
    const touched: string[] = [];
    const service = new Proxy({}, { get: (_target, name) => () => touched.push(String(name)) }) as unknown as AgentService;
    const identity: Identity = {
      signIn: async () => null,
      userForToken: async () => USER,
      signOut: async () => undefined,
    };
    app = await createApp(loadConfig({ NODE_ENV: "test" }), service, { identity });
    const response = await app.inject({ method, url, headers: { authorization: "Bearer a-session" } });
    expect(response.statusCode).toBe(404);
    expect(touched).toEqual([]);
  });

  it("keeps working with the shared token", async () => {
    const service = { systemInfo: () => ({ ok: true }) } as unknown as AgentService;
    app = await createApp(loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "shared" }), service);
    const response = await app.inject({ method: "GET", url: "/api/system", headers: { authorization: "Bearer shared" } });
    expect(response.statusCode).toBe(200);
  });
});

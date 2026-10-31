import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Approval, RunSnapshot, WorkspaceRole } from "@launchpad/shared";
import type { AgentService } from "../../src/agent-service.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { RunRoutesOptions } from "../../src/run-routes.js";

// Authorisation in the run routes. A run or approval in a workspace the caller
// may not access must look exactly like one that does not exist, and must not
// reach the orchestrator.

const MINE = "00000000-0000-4000-8000-00000000000a";
const THEIRS = "00000000-0000-4000-8000-00000000000b";
const RUN = "00000000-0000-4000-8000-0000000000c1";
const APPROVAL = "00000000-0000-4000-8000-0000000000d1";

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

async function start(runWorkspace: string, role: WorkspaceRole = "developer") {
  const calls: string[] = [];
  const options: RunRoutesOptions = {
    orchestrator: {
      createRun: async (input) => {
        calls.push("createRun");
        return { id: RUN, workspaceId: input.workspaceId } as never;
      },
      cancel: async () => {
        calls.push("cancel");
        return { id: RUN } as never;
      },
      resolveApproval: async () => {
        calls.push("resolveApproval");
        return { id: APPROVAL } as never;
      },
    },
    snapshot: async (runId) => (runId === RUN ? ({ run: { id: RUN, workspaceId: runWorkspace } } as RunSnapshot) : null),
    listRuns: async (_workspaceId, query) => {
      calls.push(`listRuns:${query.limit ?? "default"}:${query.status ?? "any"}`);
      return { runs: [], nextCursor: null, pendingApprovalCount: 3 };
    },
    approval: async (approvalId) => (approvalId === APPROVAL ? ({ id: APPROVAL, runId: RUN } as Approval) : null),
    currentUserId: () => "00000000-0000-4000-8000-0000000000ee",
    workspaceRole: async (workspaceId) => (workspaceId === MINE ? role : null),
    listWorkspaces: async () => [{ id: MINE, name: "Mine" }],
    listAgents: async () => [],
  };
  app = await createApp(loadConfig({ NODE_ENV: "test" }), {} as AgentService, { runs: options });
  return calls;
}

const inject = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });

describe("run routes", () => {
  it("serves runs and approvals in the caller's own workspace", async () => {
    const calls = await start(MINE);
    expect((await inject("POST", `/api/workspaces/${MINE}/runs`, { userPrompt: "Add validation" })).statusCode).toBe(201);
    expect((await inject("GET", `/api/runs/${RUN}/snapshot`)).statusCode).toBe(200);
    expect((await inject("POST", `/api/runs/${RUN}/cancel`)).statusCode).toBe(202);
    expect((await inject("POST", `/api/approvals/${APPROVAL}/resolve`, { decision: "approve" })).statusCode).toBe(200);
    expect(calls).toEqual(["createRun", "cancel", "resolveApproval"]);
    expect((await inject("GET", "/api/workspaces")).json()).toEqual({ workspaces: [{ id: MINE, name: "Mine" }] });
    expect((await inject("GET", `/api/workspaces/${MINE}/agents`)).json()).toEqual({ agents: [] });
  });

  it("answers 404 for another workspace's runs and approvals, without acting on them", async () => {
    const calls = await start(THEIRS);
    const responses = [
      await inject("POST", `/api/workspaces/${THEIRS}/runs`, { userPrompt: "Add validation" }),
      await inject("GET", `/api/runs/${RUN}/snapshot`),
      await inject("POST", `/api/runs/${RUN}/cancel`),
      await inject("POST", `/api/approvals/${APPROVAL}/resolve`, { decision: "approve" }),
      await inject("GET", `/api/workspaces/${THEIRS}/agents`),
    ];
    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404]);
    expect(responses.map((response) => response.json().error)).toEqual([
      "Workspace not found",
      "Run not found",
      "Run not found",
      "Approval not found",
      "Workspace not found",
    ]);
    expect(calls).toEqual([]);
  });

  it("lets an auditor read but not act", async () => {
    const calls = await start(MINE, "auditor");
    expect((await inject("GET", `/api/runs/${RUN}/snapshot`)).statusCode).toBe(200);
    expect((await inject("GET", `/api/workspaces/${MINE}/agents`)).statusCode).toBe(200);
    const responses = [
      await inject("POST", `/api/workspaces/${MINE}/runs`, { userPrompt: "Add validation" }),
      await inject("POST", `/api/runs/${RUN}/cancel`),
      await inject("POST", `/api/approvals/${APPROVAL}/resolve`, { decision: "approve" }),
    ];
    expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403]);
    expect(calls).toEqual([]);
  });

  it("lists a workspace's runs for any role, and hides another workspace's", async () => {
    const calls = await start(MINE, "auditor");
    const listed = await inject("GET", `/api/workspaces/${MINE}/runs?limit=20&status=waiting_approval`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ runs: [], nextCursor: null, pendingApprovalCount: 3 });
    expect(calls).toEqual(["listRuns:20:waiting_approval"]);

    const hidden = await inject("GET", `/api/workspaces/${THEIRS}/runs`);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error).toBe("Workspace not found");
    expect(calls).toHaveLength(1);
  });

  it("refuses an unbounded page or an unknown status", async () => {
    const calls = await start(MINE);
    expect((await inject("GET", `/api/workspaces/${MINE}/runs?limit=201`)).statusCode).toBe(400);
    expect((await inject("GET", `/api/workspaces/${MINE}/runs?limit=0`)).statusCode).toBe(400);
    expect((await inject("GET", `/api/workspaces/${MINE}/runs?status=done`)).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("validates ids and bodies", async () => {
    await start(MINE);
    expect((await inject("GET", "/api/runs/not-an-id/snapshot")).statusCode).toBe(400);
    expect((await inject("POST", `/api/workspaces/${MINE}/runs`, { userPrompt: "  " })).statusCode).toBe(400);
    expect((await inject("POST", `/api/approvals/${APPROVAL}/resolve`, { decision: "maybe" })).statusCode).toBe(400);
  });
});

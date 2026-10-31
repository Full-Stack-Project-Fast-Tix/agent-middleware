import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Approval, RunSnapshot, WorkspaceRole } from "@launchpad/shared";
import { apiPaths } from "@launchpad/shared";
import type { AgentService } from "../../src/agent-service.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { RunRoutesOptions } from "../../src/run-routes.js";
import { traceFilePath } from "../../src/trace.js";

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
    snapshot: async (runId) => (runId === RUN ? ({ run: { id: RUN, workspaceId: runWorkspace }, approvals: [] } as unknown as RunSnapshot) : null),
    runAudit: async (_runId, eventType) => {
      calls.push(`runAudit:${eventType}`);
      return { events: [], total: 0 };
    },
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

describe("an attempt's trace", () => {
  const EXECUTION = "00000000-0000-4000-8000-0000000000f1";
  const UNTRACED = "00000000-0000-4000-8000-0000000000f2";
  const OTHER_RUNS = "00000000-0000-4000-8000-0000000000f3";
  const SECRET = "sk_live_ABCDEFGHIJKLMNOP1234";
  let directory: string;

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** A Run with two executions, one traced; another Run's trace also sits on disk. */
  async function startWithTrace(runWorkspace: string, role: WorkspaceRole = "developer") {
    directory = await mkdtemp(path.join(tmpdir(), "run-trace-"));
    const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: directory });
    const line = JSON.stringify({ seq: 1, dir: "in", method: "codex/event", payload: { stdout: `STRIPE_KEY=${SECRET}` } });
    await mkdir(path.dirname(traceFilePath(config.dataDirectory, EXECUTION)), { recursive: true });
    await writeFile(traceFilePath(config.dataDirectory, EXECUTION), `${line}\n`, "utf8");
    await writeFile(traceFilePath(config.dataDirectory, OTHER_RUNS), `${line}\n`, "utf8");
    const options = {
      snapshot: async (runId: string) =>
        runId === RUN ? ({ run: { id: RUN, workspaceId: runWorkspace }, executions: [{ id: EXECUTION }, { id: UNTRACED }] } as RunSnapshot) : null,
      currentUserId: () => "00000000-0000-4000-8000-0000000000ee",
      workspaceRole: async (workspaceId: string) => (workspaceId === MINE ? role : null),
    } as unknown as RunRoutesOptions;
    app = await createApp(config, {} as AgentService, { runs: options });
  }

  it("serves the attempt's trace redacted, as JSON Lines, to an acting role", async () => {
    await startWithTrace(MINE, "developer");
    const response = await inject("GET", apiPaths.executionTrace(RUN, EXECUTION));

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(response.body).not.toContain(SECRET);
    expect(response.headers["x-redactions"]).toBe("1");
    expect(() => JSON.parse(response.body.trim())).not.toThrow();
  });

  it("keeps raw traces from auditors, who use the bounded timeline instead", async () => {
    await startWithTrace(MINE, "auditor");
    const response = await inject("GET", apiPaths.executionTrace(RUN, EXECUTION));

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("The auditor role cannot read raw execution traces");
    expect(response.body).not.toContain(SECRET);
  });

  it("answers 404 for a run in another workspace, like one that does not exist", async () => {
    await startWithTrace(THEIRS);
    const response = await inject("GET", apiPaths.executionTrace(RUN, EXECUTION));

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("Run not found");
    expect(response.body).not.toContain(SECRET);
  });

  it("serves only an execution of the named run, whatever is on disk", async () => {
    await startWithTrace(MINE);
    const response = await inject("GET", apiPaths.executionTrace(RUN, OTHER_RUNS));

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("Execution not found");
  });

  it("answers 404 for an execution with no trace file", async () => {
    await startWithTrace(MINE);
    const response = await inject("GET", apiPaths.executionTrace(RUN, UNTRACED));

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("No trace for this execution");
  });

  it("rejects an execution id that is not an id", async () => {
    await startWithTrace(MINE);
    for (const id of ["..%2F..%2Fetc%2Fpasswd", `..%2F${OTHER_RUNS}`, "not-an-id"]) {
      const response = await inject("GET", `/api/runs/${RUN}/executions/${id}/trace`);
      expect(response.statusCode, id).toBe(400);
      expect(response.body).not.toContain(SECRET);
    }
  });
});

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

  it("serves a run's timeline to any role, and hides another workspace's", async () => {
    const calls = await start(MINE, "auditor");
    const timeline = await inject("GET", `/api/runs/${RUN}/timeline`);
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().timeline).toEqual({
      entries: [],
      omittedEntries: 0,
      fileChanges: { items: [], truncated: false, entriesWithoutFileList: 0, allowedCommands: 0 },
    });
    expect(calls).toEqual(["runAudit:security.decision", "runAudit:delegation.requested"]);
    await app.close();

    const hiddenCalls = await start(THEIRS);
    const hidden = await inject("GET", `/api/runs/${RUN}/timeline`);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error).toBe("Run not found");
    expect(hiddenCalls).toEqual([]);
    expect((await inject("GET", "/api/runs/not-an-id/timeline")).statusCode).toBe(400);
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

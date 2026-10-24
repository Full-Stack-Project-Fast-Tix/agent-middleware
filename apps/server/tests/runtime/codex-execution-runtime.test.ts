import { describe, expect, it } from "vitest";
import type { Agent, AgentExecution, Run, Task } from "@launchpad/shared";
import type { RuntimeSession, RuntimeSessionRequest } from "../../src/container-codex-runner.js";
import { RunCancelledError } from "../../src/errors.js";
import { UngatedRuntimePolicyError } from "../../src/gated-turn.js";
import { CodexExecutionRuntime } from "../../src/orchestrator/codex-execution-runtime.js";
import type { ExecutionRequest } from "../../src/orchestrator/ports.js";
import type { TraceSummary } from "../../src/trace.js";
import { FakeAppServer } from "./fake-app-server.js";

/** Stands in for ContainerCodexRunner: a FakeAppServer instead of a container. */
function fakeRunner(play: (server: FakeAppServer) => Promise<void>) {
  const sessions: RuntimeSessionRequest[] = [];
  const cancelled: string[] = [];
  const runner = {
    async session<T>(request: RuntimeSessionRequest, drive: (session: RuntimeSession) => Promise<T>) {
      sessions.push(request);
      const server = new FakeAppServer();
      const [result] = await Promise.all([drive(server.session), play(server)]);
      const trace: TraceSummary = { path: `/data/traces/${request.traceId}.jsonl`, events: 3, bytes: 10, truncated: false };
      return { result, trace, records: server.session.records };
    },
    async cancel(executionId: string) {
      cancelled.push(executionId);
      return true;
    },
  };
  return { runner, sessions, cancelled };
}

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    run: { id: "run-1" } as Run,
    task: { id: "task-1", title: "Add validation" } as Task,
    execution: { id: "execution-1" } as AgentExecution,
    agent: { id: "agent-1" } as Agent,
    workingDirectory: "/data/runs/run-1/workspace",
    prompt: "Add validation",
    runtimePolicy: { sandboxMode: "workspace-write", denyNetwork: true, approvalPolicy: "untrusted", semanticEnforcement: true, effectGating: true },
    gate: { decide: async () => ({ outcome: "allow", reason: "ok", severity: "info", findings: [], appliedPolicies: [] }), observe: async () => null },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("CodexExecutionRuntime", () => {
  it("runs one execution in its own container on the run's working copy", async () => {
    const { runner, sessions } = fakeRunner(async (server) => {
      await server.turnStarted();
      server.finish("Validation added.");
    });
    const outcome = await new CodexExecutionRuntime(runner).execute(request());

    expect(sessions).toEqual([
      { agentId: "agent-1", executionId: "execution-1", workspacePath: "/data/runs/run-1/workspace", traceId: "execution-1" },
    ]);
    expect(outcome).toEqual({
      output: "Validation added.",
      threadId: "thread-1",
      usage: null,
      tracePath: "/data/traces/execution-1.jsonl",
      traceTruncated: false,
    });
  });

  it("refuses an ungated policy before any container starts", async () => {
    const { runner, sessions } = fakeRunner(async () => undefined);
    await expect(
      new CodexExecutionRuntime(runner).execute(
        request({ runtimePolicy: { sandboxMode: "read-only", denyNetwork: false, semanticEnforcement: false, effectGating: false } }),
      ),
    ).rejects.toBeInstanceOf(UngatedRuntimePolicyError);
    expect(sessions).toEqual([]);
  });

  it("stops the container when the run is cancelled", async () => {
    const controller = new AbortController();
    const { runner, cancelled } = fakeRunner(async (server) => {
      await server.turnStarted();
      controller.abort();
      // What removing the container does to the session.
      server.exit();
    });
    await expect(new CodexExecutionRuntime(runner).execute(request({ signal: controller.signal }))).rejects.toBeInstanceOf(Error);
    expect(cancelled).toEqual(["execution-1"]);

    const before = new AbortController();
    before.abort();
    await expect(new CodexExecutionRuntime(runner).execute(request({ signal: before.signal }))).rejects.toBeInstanceOf(RunCancelledError);
  });

  it("treats a turn that ends without a message as a failure, with the trace attached", async () => {
    const { runner } = fakeRunner(async (server) => {
      await server.turnStarted();
      server.notify("turn/completed", { turn: { id: "turn-1" } });
    });
    const failure = await new CodexExecutionRuntime(runner).execute(request()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: "Codex completed without an agent message", trace: { path: "/data/traces/execution-1.jsonl" } });
  });
});

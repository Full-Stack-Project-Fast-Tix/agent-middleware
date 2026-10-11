import { attachTrace, RunCancelledError } from "../errors.js";
import type { ContainerCodexRunner } from "../container-codex-runner.js";
import { assertGatedPolicy, runGatedTurn } from "../gated-turn.js";
import type { ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "./ports.js";

/**
 * Runs one AgentExecution as one Codex turn in its own disposable container,
 * with the Run's working copy mounted at /workspace. Every command and file
 * change waits at an approval request for the ActionGate (gated-turn.ts).
 *
 * The trace file is named after the execution, so a retry gets its own.
 */
export class CodexExecutionRuntime implements ExecutionRuntime {
  constructor(private readonly runner: Pick<ContainerCodexRunner, "session" | "cancel">) {}

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    // Before a container starts: an ungated policy must not run anything.
    assertGatedPolicy(request.runtimePolicy);
    if (request.signal.aborted) throw new RunCancelledError();

    const onAbort = (): void => {
      void this.runner.cancel(request.execution.id);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const { result, trace } = await this.runner.session(
        {
          agentId: request.agent.id,
          executionId: request.execution.id,
          workspacePath: request.workingDirectory,
          traceId: request.execution.id,
        },
        (session) =>
          runGatedTurn({
            rpc: session.rpc,
            prompt: request.prompt,
            policy: request.runtimePolicy,
            gate: request.gate,
            records: session.records,
            onRecord: session.onRecord,
            exited: session.exited,
            signal: request.signal,
          }),
      );
      // A stopped execution may end without a message; the orchestrator fails it anyway.
      if (result.output === "" && !result.stopped) {
        throw attachTrace(new Error("Codex completed without an agent message"), trace);
      }
      return {
        output: result.output,
        threadId: result.threadId,
        usage: result.usage,
        tracePath: trace.path,
        traceTruncated: trace.truncated,
      };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}

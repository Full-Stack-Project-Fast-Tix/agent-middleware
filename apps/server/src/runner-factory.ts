import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { HttpError } from "./errors.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";

/** Said wherever the legacy path is reached with the Claude provider selected. */
export const PLAYGROUND_NEEDS_CODEX =
  "The Playground runs single agents on Codex, which is unavailable with MODEL_PROVIDER=anthropic. Use Runs, which run on Claude.";

/**
 * The legacy single-agent path speaks Codex's protocol. Under the Claude provider
 * it gets this instead of a Codex runner, so it says why it cannot run, and the
 * Anthropic key cannot reach a Codex container by way of the runner's environment.
 */
export class CodexUnavailableRunner implements AgentRunner {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async run(_request: RunnerRequest): Promise<RunnerResult> {
    throw new HttpError(503, PLAYGROUND_NEEDS_CODEX);
  }

  async cancel(_executionId: string): Promise<boolean> {
    return false;
  }
}

export function createRunner(config: AppConfig): AgentRunner {
  if (config.modelProvider === "anthropic") return new CodexUnavailableRunner();
  return config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config)
    : new CodexRunner(config);
}

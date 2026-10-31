import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "./config.js";
import { redactSensitiveText } from "./redaction/index.js";

// The one place the server builds a Claude client, and what every Claude call
// has in common. The key is read from configuration and held by this client on
// the host. It is never handed to a container, a trace or an error message.

/** The part of the SDK client AgentGuard calls. Tests pass a real client pointed at a local mock. */
export type ClaudeClient = Pick<Anthropic, "beta">;

export function createClaudeClient(config: Pick<AppConfig, "modelApiKey" | "anthropicBaseUrl">): Anthropic {
  return new Anthropic({
    // Explicit, so the SDK does not go looking for ambient credentials or
    // profiles on this machine. Retries stay with the SDK: 408, 409, 429, 5xx and
    // connection errors, twice.
    apiKey: config.modelApiKey,
    ...(config.anthropicBaseUrl === null ? {} : { baseURL: config.anthropicBaseUrl }),
    logLevel: "warn",
  });
}

/**
 * Opt in to server-side refusal fallback on every call. A classifier that flags
 * a benign request then re-runs it on another model instead of failing it. The
 * `default` mode is a no-op on a model with no fallback, so it is safe with any
 * configured model.
 */
export const CLAUDE_FALLBACKS: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

/** Tokens one API response billed, across every attempt a fallback made. */
export interface ClaudeTokenUse {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export function tokenUseOf(usage: Anthropic.Beta.BetaUsage): ClaudeTokenUse {
  // Top-level usage covers only the attempt that produced the message; with a
  // fallback, usage.iterations is the per-attempt record.
  const attempts = usage.iterations;
  if (attempts !== null && attempts !== undefined && attempts.length > 0) {
    return attempts.reduce<ClaudeTokenUse>(
      (total, attempt) => ({
        input: total.input + attempt.input_tokens,
        cacheWrite: total.cacheWrite + (attempt.cache_creation_input_tokens ?? 0),
        cacheRead: total.cacheRead + (attempt.cache_read_input_tokens ?? 0),
        output: total.output + attempt.output_tokens,
      }),
      { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    );
  }
  return {
    input: usage.input_tokens,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens,
  };
}

/**
 * After a fallback the blocks before the last `fallback` block belong to the
 * attempt that was declined: a tool_use among them can be cut off mid-input and
 * must never run. Returns what the served attempt produced.
 */
export function servedBlocks(content: readonly Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlock[] {
  const boundary = content.map((block) => block.type).lastIndexOf("fallback");
  return content.slice(boundary + 1);
}

/** A useful reason for a refused response, without trusting its text. */
export function refusalMessage(message: Pick<Anthropic.Beta.BetaMessage, "stop_details">): string {
  const details = message.stop_details;
  if (details === null || details === undefined) return "no reason given";
  const category = details.category ?? "uncategorised";
  return details.explanation === null ? category : `${category}: ${details.explanation}`;
}

/**
 * The text of a tool-less structured response, or a thrown error. A refusal or a
 * cut-off response is not an answer, and the caller's schema is not asked to
 * judge one.
 */
export function structuredText(message: Anthropic.Beta.BetaMessage, label: string): string {
  if (message.stop_reason === "refusal") {
    throw new Error(`${label}: Claude refused the request (${refusalMessage(message)})`);
  }
  if (message.stop_reason !== "end_turn") {
    throw new Error(`${label}: Claude stopped early (${String(message.stop_reason)})`);
  }
  const text = servedBlocks(message.content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  if (text.trim() === "") throw new Error(`${label}: Claude returned no text`);
  return text;
}

/**
 * An error safe to store, show and log. API errors become a sentence naming what
 * to do. Everything is scrubbed for the key and for credential shapes, because
 * this text goes into execution records and the trace.
 */
export function describeClaudeError(error: unknown, apiKey: string): string {
  let message: string;
  if (error instanceof Anthropic.AuthenticationError) {
    message = "Anthropic rejected ANTHROPIC_API_KEY (401). Check the key and restart.";
  } else if (error instanceof Anthropic.PermissionDeniedError) {
    message = "This Anthropic key may not use that model or feature (403).";
  } else if (error instanceof Anthropic.NotFoundError) {
    message = "Anthropic does not know the configured model, or this organization cannot use it (404). Check ANTHROPIC_MODEL.";
  } else if (error instanceof Anthropic.RateLimitError) {
    message = "Anthropic rate limit reached after the SDK's retries (429).";
  } else if (error instanceof Anthropic.BadRequestError) {
    message = `Anthropic rejected the request (400): ${error.message}`;
  } else if (error instanceof Anthropic.APIConnectionError) {
    message = `Could not reach the Anthropic API: ${error.message}`;
  } else if (error instanceof Anthropic.APIError) {
    message = `Anthropic API error (${String(error.status)}): ${error.message}`;
  } else {
    message = error instanceof Error ? error.message : String(error);
  }
  const withoutKey = apiKey === "" ? message : message.replaceAll(apiKey, "[redacted]");
  return redactSensitiveText(withoutKey).slice(0, 2_000);
}

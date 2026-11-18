import { readFileSync } from "node:fs";
import { ModelTokenBudget } from "../../src/model-token-budget.js";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { describeClaudeError, refusalMessage, servedBlocks, structuredText, tokenUseOf } from "../../src/anthropic-client.js";
import { assertModelProviderReady, isModelConfigured, loadConfig } from "../../src/config.js";
import { ClaudePlanner, createModelPlanner } from "../../src/orchestrator/planner.js";
import {
  ClaudeSemanticIntentMonitor,
  createSemanticIntentMonitor,
  type SemanticMonitorInput,
} from "../../src/semantic-intent-monitor.js";
import { AGENTS, SIGNUP_PLAN } from "../orchestrator/fixtures.js";
import { startMockAnthropic, TEST_API_KEY, text, thinking, type MockAnthropic, type MockTurn } from "./claude-fakes.js";

let mock: MockAnthropic | null = null;
afterEach(async () => {
  await mock?.close();
  mock = null;
});

const PLAN_REQUEST = {
  userPrompt: "Add input validation to the signup endpoint",
  agents: [
    { id: AGENTS.analyst, name: "analyst", description: "Reads code" },
    { id: AGENTS.developer, name: "developer", description: null },
  ],
  maxTasks: 4,
};

async function planner(turns: MockTurn[], timeoutMs = 5_000) {
  mock = await startMockAnthropic(turns);
  return new ClaudePlanner({ client: mock.client, model: "claude-opus-5-5", timeoutMs });
}

describe("ClaudePlanner", () => {
  it("refuses a planner call before HTTP when the shared Run budget cannot cover it", async () => {
    const model = await planner([]);
    await expect(model.plan({ ...PLAN_REQUEST, budget: new ModelTokenBudget(1_000) })).rejects.toThrow("token budget");
    expect(mock!.requests).toHaveLength(0);
  });
  it("returns a schema-valid plan, asking for structured output and an explicit effort", async () => {
    const plan = await (await planner([{ content: [thinking("planning"), text(JSON.stringify(SIGNUP_PLAN))], stop_reason: "end_turn" }])).plan(PLAN_REQUEST);

    expect(plan).toEqual(SIGNUP_PLAN);
    const { body, headers } = mock!.requests[0]!;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config.effort).toBe("medium");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.required).toEqual(["tasks"]);
    expect(body.fallbacks).toBe("default");
    expect(headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("temperature");
    expect(body.messages[0].content).toContain(PLAN_REQUEST.userPrompt);
  });

  it("rejects a plan the schema rejects", async () => {
    const invalid = JSON.stringify({ tasks: [{ key: "a", title: "t", objective: "o", agentId: "not-a-guid" }] });
    await expect((await planner([{ content: [text(invalid)], stop_reason: "end_turn" }])).plan(PLAN_REQUEST)).rejects.toThrow();
  });

  it("rejects output that is not JSON", async () => {
    await expect((await planner([{ content: [text("I would read the README first.")], stop_reason: "end_turn" }])).plan(PLAN_REQUEST)).rejects.toThrow("not JSON");
  });

  it("rejects a refusal and a cut-off response, whatever text came with them", async () => {
    const refused: MockTurn = { content: [text(JSON.stringify(SIGNUP_PLAN))], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } };
    await expect((await planner([refused])).plan(PLAN_REQUEST)).rejects.toThrow("refused the request (cyber)");
    await mock!.close();
    const cut: MockTurn = { content: [text(JSON.stringify(SIGNUP_PLAN))], stop_reason: "max_tokens" };
    await expect((await planner([cut])).plan(PLAN_REQUEST)).rejects.toThrow("stopped early (max_tokens)");
  });

  it("gives up at its timeout", async () => {
    await expect((await planner([{ hang: true }], 50)).plan(PLAN_REQUEST)).rejects.toThrow();
  });

  it("stops when the run is cancelled", async () => {
    const claude = await planner([{ hang: true }]);
    const controller = new AbortController();
    const planning = claude.plan({ ...PLAN_REQUEST, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await expect(planning).rejects.toThrow();
  });
});

const ASSESSMENT = {
  riskScore: 0.1,
  confidence: 0.9,
  classification: "aligned",
  apparentObjective: "Fix the bug",
  conflictsWithTask: false,
  evidenceSeqs: [1],
  rationale: "Stays on task.",
  effectAssessments: [],
};

const INPUT: SemanticMonitorInput = {
  checkpoint: "command",
  trustedTask: { userPrompt: "Fix the bug", agentInstructions: "" },
  recentReasoning: [],
  recentActions: [{ seq: 1, type: "tool_output", summary: "cat .env\nOutput: API_KEY=sk_live_51ExampleExampleExampleExample" }],
  recentSources: [],
  cheapIntentSignal: false,
};

async function monitor(turns: MockTurn[], timeoutMs = 5_000) {
  mock = await startMockAnthropic(turns);
  return new ClaudeSemanticIntentMonitor({ client: mock.client, model: "claude-opus-5-5", timeoutMs });
}

describe("ClaudeSemanticIntentMonitor", () => {
  it("uses the reserved capacity only for a final-review call", async () => {
    const model = await monitor([{ content: [text(JSON.stringify(ASSESSMENT))], stop_reason: "end_turn" }]);
    const budget = new ModelTokenBudget(30_000);
    await expect(model.assess(INPUT, { budget })).rejects.toThrow("token budget");
    expect(mock!.requests).toHaveLength(0);
    await expect(model.assess({ ...INPUT, checkpoint: "final_diff" }, { budget, finalReview: true })).resolves.toMatchObject({ classification: "aligned" });
    expect(mock!.requests).toHaveLength(1);
    expect(budget.snapshot().reserved).toBe(0);
    expect(budget.snapshot().charged).toBeGreaterThan(0);
  });
  it("returns a valid assessment from a redacted, tool-less call", async () => {
    const assessment = await (await monitor([{ content: [text(JSON.stringify(ASSESSMENT))], stop_reason: "end_turn" }])).assess(INPUT);

    // The monitor's own usage comes back separately, never mixed into agent execution usage.
    const { usage, ...rest } = assessment;
    expect(rest).toEqual(ASSESSMENT);
    expect(usage).toEqual({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) });
    const { body } = mock!.requests[0]!;
    expect(JSON.stringify(body)).not.toContain("sk_live_51Example");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body).not.toHaveProperty("tools");
    expect(body.max_tokens).toBeGreaterThanOrEqual(4_000);
  });

  it("keeps tolerating harmless formatting drift, and nothing more", async () => {
    const drifted = { ...ASSESSMENT, evidenceSeqs: ["1"], rationale: "x".repeat(2_000) };
    const assessment = await (await monitor([{ content: [text(JSON.stringify(drifted))], stop_reason: "end_turn" }])).assess(INPUT);
    expect(assessment.evidenceSeqs).toEqual([1]);
    expect(assessment.rationale).toHaveLength(1_000);
  });

  it.each<[string, MockTurn]>([
    ["output outside the schema", { content: [text(JSON.stringify({ ...ASSESSMENT, riskScore: 7 }))], stop_reason: "end_turn" }],
    ["an unknown classification", { content: [text(JSON.stringify({ ...ASSESSMENT, classification: "fine" }))], stop_reason: "end_turn" }],
    ["a refusal", { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "reasoning_extraction", explanation: null } }],
    ["a cut-off response", { content: [text("{")], stop_reason: "max_tokens" }],
    ["an API error", { status: 400 }],
    ["no text", { content: [thinking("hmm")], stop_reason: "end_turn" }],
  ])("rejects %s, so the controller fails closed", async (_label, turn) => {
    await expect((await monitor([turn])).assess(INPUT)).rejects.toThrow();
  });

  it("rejects at its timeout", async () => {
    await expect((await monitor([{ hang: true }], 50)).assess(INPUT)).rejects.toThrow();
  });
});

describe("selecting Claude", () => {
  const anthropic = loadConfig({ NODE_ENV: "test", ANTHROPIC_API_KEY: TEST_API_KEY });

  it("uses Claude for the planner and the monitor", () => {
    expect(createModelPlanner(anthropic)).toBeInstanceOf(ClaudePlanner);
    expect(createSemanticIntentMonitor(anthropic)).toBeInstanceOf(ClaudeSemanticIntentMonitor);
  });

});

describe("Claude configuration", () => {
  it("defaults the model to Claude Opus 5.5, and the image to the tool runtime", () => {
    const config = loadConfig({ NODE_ENV: "test", ANTHROPIC_API_KEY: TEST_API_KEY });
    expect(config.modelName).toBe("claude-opus-5-5");
    expect(config.modelApiKey).toBe(TEST_API_KEY);
    expect(config.containerRuntimeImage).toBe("agentguard-claude-runtime:local");
    expect(isModelConfigured(config)).toBe(true);
  });

  it("takes overrides for the model, the semantic model and the limits", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ANTHROPIC_MODEL: "claude-sonnet-5-5",
      GUARDRAIL_SEMANTIC_MODEL: "claude-haiku-5-5",
      CLAUDE_EFFORT: "medium",
      CLAUDE_MAX_ITERATIONS: "5",
      CLAUDE_TOOL_OUTPUT_MAX_BYTES: "4096",
    });
    expect(config.modelName).toBe("claude-sonnet-5-5");
    expect(config.semanticGuardModel).toBe("claude-haiku-5-5");
    expect(config.claude).toMatchObject({ effort: "medium", maxIterations: 5, toolOutputMaxBytes: 4_096 });
  });

  it("refuses to start with no key, or the placeholder from .env.example", () => {
    const missing = loadConfig({ NODE_ENV: "test" });
    expect(() => assertModelProviderReady(missing)).toThrow("needs ANTHROPIC_API_KEY");
    const placeholder = loadConfig({ NODE_ENV: "test", ANTHROPIC_API_KEY: "replace-with-your-anthropic-api-key" });
    expect(() => assertModelProviderReady(placeholder)).toThrow("ANTHROPIC_API_KEY");
    expect(() => assertModelProviderReady(loadConfig({ NODE_ENV: "test", ANTHROPIC_API_KEY: TEST_API_KEY }))).not.toThrow();
  });

  it("documents Claude in .env.example, with placeholders and working values", () => {
    const template = parseEnv(readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8"));
    const config = loadConfig({ ...template, NODE_ENV: "test" });

    expect(config.modelName).toBe("claude-haiku-5-5");
    expect(config.authMode).toBe("password");
    expect(config.containerRuntimeImage).toBe("agentguard-claude-runtime:local");
    expect(template.ANTHROPIC_API_KEY).toMatch(/^replace-/);
    expect(() => assertModelProviderReady(config)).toThrow("ANTHROPIC_API_KEY");
    // The bounded defaults the docs' cost table is written against.
    expect(config.claude).toEqual({
      effort: "medium",
      maxIterations: 20,
      maxTokensPerCall: 32_000,
      maxTotalOutputTokens: 50_000,
      maxTotalInputTokens: 500_000,
      executionTimeoutMs: 900_000,
      commandTimeoutMs: 120_000,
      toolOutputMaxBytes: 32_768,
      maxEditFileBytes: 1_048_576,
    });
  });
});

describe("reading Claude's responses", () => {
  const FALLBACK = { type: "fallback", from: { model: "a" }, to: { model: "b" } };

  it("takes only what the served attempt produced", () => {
    const blocks = [{ type: "text", text: "declined" }, FALLBACK, { type: "text", text: "served" }] as never[];
    expect(servedBlocks(blocks)).toEqual([{ type: "text", text: "served" }]);
    expect(servedBlocks([{ type: "text", text: "plain" }] as never[])).toEqual([{ type: "text", text: "plain" }]);
  });

  it("reads structured text from the served attempt", () => {
    const message = { stop_reason: "end_turn", content: [{ type: "text", text: "no" }, FALLBACK, { type: "text", text: "{}" }] } as never;
    expect(structuredText(message, "x")).toBe("{}");
  });

  it("describes a refusal without a category", () => {
    expect(refusalMessage({ stop_details: null })).toBe("no reason given");
    expect(refusalMessage({ stop_details: { type: "refusal", category: null, explanation: null } as never })).toBe("uncategorised");
  });

  it("sums attempts when usage has them", () => {
    expect(tokenUseOf({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null, iterations: null } as never)).toEqual({ input: 1, cacheWrite: 0, cacheRead: 0, output: 2 });
  });

  it("scrubs the key and credential shapes from any error", () => {
    expect(describeClaudeError(new Error(`boom ${TEST_API_KEY}`), TEST_API_KEY)).toBe("boom [redacted]");
    expect(describeClaudeError(new Error("leak sk_live_51ExampleExampleExampleExample"), "")).not.toContain("sk_live_51Example");
    expect(describeClaudeError("text", "")).toBe("text");
  });
});

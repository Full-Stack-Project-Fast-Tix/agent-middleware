import { describe, expect, it } from "vitest";
import { readUsage } from "../../src/run-turn.js";

describe("readUsage", () => {
  it("reads the running totals from Codex's thread/tokenUsage/updated", () => {
    const params = {
      threadId: "t",
      tokenUsage: {
        total: { totalTokens: 92_090, inputTokens: 84_760, cachedInputTokens: 75_712, outputTokens: 7_330 },
        last: { totalTokens: 16_236, inputTokens: 15_841, cachedInputTokens: 15_040, outputTokens: 395 },
      },
    };
    expect(readUsage(params)).toEqual({ inputTokens: 84_760, cachedInputTokens: 75_712, outputTokens: 7_330 });
  });

  it("still reads the flat shapes, and answers null when there is nothing", () => {
    expect(readUsage({ usage: { input_tokens: 3, output_tokens: 4 } })).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(readUsage({ threadId: "t" })).toBeNull();
  });
});

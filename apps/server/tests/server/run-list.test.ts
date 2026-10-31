import { RUN_SUMMARY_PROMPT_LENGTH } from "@launchpad/shared";
import { describe, expect, it } from "vitest";
import { summaryPrompt } from "../../src/run-list.js";

describe("summaryPrompt", () => {
  it("leaves a short prompt alone", () => {
    expect(summaryPrompt("Fix the test")).toBe("Fix the test");
  });

  it("cuts a long prompt to the limit", () => {
    const summary = summaryPrompt("x ".repeat(400));
    expect(summary).toHaveLength(RUN_SUMMARY_PROMPT_LENGTH);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("redacts a secret that crosses the cut, so no fragment of it survives", () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const prompt = "x ".repeat((RUN_SUMMARY_PROMPT_LENGTH - 10) / 2) + key + " and more";
    const summary = summaryPrompt(prompt);
    expect(summary).not.toContain("AKIA");
    expect(summary.length).toBeLessThanOrEqual(RUN_SUMMARY_PROMPT_LENGTH);
  });
});

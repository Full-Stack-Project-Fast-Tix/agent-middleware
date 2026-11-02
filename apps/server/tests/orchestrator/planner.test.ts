import { describe, expect, it } from "vitest";
import { plannerPrompt } from "../../src/orchestrator/planner.js";
import { AGENTS } from "./fixtures.js";

const request = {
  userPrompt: "Add input validation to the signup endpoint",
  agents: [
    { id: AGENTS.analyst, name: "analyst", description: "Reads code" },
    { id: AGENTS.developer, name: "developer", description: null },
  ],
  maxTasks: 4,
};

describe("plannerPrompt", () => {
  it("gives the supervisor the request and the agent catalogue, and the task limit", () => {
    const prompt = plannerPrompt(request);
    expect(prompt).toContain("USER REQUEST:\nAdd input validation to the signup endpoint");
    expect(prompt).toContain(`"id":"${AGENTS.analyst}"`);
    expect(prompt).toContain("At most 4 tasks");
  });
});

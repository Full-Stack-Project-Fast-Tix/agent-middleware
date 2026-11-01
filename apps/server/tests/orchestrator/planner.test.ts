import { describe, expect, it } from "vitest";
import { ModelPlanner, plannerPrompt } from "../../src/orchestrator/planner.js";
import { AGENTS, SIGNUP_PLAN } from "./fixtures.js";

const request = {
  userPrompt: "Add input validation to the signup endpoint",
  agents: [
    { id: AGENTS.analyst, name: "analyst", description: "Reads code" },
    { id: AGENTS.developer, name: "developer", description: null },
  ],
  maxTasks: 4,
};

function plannerReturning(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const planner = new ModelPlanner({ apiKey: "k", baseUrl: "https://model.test/v1/", model: "m", timeoutMs: 1_000, fetch: fetchImpl });
  return { planner, calls };
}

describe("ModelPlanner", () => {
  it("returns a schema-valid plan from the model's JSON", async () => {
    const { planner, calls } = plannerReturning({ output_text: "```json\n" + JSON.stringify(SIGNUP_PLAN) + "\n```" });
    await expect(planner.plan(request)).resolves.toEqual(SIGNUP_PLAN);
    expect(calls[0]!.url).toBe("https://model.test/v1/responses");
    expect(calls[0]!.body).toMatchObject({ model: "m" });
  });

  it("reads the Responses API output array too", async () => {
    const { planner } = plannerReturning({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(SIGNUP_PLAN) }] }],
    });
    await expect(planner.plan(request)).resolves.toEqual(SIGNUP_PLAN);
  });

  it("ignores reasoning text the provider puts in content, which may hold braces", async () => {
    const { planner } = plannerReturning({
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "Maybe {tasks: []} would do." }] },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify(SIGNUP_PLAN) }] },
      ],
    });
    await expect(planner.plan(request)).resolves.toEqual(SIGNUP_PLAN);
  });

  it("rejects output that is not a valid plan", async () => {
    await expect(plannerReturning({ output_text: "I would start by reading the README." }).planner.plan(request)).rejects.toThrow(
      "not JSON",
    );
    await expect(
      plannerReturning({ output_text: JSON.stringify({ tasks: [{ key: "a", title: "t", objective: "o", agentId: "analyst" }] }) })
        .planner.plan(request),
    ).rejects.toThrow();
    await expect(plannerReturning("upstream down", 503).planner.plan(request)).rejects.toThrow("(503)");
  });

  it("stops when the run is cancelled", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const planner = new ModelPlanner({ apiKey: "k", baseUrl: "https://model.test/v1", model: "m", timeoutMs: 10_000, fetch: fetchImpl });
    const controller = new AbortController();
    const planning = planner.plan({ ...request, signal: controller.signal });
    controller.abort();
    await expect(planning).rejects.toThrow("aborted");
  });
});

describe("plannerPrompt", () => {
  it("gives the supervisor the request and the agent catalogue, and the task limit", () => {
    const prompt = plannerPrompt(request);
    expect(prompt).toContain("USER REQUEST:\nAdd input validation to the signup endpoint");
    expect(prompt).toContain(`"id":"${AGENTS.analyst}"`);
    expect(prompt).toContain("At most 4 tasks");
  });
});

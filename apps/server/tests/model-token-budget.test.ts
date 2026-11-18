import { describe, expect, it } from "vitest";
import { ModelTokenBudget } from "../src/model-token-budget.js";

describe("Run model token reservations", () => {
  it("reserves final-review capacity and accounts for cached input", () => {
    const budget = new ModelTokenBudget(100_000);
    const finish = budget.reserve("prompt", 4_000);
    finish({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 });
    finish();
    expect(budget.snapshot()).toEqual({ maximum: 100_000, charged: 170, reserved: 0, finalReserve: 20_000 });
    expect(() => budget.reserve("x".repeat(64_000), 1)).toThrow("reserved for final review");
    const final = budget.reserve("x".repeat(64_000), 1, true);
    final({ input_tokens: 10, output_tokens: 1 });
    expect(budget.snapshot().charged).toBe(181);
  });
  it("bounds concurrent calls and keeps conservative charges on unknown failures", () => {
    const budget = new ModelTokenBudget(50_000, false);
    const finish = budget.reserve("", 10_000);
    expect(() => budget.reserve("", 10_000)).toThrow();
    finish();
    expect(budget.snapshot()).toMatchObject({ charged: 26_000, reserved: 0 });
    expect(() => budget.reserve("", 10_000)).toThrow();
  });
  it("counts every provider fallback attempt instead of only the served response", () => {
    const budget = new ModelTokenBudget(100_000);
    budget.reserve("", 4_000)({ input_tokens: 10, output_tokens: 2, iterations: [
      { input_tokens: 20, output_tokens: 3, cache_creation_input_tokens: 4 },
      { input_tokens: 10, output_tokens: 2 },
    ] });
    expect(budget.snapshot().charged).toBe(39);
  });
});

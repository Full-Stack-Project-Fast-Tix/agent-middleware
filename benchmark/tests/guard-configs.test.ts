import { describe, expect, it } from "vitest";
import { GUARD_CONFIGS, parseGuardConfigs } from "../guard-configs.js";

const flags = [
  "GUARDRAIL_EGRESS_ENABLED",
  "GUARDRAIL_INTENT_ENABLED",
  "GUARDRAIL_REFLECTION_ENABLED",
  "GUARDRAIL_SEMANTIC_ENABLED",
] as const;

describe("benchmark guard presets", () => {
  it("set every guard flag so the caller's environment cannot leak between cells", () => {
    expect(Object.values(GUARD_CONFIGS)).toHaveLength(6);
    for (const preset of Object.values(GUARD_CONFIGS)) {
      expect(Object.keys(preset.env).sort()).toEqual([...flags].sort());
    }
    expect(GUARD_CONFIGS.off!.env).toEqual(Object.fromEntries(flags.map((flag) => [flag, "false"])));
    expect(GUARD_CONFIGS.egress!.env).toEqual({
      GUARDRAIL_EGRESS_ENABLED: "true",
      GUARDRAIL_INTENT_ENABLED: "false",
      GUARDRAIL_REFLECTION_ENABLED: "false",
      GUARDRAIL_SEMANTIC_ENABLED: "false",
    });
  });

  it("parses requested presets in order", () => {
    expect(parseGuardConfigs("off,egress,all").map(({ name }) => name)).toEqual([
      "off", "egress", "all",
    ]);
  });
});

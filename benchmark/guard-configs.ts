// The "defenses" axis: which GUARDRAIL_* flags are on for a cell. Analogous to
// AgentDojo's defense presets (delimiters / sandwiching / detector / …).

import type { GuardConfig } from "./types.js";

const ON = "true";
const OFF = "false";

export const GUARD_CONFIGS: Record<string, GuardConfig> = {
  // Every preset sets every flag. Otherwise values loaded from the operator's
  // .env leak into the supposedly isolated comparison cells.
  off: {
    name: "off",
    env: {
      GUARDRAIL_EGRESS_ENABLED: OFF,
      GUARDRAIL_INTENT_ENABLED: OFF,
      GUARDRAIL_REFLECTION_ENABLED: OFF,
      GUARDRAIL_SEMANTIC_ENABLED: OFF,
    },
  },
  egress: {
    name: "egress",
    env: {
      GUARDRAIL_EGRESS_ENABLED: ON,
      GUARDRAIL_INTENT_ENABLED: OFF,
      GUARDRAIL_REFLECTION_ENABLED: OFF,
      GUARDRAIL_SEMANTIC_ENABLED: OFF,
    },
  },
  "egress+intent": {
    name: "egress+intent",
    env: {
      GUARDRAIL_EGRESS_ENABLED: ON,
      GUARDRAIL_INTENT_ENABLED: ON,
      GUARDRAIL_REFLECTION_ENABLED: OFF,
      GUARDRAIL_SEMANTIC_ENABLED: OFF,
    },
  },
  "egress+reflection": {
    name: "egress+reflection",
    env: {
      GUARDRAIL_EGRESS_ENABLED: ON,
      GUARDRAIL_INTENT_ENABLED: OFF,
      GUARDRAIL_REFLECTION_ENABLED: ON,
      GUARDRAIL_SEMANTIC_ENABLED: OFF,
    },
  },
  semantic: {
    name: "semantic",
    env: {
      GUARDRAIL_EGRESS_ENABLED: OFF,
      GUARDRAIL_INTENT_ENABLED: OFF,
      GUARDRAIL_REFLECTION_ENABLED: OFF,
      GUARDRAIL_SEMANTIC_ENABLED: ON,
    },
  },
  all: {
    name: "all",
    env: {
      GUARDRAIL_EGRESS_ENABLED: ON,
      GUARDRAIL_INTENT_ENABLED: ON,
      GUARDRAIL_REFLECTION_ENABLED: ON,
      GUARDRAIL_SEMANTIC_ENABLED: ON,
    },
  },
};

export function parseGuardConfigs(csv: string): GuardConfig[] {
  const names = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: GuardConfig[] = [];
  for (const name of names) {
    const preset = GUARD_CONFIGS[name];
    if (!preset) {
      throw new Error(
        `unknown guard config "${name}". known: ${Object.keys(GUARD_CONFIGS).join(", ")}`,
      );
    }
    out.push(preset);
  }
  return out;
}

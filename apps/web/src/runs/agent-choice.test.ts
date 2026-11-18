import { describe, expect, it } from "vitest";
import type { Agent, EffectivePermissionsResponse } from "@launchpad/shared";
import { agentChoices, followUpAgent } from "./agent-choice";

const agent = (id: string, overrides: Partial<Agent> = {}): Agent => ({
  id,
  workspaceId: "00000000-0000-4000-8000-0000000000a1",
  name: id,
  description: "",
  instructions: "",
  profileId: "00000000-0000-4000-8000-0000000000p1",
  enabled: true,
  createdByUserId: "00000000-0000-4000-8000-0000000000c1",
  version: 1,
  archivedAt: null,
  createdAt: "2026-11-18T00:00:00.000Z",
  updatedAt: "2026-11-18T00:00:00.000Z",
  ...overrides,
});

const policy = (delegate: boolean, depth = 1) => ({
  capabilities: { write: false, shell: true, network: false, delegate, maxDelegationDepth: depth },
}) as unknown as NonNullable<EffectivePermissionsResponse["agents"][number]["policy"]>;

const AGENTS = [agent("supervisor"), agent("developer"), agent("shallow"), agent("unresolved"), agent("disabled", { enabled: false })];
const PERMISSIONS: EffectivePermissionsResponse["agents"] = [
  { agentId: "supervisor", policy: policy(true) },
  { agentId: "developer", policy: policy(false) },
  { agentId: "shallow", policy: policy(true, 0) },
  { agentId: "unresolved", policy: null },
  { agentId: "disabled", policy: policy(true) },
];

describe("which agents a Run form offers", () => {
  it("offers as supervisors only agents whose effective policy lets them delegate", () => {
    expect(agentChoices(AGENTS, "auto", PERMISSIONS)).toEqual({ agents: [AGENTS[0]], filtered: true });
  });

  it("offers every usable agent for one-agent Runs, and does not pretend to filter when permissions are unknown", () => {
    expect(agentChoices(AGENTS, "single", PERMISSIONS).agents.map((item) => item.id)).toEqual(["supervisor", "developer", "shallow", "unresolved"]);
    expect(agentChoices(AGENTS, "auto", null)).toMatchObject({ filtered: false });
  });

  it("keeps the follow-up's agent when it is still offered, and otherwise asks rather than switching", () => {
    const offered = agentChoices(AGENTS, "single", PERMISSIONS).agents;
    expect(followUpAgent("developer", offered)).toEqual({ agentId: "developer", kept: true });
    expect(followUpAgent("disabled", offered)).toEqual({ agentId: "", kept: false });
    expect(followUpAgent("developer", [AGENTS[0]!])).toEqual({ agentId: "supervisor", kept: false });
  });
});

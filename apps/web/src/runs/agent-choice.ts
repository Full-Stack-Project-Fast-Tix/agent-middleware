import type { Agent, EffectivePermissionsResponse, OrchestrationMode } from "@launchpad/shared";

// Which agents a Run form offers. The server decides; this only avoids offering
// what it will refuse. A supervisor must be able to delegate under its
// effective policy (platform, then workspace ceilings, then its profile). When
// those permissions did not load, nothing is filtered and the form says so.

type Permissions = EffectivePermissionsResponse["agents"];

export function isUsable(agent: Agent): boolean {
  return agent.enabled && agent.archivedAt === null;
}

export function mayDelegate(permissions: Permissions, agentId: string): boolean {
  const policy = permissions.find((entry) => entry.agentId === agentId)?.policy;
  return policy != null && policy.capabilities.delegate && policy.capabilities.maxDelegationDepth >= 1;
}

/** Agents to offer for a mode, and whether delegation eligibility was applied. */
export function agentChoices(agents: readonly Agent[], mode: OrchestrationMode, permissions: Permissions | null): { agents: Agent[]; filtered: boolean } {
  const usable = agents.filter(isUsable);
  if (mode === "single") return { agents: usable, filtered: false };
  if (permissions === null) return { agents: usable, filtered: false };
  return { agents: usable.filter((agent) => mayDelegate(permissions, agent.id)), filtered: true };
}

/**
 * The agent a follow-up starts with: the one the finished Run used, if it is
 * still offered; otherwise none, so the person chooses rather than the
 * workspace default silently taking over.
 */
export function followUpAgent(previousAgentId: string | null, offered: readonly Agent[]): { agentId: string; kept: boolean } {
  if (previousAgentId !== null && offered.some((agent) => agent.id === previousAgentId)) return { agentId: previousAgentId, kept: true };
  return { agentId: offered.length === 1 ? offered[0]!.id : "", kept: false };
}

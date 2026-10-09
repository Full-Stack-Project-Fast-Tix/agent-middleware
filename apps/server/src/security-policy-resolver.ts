import {
  agentProfileSchema,
  agentSchema,
  effectivePolicySchema,
  securityPolicySchema,
  type AgentCapabilities,
  type AgentProfile,
  type Agent,
  type SecurityPolicy,
} from "@launchpad/shared";

/** Trusted read port for policy data. Implementations must enforce workspace scope. */
export interface SecurityPolicySource {
  getAgent(agentId: string): Promise<unknown | null>;
  getAgentProfile(profileId: string): Promise<unknown | null>;
  listSecurityPolicies(): Promise<unknown[]>;
}

export interface ResolvedAgentPolicy {
  agent: Agent;
  profile: AgentProfile;
  policies: SecurityPolicy[];
  capabilities: AgentCapabilities;
  appliedPolicies: Array<{ policyId: string; version: number }>;
}

/**
 * Resolve mandatory platform ceilings, then workspace ceilings, then the
 * agent profile. Every layer can only remove a capability or lower a limit.
 * Invalid, archived, disabled, or cross-workspace records fail closed.
 */
export async function resolveAgentPolicy(
  source: SecurityPolicySource,
  workspaceId: string,
  agentId: string,
): Promise<ResolvedAgentPolicy> {
  const rawAgent = await source.getAgent(agentId);
  if (rawAgent === null) throw new Error("Security policy resolution failed: agent not found");
  const agent = agentSchema.parse(rawAgent);
  if (agent.id !== agentId || !agent.enabled || agent.archivedAt !== null || agent.workspaceId !== workspaceId) {
    throw new Error("Security policy resolution failed: agent is unavailable in this workspace");
  }

  const rawProfile = await source.getAgentProfile(agent.profileId);
  if (rawProfile === null) throw new Error("Security policy resolution failed: agent profile not found");
  const profile = agentProfileSchema.parse(rawProfile);
  if (profile.id !== agent.profileId || profile.archivedAt !== null || profile.workspaceId !== workspaceId) {
    throw new Error("Security policy resolution failed: agent profile is unavailable in this workspace");
  }

  const policies = (await source.listSecurityPolicies()).map((entry) => securityPolicySchema.parse(entry));
  const active = policies.filter((policy) => policy.archivedAt === null);
  const platformPolicies = active.filter((policy) => policy.scope === "platform");
  const workspacePolicies = active.filter(
    (policy) => policy.scope === "workspace" && policy.workspaceId === workspaceId,
  );
  if (platformPolicies.length === 0) {
    throw new Error("Security policy resolution failed: no active mandatory platform policy");
  }

  // Until a rules engine is defined, silently ignoring a nonempty policy rules
  // object would create a misleading effective-permissions result.
  for (const policy of [...platformPolicies, ...workspacePolicies]) {
    if (policy.rulesSchemaVersion !== 1 || Object.keys(policy.rules).length > 0) {
      throw new Error(`Security policy resolution failed: unsupported rules in policy ${policy.id}`);
    }
  }

  const orderedPolicies = [...platformPolicies, ...workspacePolicies];
  const ceilings = orderedPolicies.map((policy) => policy.capabilityCeiling);
  const capabilities: AgentCapabilities = {
    write: permits(profile.capabilities.write, ceilings.map((ceiling) => ceiling.write)),
    shell: permits(profile.capabilities.shell, ceilings.map((ceiling) => ceiling.shell)),
    network: permits(profile.capabilities.network, ceilings.map((ceiling) => ceiling.network)),
    delegate: permits(profile.capabilities.delegate, ceilings.map((ceiling) => ceiling.delegate)),
    maxDelegationDepth: Math.min(
      profile.capabilities.maxDelegationDepth,
      ...ceilings.map((ceiling) => ceiling.maxDelegationDepth ?? Number.POSITIVE_INFINITY),
    ),
  };
  if (!capabilities.delegate) capabilities.maxDelegationDepth = 0;

  const effective = effectivePolicySchema.parse({
    capabilities,
    appliedPolicies: orderedPolicies.map(({ id, version }) => ({ policyId: id, version })),
  });
  return {
    agent,
    profile,
    policies: orderedPolicies,
    capabilities: effective.capabilities,
    appliedPolicies: effective.appliedPolicies,
  };
}

function permits(profileValue: boolean, ceilings: Array<boolean | undefined>): boolean {
  return profileValue && ceilings.every((value) => value !== false);
}

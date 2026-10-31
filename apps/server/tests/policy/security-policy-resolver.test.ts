import { describe, expect, it } from "vitest";
import type { Agent, AgentProfile, SecurityContext, SecurityPolicy } from "@launchpad/shared";
import { loadConfig } from "../../src/config.js";
import {
  createSecurityMiddleware,
  DefaultSecurityMiddleware,
  type SecurityExecutionSource,
} from "../../src/security-middleware-impl.js";
import {
  resolveAgentPolicy,
} from "../../src/security-policy-resolver.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";
const PROFILE_ID = "00000000-0000-4000-8000-000000000004";
const PLATFORM_POLICY_ID = "00000000-0000-4000-8000-000000000005";
const WORKSPACE_POLICY_ID = "00000000-0000-4000-8000-000000000006";
const FOREIGN_POLICY_ID = "00000000-0000-4000-8000-000000000007";
const NOW = "2026-09-30T00:00:00.000Z";

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  id: PROFILE_ID,
  workspaceId: WORKSPACE_ID,
  name: "Developer",
  description: null,
  capabilities: {
    write: true,
    shell: true,
    network: true,
    delegate: true,
    maxDelegationDepth: 5,
  },
  version: 1,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: AGENT_ID,
  workspaceId: WORKSPACE_ID,
  name: "Builder",
  description: null,
  instructions: "Build the requested feature.",
  profileId: PROFILE_ID,
  enabled: true,
  createdByUserId: "00000000-0000-4000-8000-000000000008",
  version: 1,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const policy = (
  id: string,
  scope: SecurityPolicy["scope"],
  workspaceId: string | null,
  capabilityCeiling: SecurityPolicy["capabilityCeiling"] = {},
  overrides: Partial<SecurityPolicy> = {},
): SecurityPolicy => ({
  id,
  scope,
  workspaceId,
  name: scope === "platform" ? "Platform baseline" : "Workspace ceiling",
  capabilityCeiling,
  rules: {},
  rulesSchemaVersion: 1,
  locked: scope === "platform",
  version: 1,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

class PolicySource implements SecurityExecutionSource {
  constructor(
    private readonly agents: Agent[],
    private readonly profiles: AgentProfile[],
    private readonly policies: SecurityPolicy[],
  ) {}

  async getAgent(agentId: string): Promise<unknown | null> {
    return this.agents.find((entry) => entry.id === agentId) ?? null;
  }

  async getAgentProfile(profileId: string): Promise<unknown | null> {
    return this.profiles.find((entry) => entry.id === profileId) ?? null;
  }

  async listSecurityPolicies(): Promise<unknown[]> {
    return this.policies;
  }

  async getExecutionFacts(_context: SecurityContext): Promise<null> {
    return null;
  }

  async getTaskIdentity(_taskId: string): Promise<null> {
    return null;
  }
}

function source(options: {
  agents?: Agent[];
  profiles?: AgentProfile[];
  policies?: SecurityPolicy[];
} = {}): PolicySource {
  return new PolicySource(
    options.agents ?? [agent()],
    options.profiles ?? [profile()],
    options.policies ?? [policy(PLATFORM_POLICY_ID, "platform", null)],
  );
}

describe("resolveAgentPolicy", () => {
  it("applies all platform and workspace ceilings before exposing effective capabilities", async () => {
    const resolved = await resolveAgentPolicy(
      source({
        policies: [
          policy(PLATFORM_POLICY_ID, "platform", null, { write: false, maxDelegationDepth: 4 }),
          policy("00000000-0000-4000-8000-000000000009", "platform", null, { network: false }),
          policy(WORKSPACE_POLICY_ID, "workspace", WORKSPACE_ID, {
            write: true,
            shell: false,
            maxDelegationDepth: 2,
          }),
        ],
      }),
      WORKSPACE_ID,
      AGENT_ID,
    );

    expect(resolved.capabilities).toEqual({
      write: false,
      shell: false,
      network: false,
      delegate: true,
      maxDelegationDepth: 2,
    });
    expect(resolved.appliedPolicies).toEqual([
      { policyId: PLATFORM_POLICY_ID, version: 1 },
      { policyId: "00000000-0000-4000-8000-000000000009", version: 1 },
      { policyId: WORKSPACE_POLICY_ID, version: 1 },
    ]);
  });

  it("does not let a workspace policy from another workspace affect the Agent", async () => {
    const resolved = await resolveAgentPolicy(
      source({
        policies: [
          policy(PLATFORM_POLICY_ID, "platform", null),
          policy(FOREIGN_POLICY_ID, "workspace", OTHER_WORKSPACE_ID, {
            write: false,
            shell: false,
            network: false,
            delegate: false,
            maxDelegationDepth: 0,
          }),
        ],
      }),
      WORKSPACE_ID,
      AGENT_ID,
    );

    expect(resolved.capabilities).toEqual(profile().capabilities);
    expect(resolved.appliedPolicies.map(({ policyId }) => policyId)).toEqual([PLATFORM_POLICY_ID]);
  });

  it("uses the most restrictive delegation depth and makes it zero when delegation is denied", async () => {
    const resolved = await resolveAgentPolicy(
      source({
        policies: [
          policy(PLATFORM_POLICY_ID, "platform", null, { maxDelegationDepth: 3 }),
          policy(WORKSPACE_POLICY_ID, "workspace", WORKSPACE_ID, { delegate: false, maxDelegationDepth: 2 }),
        ],
      }),
      WORKSPACE_ID,
      AGENT_ID,
    );

    expect(resolved.capabilities.delegate).toBe(false);
    expect(resolved.capabilities.maxDelegationDepth).toBe(0);
  });

  it("fails closed when there is no active mandatory platform policy", async () => {
    await expect(
      resolveAgentPolicy(
        source({
          policies: [policy(PLATFORM_POLICY_ID, "platform", null, {}, { archivedAt: NOW })],
        }),
        WORKSPACE_ID,
        AGENT_ID,
      ),
    ).rejects.toThrow("no active mandatory platform policy");
  });

  it("rejects policy rules outside the supported schema", async () => {
    await expect(
      resolveAgentPolicy(
        source({
          policies: [policy(PLATFORM_POLICY_ID, "platform", null, {}, { rules: { blockedPaths: [".env"] } })],
        }),
        WORKSPACE_ID,
        AGENT_ID,
      ),
    ).rejects.toThrow("unsupported rules");
  });

  it("rejects an unknown rules version even when the rules are empty", async () => {
    await expect(
      resolveAgentPolicy(
        source({
          policies: [policy(PLATFORM_POLICY_ID, "platform", null, {}, { rulesSchemaVersion: 2 })],
        }),
        WORKSPACE_ID,
        AGENT_ID,
      ),
    ).rejects.toThrow("unsupported rules");
  });

  it("rejects unsupported rules on a workspace policy, not only a platform one", async () => {
    for (const overrides of [{ rules: { allowedPaths: ["src"] } }, { rulesSchemaVersion: 2 }]) {
      await expect(
        resolveAgentPolicy(
          source({
            policies: [
              policy(PLATFORM_POLICY_ID, "platform", null),
              policy(WORKSPACE_POLICY_ID, "workspace", WORKSPACE_ID, {}, overrides),
            ],
          }),
          WORKSPACE_ID,
          AGENT_ID,
        ),
      ).rejects.toThrow("unsupported rules");
    }
  });

  it("rejects a rules payload that is not a JSON object", async () => {
    await expect(
      resolveAgentPolicy(
        source({
          policies: [
            policy(PLATFORM_POLICY_ID, "platform", null, {}, { rules: ["blocked"] as unknown as SecurityPolicy["rules"] }),
          ],
        }),
        WORKSPACE_ID,
        AGENT_ID,
      ),
    ).rejects.toThrow();
  });

  it("rejects disabled, archived, and cross-workspace Agents", async () => {
    const unavailableAgents = [
      agent({ enabled: false }),
      agent({ archivedAt: NOW }),
      agent({ workspaceId: OTHER_WORKSPACE_ID }),
    ];

    for (const unavailable of unavailableAgents) {
      await expect(
        resolveAgentPolicy(source({ agents: [unavailable] }), WORKSPACE_ID, AGENT_ID),
      ).rejects.toThrow("agent is unavailable in this workspace");
    }
  });

  it("rejects an Agent whose profile belongs to another workspace", async () => {
    await expect(
      resolveAgentPolicy(
        source({ profiles: [profile({ workspaceId: OTHER_WORKSPACE_ID })] }),
        WORKSPACE_ID,
        AGENT_ID,
      ),
    ).rejects.toThrow("agent profile is unavailable in this workspace");
  });
});

describe("DefaultSecurityMiddleware.resolvePolicy", () => {
  it("keeps the pre-execution gate active even when the Agent has every capability", async () => {
    const middleware = new DefaultSecurityMiddleware({
      config: loadConfig({
        NODE_ENV: "test",
        CODEX_SANDBOX_MODE: "danger-full-access",
        CODEX_NETWORK_ACCESS: "true",
      }),
      source: source(),
    });

    const resolved = await middleware.resolvePolicy(WORKSPACE_ID, AGENT_ID);

    expect(resolved.runtime).toEqual({
      sandboxMode: "workspace-write",
      denyNetwork: false,
      approvalPolicy: "untrusted",
      semanticEnforcement: false,
      effectGating: true,
    });
  });

  it("does not let a network-enabled runtime override a profile that denies network access", async () => {
    const sourceWithNetworkDenied = source({
      profiles: [
        profile({
          capabilities: { ...profile().capabilities, network: false },
        }),
      ],
    });
    const middleware = new DefaultSecurityMiddleware({
      config: loadConfig({
        NODE_ENV: "test",
        CODEX_NETWORK_ACCESS: "true",
      }),
      source: sourceWithNetworkDenied,
    });

    const resolved = await middleware.resolvePolicy(WORKSPACE_ID, AGENT_ID);

    expect(resolved.runtime.denyNetwork).toBe(true);
    expect(resolved.runtime.approvalPolicy).toBe("untrusted");
    expect(resolved.runtime.effectGating).toBe(true);
  });

  it("exposes the same trusted-source boundary through the host factory", async () => {
    const middleware = createSecurityMiddleware({
      config: loadConfig({ NODE_ENV: "test" }),
      source: source({
        policies: [
          policy(PLATFORM_POLICY_ID, "platform", null, { write: false }),
        ],
      }),
    });

    const resolved = await middleware.resolvePolicy(WORKSPACE_ID, AGENT_ID);

    expect(resolved.capabilities.write).toBe(false);
    expect(resolved.appliedPolicies).toEqual([{ policyId: PLATFORM_POLICY_ID, version: 1 }]);
  });
});

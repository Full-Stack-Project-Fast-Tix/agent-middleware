import {
  agentResponseSchema,
  apiPaths,
  approvalPageSchema,
  auditPageSchema,
  benchmarksResponseSchema,
  effectivePermissionsResponseSchema,
  findingPageSchema,
  policiesResponseSchema,
  policyResponseSchema,
  profileResponseSchema,
  profilesResponseSchema,
  workspaceVaultResponseSchema,
  workspaceVaultSecretInfoSchema,
  type Agent,
  type AgentProfile,
  type ApprovalPage,
  type AuditPage,
  type BenchmarksResponse,
  type CreateAgentProfileRequest,
  type CreateAgentRequest,
  type CreateSecurityPolicyRequest,
  type EffectivePermissionsResponse,
  type FindingPage,
  type SecurityPolicy,
  type UpdateAgentProfileRequest,
  type UpdateAgentRequest,
  type UpdateSecurityPolicyRequest,
  type PutWorkspaceVaultSecret,
  type WorkspaceVaultSecretInfo,
} from "@launchpad/shared";
import { request } from "../api";

// Evidence and configuration, from packages/shared/src/api.ts. These routes exist
// only in password mode. The server decides who may do what on every request.

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

const send = (method: "POST" | "PATCH", body: object) => ({ method, body: JSON.stringify(body) });

export const workspaceApi = {
  findings: async (workspaceId: string, query: { severity?: string; cursor?: string }): Promise<FindingPage> =>
    findingPageSchema.parse(await request(withQuery(apiPaths.workspaceFindings(workspaceId), query))),
  approvals: async (workspaceId: string, query: { status?: string; cursor?: string }): Promise<ApprovalPage> =>
    approvalPageSchema.parse(await request(withQuery(apiPaths.workspaceApprovals(workspaceId), query))),
  audit: async (workspaceId: string, query: { eventType?: string; cursor?: string }): Promise<AuditPage> =>
    auditPageSchema.parse(await request(withQuery(apiPaths.workspaceAudit(workspaceId), query))),
  effective: async (workspaceId: string): Promise<EffectivePermissionsResponse["agents"]> =>
    effectivePermissionsResponseSchema.parse(await request(apiPaths.workspaceEffectivePermissions(workspaceId))).agents,
  vaultSecrets: async (workspaceId: string): Promise<WorkspaceVaultSecretInfo[]> =>
    workspaceVaultResponseSchema.parse(await request(apiPaths.workspaceVault(workspaceId))).secrets,
  putVaultSecret: async (workspaceId: string, secret: PutWorkspaceVaultSecret): Promise<WorkspaceVaultSecretInfo> =>
    workspaceVaultSecretInfoSchema.parse((await request(apiPaths.workspaceVault(workspaceId), {
      method: "PUT", body: JSON.stringify(secret),
    }) as { secret: unknown }).secret),
  deleteVaultSecret: async (workspaceId: string, name: string): Promise<void> => {
    await request(apiPaths.workspaceVaultSecret(workspaceId, name), { method: "DELETE" });
  },
  benchmarks: async (): Promise<BenchmarksResponse["results"]> =>
    benchmarksResponseSchema.parse(await request(apiPaths.benchmarks())).results,

  createAgent: async (workspaceId: string, body: CreateAgentRequest): Promise<Agent> =>
    agentResponseSchema.parse(await request(apiPaths.workspaceAgents(workspaceId), send("POST", body))).agent,
  updateAgent: async (workspaceId: string, agentId: string, body: UpdateAgentRequest): Promise<Agent> =>
    agentResponseSchema.parse(await request(apiPaths.workspaceAgent(workspaceId, agentId), send("PATCH", body))).agent,
  archiveAgent: async (workspaceId: string, agentId: string): Promise<void> => {
    await request(apiPaths.workspaceAgent(workspaceId, agentId), { method: "DELETE" });
  },

  profiles: async (workspaceId: string): Promise<AgentProfile[]> =>
    profilesResponseSchema.parse(await request(apiPaths.workspaceProfiles(workspaceId))).profiles,
  createProfile: async (workspaceId: string, body: CreateAgentProfileRequest): Promise<AgentProfile> =>
    profileResponseSchema.parse(await request(apiPaths.workspaceProfiles(workspaceId), send("POST", body))).profile,
  updateProfile: async (workspaceId: string, profileId: string, body: UpdateAgentProfileRequest): Promise<AgentProfile> =>
    profileResponseSchema.parse(await request(apiPaths.workspaceProfile(workspaceId, profileId), send("PATCH", body))).profile,
  archiveProfile: async (workspaceId: string, profileId: string): Promise<void> => {
    await request(apiPaths.workspaceProfile(workspaceId, profileId), { method: "DELETE" });
  },

  policies: async (workspaceId: string): Promise<SecurityPolicy[]> =>
    policiesResponseSchema.parse(await request(apiPaths.workspacePolicies(workspaceId))).policies,
  createPolicy: async (workspaceId: string, body: CreateSecurityPolicyRequest): Promise<SecurityPolicy> =>
    policyResponseSchema.parse(await request(apiPaths.workspacePolicies(workspaceId), send("POST", body))).policy,
  updatePolicy: async (workspaceId: string, policyId: string, body: UpdateSecurityPolicyRequest): Promise<SecurityPolicy> =>
    policyResponseSchema.parse(await request(apiPaths.workspacePolicy(workspaceId, policyId), send("PATCH", body))).policy,
  archivePolicy: async (workspaceId: string, policyId: string): Promise<void> => {
    await request(apiPaths.workspacePolicy(workspaceId, policyId), { method: "DELETE" });
  },
};

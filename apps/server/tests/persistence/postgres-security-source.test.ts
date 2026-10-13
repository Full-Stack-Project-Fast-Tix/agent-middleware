import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@launchpad/shared";
import { PostgresSecuritySource } from "../../src/db/postgres-security-source.js";
import { resolveAgentPolicy } from "../../src/security-policy-resolver.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const TASK_ID = "00000000-0000-4000-8000-000000000004";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000005";
const AGENT_ID = "00000000-0000-4000-8000-000000000006";
const PROFILE_ID = "00000000-0000-4000-8000-000000000007";
const PLATFORM_POLICY_ID = "00000000-0000-4000-8000-000000000008";
const WORKSPACE_POLICY_ID = "00000000-0000-4000-8000-000000000009";

const context: SecurityContext = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  taskId: TASK_ID,
  executionId: EXECUTION_ID,
  agentId: AGENT_ID,
};

function mockPool(resolveRows: (sql: string, values?: unknown[]) => unknown[]) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => ({ rows: resolveRows(sql, values) }));
  return { pool: { query } as unknown as pg.Pool, query };
}

function agentRow() {
  return {
    id: AGENT_ID,
    workspace_id: WORKSPACE_ID,
    name: "Builder",
    description: null,
    instructions: "Implement the requested task.",
    profile_id: PROFILE_ID,
    enabled: true,
    created_by_user_id: "00000000-0000-4000-8000-000000000010",
    version: 1,
    archived_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

function profileRow() {
  return {
    id: PROFILE_ID,
    workspace_id: WORKSPACE_ID,
    name: "Builder profile",
    description: null,
    cap_write: true,
    cap_shell: true,
    cap_network: true,
    cap_delegate: true,
    cap_max_delegation_depth: 4,
    version: 2,
    archived_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

function policyRow(id: string, scope: "platform" | "workspace", workspaceId: string | null, ceiling: Record<string, unknown>) {
  return {
    id,
    workspace_id: workspaceId,
    name: scope === "platform" ? "Mandatory baseline" : "Workspace ceiling",
    scope,
    ceil_write: ceiling.write ?? null,
    ceil_shell: ceiling.shell ?? null,
    ceil_network: ceiling.network ?? null,
    ceil_delegate: ceiling.delegate ?? null,
    ceil_max_delegation_depth: ceiling.maxDelegationDepth ?? null,
    rules: {},
    rules_schema_version: 1,
    locked: scope === "platform",
    version: 1,
    archived_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

describe("PostgresSecuritySource", () => {
  it("resolves a policy from verified agent/profile rows and only workspace-scoped policies", async () => {
    const { pool, query } = mockPool((sql) => {
      if (sql.includes("FROM agents")) return [agentRow()];
      if (sql.includes("FROM agent_profiles")) return [profileRow()];
      if (sql.includes("FROM security_policies")) {
        return [
          policyRow(PLATFORM_POLICY_ID, "platform", null, { network: false, maxDelegationDepth: 3 }),
          policyRow(WORKSPACE_POLICY_ID, "workspace", WORKSPACE_ID, { write: false }),
        ];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const source = new PostgresSecuritySource(pool);

    const resolved = await resolveAgentPolicy(source, WORKSPACE_ID, AGENT_ID);

    expect(resolved.capabilities).toEqual({
      write: false,
      shell: true,
      network: false,
      delegate: true,
      maxDelegationDepth: 3,
    });
    expect(resolved.appliedPolicies).toEqual([
      { policyId: PLATFORM_POLICY_ID, version: 1 },
      { policyId: WORKSPACE_POLICY_ID, version: 1 },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("scope = 'platform'"), [WORKSPACE_ID]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("workspace_id = $1"), [WORKSPACE_ID]);
  });

  it("loads execution facts only when execution, task, agent, run and workspace identities all match", async () => {
    const { pool, query } = mockPool((sql) => {
      expect(sql).toContain("WITH RECURSIVE task_ancestry");
      expect(sql).toContain("t.assigned_agent_id = e.agent_id");
      expect(sql).toContain("a.enabled AND a.archived_at IS NULL AND p.archived_at IS NULL");
      return [{
        workspace_id: WORKSPACE_ID,
        run_id: RUN_ID,
        task_id: TASK_ID,
        agent_id: AGENT_ID,
        user_prompt: "Add the requested feature.",
        task_objective: "Implement the API change.",
        instructions: "Implement the requested task.",
        delegation_depth: 2,
      }];
    });
    const source = new PostgresSecuritySource(pool);

    await expect(source.getExecutionFacts(context)).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      taskId: TASK_ID,
      agentId: AGENT_ID,
      userPrompt: "Add the requested feature.",
      taskObjective: "Implement the API change.",
      agentInstructions: "Implement the requested task.",
      delegationDepth: 2,
    });
    expect(query).toHaveBeenCalledWith(expect.any(String), [EXECUTION_ID, RUN_ID, TASK_ID, AGENT_ID, WORKSPACE_ID]);
  });

  it("fails closed when the scoped execution join finds no matching records", async () => {
    const { pool } = mockPool(() => []);
    const source = new PostgresSecuritySource(pool);

    await expect(source.getExecutionFacts({ ...context, workspaceId: OTHER_WORKSPACE_ID })).resolves.toBeNull();
  });

  it("returns task identity through the owning run", async () => {
    const { pool, query } = mockPool((sql) => {
      expect(sql).toContain("JOIN runs r ON r.id = t.run_id");
      return [{ workspace_id: WORKSPACE_ID, run_id: RUN_ID }];
    });
    const source = new PostgresSecuritySource(pool);

    await expect(source.getTaskIdentity(TASK_ID)).resolves.toEqual({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
    expect(query).toHaveBeenCalledWith(expect.any(String), [TASK_ID]);
  });
});

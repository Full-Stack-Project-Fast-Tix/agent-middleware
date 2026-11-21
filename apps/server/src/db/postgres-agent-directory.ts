import { agentSchema, type Agent, type OrchestrationMode } from "@launchpad/shared";
import type pg from "pg";
import type { AgentDirectory } from "../orchestrator/ports.js";
import { fromRow } from "./rows.js";

export class PostgresAgentDirectory implements AgentDirectory {
  constructor(private readonly pool: pg.Pool) {}

  async getAgent(agentId: string): Promise<Agent | null> {
    const { rows } = await this.pool.query("SELECT * FROM agents WHERE id = $1", [agentId]);
    return rows[0] === undefined ? null : agentSchema.parse(fromRow(rows[0]));
  }

  /** Every agent in the workspace, including disabled and archived ones. */
  async listAgents(workspaceId: string): Promise<Agent[]> {
    const { rows } = await this.pool.query("SELECT * FROM agents WHERE workspace_id = $1 ORDER BY created_at, id", [workspaceId]);
    return rows.map((row) => agentSchema.parse(fromRow(row)));
  }

  /**
   * For `auto`, the workspace's enabled agent whose profile may delegate, when
   * there is exactly one. With several, none is the default and the request must
   * name its supervisor, rather than this silently picking one.
   */
  async defaultAgentId(workspaceId: string, mode: OrchestrationMode): Promise<string | null> {
    if (mode !== "auto") return null;
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT a.id FROM agents a JOIN agent_profiles p ON p.id = a.profile_id
        WHERE a.workspace_id = $1 AND a.enabled AND a.archived_at IS NULL AND p.archived_at IS NULL AND p.cap_delegate
        LIMIT 2`,
      [workspaceId],
    );
    return rows.length === 1 ? rows[0]!.id : null;
  }
}

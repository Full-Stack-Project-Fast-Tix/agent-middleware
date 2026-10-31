import { randomUUID } from "node:crypto";
import type { SecurityContext } from "@launchpad/shared";
import type pg from "pg";
import type { SecurityExecutionFacts, SecurityExecutionSource } from "../security-middleware-impl.js";
import { learnFrom, reflectionKey, type LearnInput, type Reflection } from "../reflections.js";
import { fromRow } from "./rows.js";

/**
 * Trusted, read-only facts for Person 1's middleware. Every execution lookup
 * binds all identifiers from SecurityContext and joins through the owning Run,
 * Task and Agent so callers cannot substitute another workspace's authority.
 */
export class PostgresSecuritySource implements SecurityExecutionSource {
  constructor(private readonly pool: pg.Pool) {}

  async getAgent(agentId: string): Promise<unknown | null> {
    const { rows } = await this.pool.query("SELECT * FROM agents WHERE id = $1", [agentId]);
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }

  async getAgentProfile(profileId: string): Promise<unknown | null> {
    const { rows } = await this.pool.query("SELECT * FROM agent_profiles WHERE id = $1", [profileId]);
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }

  async listSecurityPolicies(workspaceId: string): Promise<unknown[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM security_policies
        WHERE archived_at IS NULL
          AND (scope = 'platform' OR (scope = 'workspace' AND workspace_id = $1))
        ORDER BY CASE scope WHEN 'platform' THEN 0 ELSE 1 END, created_at, id`,
      [workspaceId],
    );
    return rows.map((raw) => {
      const row = fromRow(raw);
      const source = raw as Record<string, unknown>;
      return {
        ...row,
        capabilityCeiling: {
          ...(source.ceil_write === null ? {} : { write: source.ceil_write }),
          ...(source.ceil_shell === null ? {} : { shell: source.ceil_shell }),
          ...(source.ceil_network === null ? {} : { network: source.ceil_network }),
          ...(source.ceil_delegate === null ? {} : { delegate: source.ceil_delegate }),
          ...(source.ceil_max_delegation_depth === null
            ? {}
            : { maxDelegationDepth: source.ceil_max_delegation_depth }),
        },
      };
    });
  }

  async getExecutionFacts(context: SecurityContext): Promise<SecurityExecutionFacts | null> {
    const { rows } = await this.pool.query(
      `WITH RECURSIVE task_ancestry(id, run_id, parent_task_id, depth, visited) AS (
         SELECT t.id, t.run_id, t.parent_task_id, 0, ARRAY[t.id]
           FROM tasks t
          WHERE t.id = $3 AND t.run_id = $2
         UNION ALL
         SELECT parent.id, parent.run_id, parent.parent_task_id, child.depth + 1, child.visited || parent.id
           FROM task_ancestry child
           JOIN tasks parent ON parent.id = child.parent_task_id AND parent.run_id = child.run_id
          WHERE NOT parent.id = ANY(child.visited)
       ), depth AS (
         SELECT COALESCE(MAX(depth), 0)::integer AS delegation_depth FROM task_ancestry
       )
       SELECT r.workspace_id, r.id AS run_id, t.id AS task_id, e.agent_id,
              r.user_prompt, t.objective AS task_objective, a.instructions,
              depth.delegation_depth
         FROM agent_executions e
         JOIN tasks t ON t.id = e.task_id AND t.run_id = e.run_id
         JOIN runs r ON r.id = e.run_id
         JOIN agents a ON a.id = e.agent_id AND a.workspace_id = r.workspace_id
         JOIN agent_profiles p ON p.id = a.profile_id AND p.workspace_id = r.workspace_id
         CROSS JOIN depth
        WHERE e.id = $1 AND e.run_id = $2 AND e.task_id = $3 AND e.agent_id = $4
          AND r.workspace_id = $5 AND t.assigned_agent_id = e.agent_id
          AND a.enabled AND a.archived_at IS NULL AND p.archived_at IS NULL`,
      [context.executionId, context.runId, context.taskId, context.agentId, context.workspaceId],
    );
    if (rows[0] === undefined) return null;
    const facts = fromRow(rows[0]);
    const reflections = await this.listReflections(this.pool, context.agentId);
    return {
      workspaceId: facts.workspaceId as string,
      runId: facts.runId as string,
      taskId: facts.taskId as string,
      agentId: facts.agentId as string,
      userPrompt: facts.userPrompt as string,
      taskObjective: facts.taskObjective as string,
      agentInstructions: facts.instructions as string,
      delegationDepth: facts.delegationDepth as number,
      reflections,
    };
  }

  private async listReflections(db: Pick<pg.Pool, "query">, agentId: string): Promise<Reflection[]> {
    const { rows } = await db.query<{
      code: string;
      facts: Record<string, string>;
      first_seen_at: Date | string;
      last_seen_at: Date | string;
      sightings: string[] | null;
      threads: string[] | null;
      legacy: boolean;
    }>(
      `SELECT r.code, r.facts, r.first_seen_at, r.last_seen_at,
              array_agg(DISTINCT s.run_id::text) FILTER (WHERE s.run_id IS NOT NULL) AS sightings,
              array_agg(DISTINCT s.thread_id ORDER BY s.thread_id) FILTER (WHERE s.thread_id IS NOT NULL) AS threads,
              COALESCE(bool_or(s.id IS NOT NULL AND s.run_id IS NULL AND s.thread_id IS NULL), false) AS legacy
         FROM reflections r LEFT JOIN reflection_sightings s ON s.reflection_id = r.id
        WHERE r.agent_id = $1
        GROUP BY r.id ORDER BY r.first_seen_at, r.dedup_key`,
      [agentId],
    );
    return rows.map((row) => ({
      code: row.code,
      facts: row.facts,
      sightings: row.sightings ?? [],
      ...(row.legacy ? {} : { threads: row.threads ?? [] }),
      firstSeenAt: new Date(row.first_seen_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
    }));
  }

  /** Fold against the latest Agent memory while holding its row lock. */
  async foldReflections(agentId: string, input: Omit<LearnInput, "reflections">): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [agentId]);
      if (rows[0] === undefined) throw new Error("Reflection owner no longer exists");
      const reflections = learnFrom({ ...input, reflections: await this.listReflections(client, agentId) }).reflections;
      await client.query("DELETE FROM reflection_sightings WHERE reflection_id IN (SELECT id FROM reflections WHERE agent_id = $1)", [agentId]);
      await client.query("DELETE FROM reflections WHERE agent_id = $1", [agentId]);
      for (const reflection of reflections) {
        const id = randomUUID();
        await client.query(
          `INSERT INTO reflections (id, agent_id, code, facts, dedup_key, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          [id, agentId, reflection.code, JSON.stringify(reflection.facts), reflectionKey(reflection.code, reflection.facts), reflection.firstSeenAt, reflection.lastSeenAt],
        );
        for (const runId of reflection.sightings) {
          await client.query(
            `INSERT INTO reflection_sightings (id, reflection_id, run_id, thread_id, seen_at)
             VALUES ($1, $2, $3, NULL, $4)`,
            [randomUUID(), id, runId, reflection.lastSeenAt],
          );
        }
        for (const threadId of reflection.threads ?? []) {
          await client.query(
            `INSERT INTO reflection_sightings (id, reflection_id, run_id, thread_id, seen_at)
             VALUES ($1, $2, NULL, $3, $4)`,
            [randomUUID(), id, threadId, reflection.lastSeenAt],
          );
        }
        if (reflection.threads === undefined) {
          await client.query(
            `INSERT INTO reflection_sightings (id, reflection_id, run_id, thread_id, seen_at)
             VALUES ($1, $2, NULL, NULL, $3)`,
            [randomUUID(), id, reflection.firstSeenAt],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getTaskIdentity(taskId: string): Promise<{ workspaceId: string; runId: string } | null> {
    const { rows } = await this.pool.query(
      `SELECT r.workspace_id, r.id AS run_id
         FROM tasks t JOIN runs r ON r.id = t.run_id
        WHERE t.id = $1`,
      [taskId],
    );
    if (rows[0] === undefined) return null;
    const identity = fromRow(rows[0]);
    return { workspaceId: identity.workspaceId as string, runId: identity.runId as string };
  }
}

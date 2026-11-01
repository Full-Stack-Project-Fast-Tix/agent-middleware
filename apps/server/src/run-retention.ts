import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { traceFilePath } from "./trace.js";

// Removes expired traces and non-head working copies for finished Runs. The
// latest successful workspace copy stays available for follow-up Runs. Rows
// stay, so audit events, findings and statuses outlive the files. Only a Run
// the database says has finished is touched; unmatched directories are left alone.

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1_000;
const SWEEP_MS = 60 * 60 * 1_000;

/** Returns how many Runs had files removed. */
export async function removeExpiredRunFiles(
  pool: Pick<pg.Pool, "query">,
  options: { dataDirectory: string; retentionDays: number; now?: () => number },
): Promise<number> {
  if (options.retentionDays <= 0) return 0;
  const root = path.join(options.dataDirectory, "runs");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const names = entries.filter((name) => RUN_ID.test(name));
  if (names.length === 0) return 0;
  const cutoff = new Date((options.now?.() ?? Date.now()) - options.retentionDays * DAY_MS).toISOString();
  const { rows } = await pool.query<{ id: string; keep_workspace: boolean }>(
    `SELECT r.id,
        (r.status = 'completed' AND NOT EXISTS (
          SELECT 1 FROM runs newer
          WHERE newer.workspace_id = r.workspace_id AND newer.status = 'completed'
            AND (coalesce(newer.completed_at, newer.created_at), newer.created_at, newer.id)
              > (coalesce(r.completed_at, r.created_at), r.created_at, r.id)
        )) AS keep_workspace
      FROM runs r
      WHERE r.id = ANY($1::uuid[]) AND r.status IN ('completed', 'failed', 'cancelled') AND r.completed_at < $2
    `,
    [names, cutoff],
  );
  for (const { id, keep_workspace } of rows) {
    const executions = await pool.query<{ id: string }>("SELECT id FROM agent_executions WHERE run_id = $1", [id]);
    for (const execution of executions.rows) await rm(traceFilePath(options.dataDirectory, execution.id), { force: true });
    // Keep only the latest successful copy as the workspace's continuation head.
    // Other files, including the head's traces, follow ordinary retention.
    if (!keep_workspace) await rm(path.join(root, id), { recursive: true, force: true });
  }
  return rows.length;
}

export function startRunFileSweep(
  pool: Pick<pg.Pool, "query">,
  options: { dataDirectory: string; retentionDays: number; onError: (error: unknown) => void; onRemoved: (runs: number) => void },
): () => void {
  if (options.retentionDays <= 0) return () => {};
  const sweep = () =>
    void removeExpiredRunFiles(pool, options)
      .then((runs) => {
        if (runs > 0) options.onRemoved(runs);
      })
      .catch(options.onError);
  sweep();
  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}

import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { traceFilePath } from "./trace.js";

// Removes the files a finished Run left behind once they are past retention: its
// working copy and its attempts' raw traces. Rows stay, so audit events, findings
// and statuses outlive the files. Only a Run the database says has finished is
// touched; a directory with no matching Run is left alone.

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1_000;
const SWEEP_MS = 60 * 60 * 1_000;

/** Returns how many Runs had files removed. */
export async function removeExpiredRunFiles(
  pool: Pick<pg.Pool, "query">,
  options: { dataDirectory: string; retentionDays: number; now?: () => number },
): Promise<number> {
  const root = path.join(options.dataDirectory, "runs");
  const names = (await readdir(root).catch(() => [] as string[])).filter((name) => RUN_ID.test(name));
  if (names.length === 0) return 0;
  const cutoff = new Date((options.now?.() ?? Date.now()) - options.retentionDays * DAY_MS).toISOString();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM runs
      WHERE id = ANY($1::uuid[]) AND status IN ('completed', 'failed', 'cancelled') AND completed_at < $2`,
    [names, cutoff],
  );
  for (const { id } of rows) {
    const executions = await pool.query<{ id: string }>("SELECT id FROM agent_executions WHERE run_id = $1", [id]);
    for (const execution of executions.rows) await rm(traceFilePath(options.dataDirectory, execution.id), { force: true });
    // The working copy goes last: finding it again is how a failed sweep gets retried.
    await rm(path.join(root, id), { recursive: true, force: true });
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

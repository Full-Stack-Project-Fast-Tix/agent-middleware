import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** apps/server/migrations, from both src/db (tsx) and dist/db (built). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** Arbitrary constant: two servers starting at once take turns instead of racing. */
const MIGRATION_LOCK = 464_001;

/**
 * Applies every `*.sql` file in `dir` not yet recorded in schema_migrations, in
 * filename order, each in its own transaction. Returns the names it applied.
 */
export async function migrate(client: pg.ClientBase, dir = MIGRATIONS_DIR): Promise<string[]> {
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz(3) NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((row) => row.name),
    );
    const pending = (await readdir(dir)).filter((name) => name.endsWith(".sql") && !done.has(name)).sort();
    for (const name of pending) {
      const sql = await readFile(path.join(dir, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${(error as Error).message}`, { cause: error });
      }
    }
    return pending;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
  }
}

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** apps/server/migrations, from both src/db (tsx) and dist/db (built). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** Arbitrary constant: two servers starting at once take turns instead of racing. */
const MIGRATION_LOCK = 464_001;

const checksumOf = (sql: string) => createHash("sha256").update(sql).digest("hex");

/**
 * Applies every `*.sql` file in `dir` not yet recorded in schema_migrations, in
 * filename order, each in its own transaction. Returns the names it applied.
 * Refuses to run when an applied file has changed since: databases that ran
 * the old file would never see the edit, so a schema change is a new file.
 */
export async function migrate(client: pg.ClientBase, dir = MIGRATIONS_DIR): Promise<string[]> {
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz(3) NOT NULL DEFAULT now())",
    );
    // Databases migrated before checksums were recorded get theirs on the next run.
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
    const applied = new Map(
      (await client.query<{ name: string; checksum: string | null }>("SELECT name, checksum FROM schema_migrations")).rows.map(
        (row) => [row.name, row.checksum],
      ),
    );

    const pending: Array<{ name: string; sql: string; checksum: string }> = [];
    for (const name of (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort()) {
      const sql = await readFile(path.join(dir, name), "utf8");
      const checksum = checksumOf(sql);
      if (!applied.has(name)) {
        pending.push({ name, sql, checksum });
      } else if (applied.get(name) === null) {
        await client.query("UPDATE schema_migrations SET checksum = $2 WHERE name = $1", [name, checksum]);
      } else if (applied.get(name) !== checksum) {
        throw new Error(`Migration ${name} has changed since it was applied. Put schema changes in a new migration.`);
      }
    }

    for (const { name, sql, checksum } of pending) {
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${(error as Error).message}`, { cause: error });
      }
    }
    return pending.map(({ name }) => name);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
  }
}

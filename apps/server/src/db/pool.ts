import pg from "pg";
import { migrate } from "./migrate.js";

/** A connection pool on an up-to-date schema. Call once, at startup. */
export async function openDatabase(config: pg.PoolConfig): Promise<pg.Pool> {
  const pool = new pg.Pool(config);
  // Without a listener, an idle connection the database drops crashes the process.
  pool.on("error", (error) => console.error("Idle Postgres connection failed:", error.message));
  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }
  return pool;
}

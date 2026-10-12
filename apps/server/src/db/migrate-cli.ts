import pg from "pg";
import { migrate } from "./migrate.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();
try {
  const applied = await migrate(client);
  console.log(applied.length > 0 ? `Applied ${applied.join(", ")}` : "Schema is up to date");
} finally {
  await client.end();
}

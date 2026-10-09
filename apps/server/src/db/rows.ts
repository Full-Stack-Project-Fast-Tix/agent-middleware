import type pg from "pg";

// Columns are the shared schemas' fields in snake_case, with two exceptions:
// capabilities are flattened into cap_* columns, and Finding.check is
// check_name because CHECK is a reserved word. Rows are parsed with the shared
// Zod schemas on the way out, which also drops store-only columns such as
// created_seq and last_event_seq.

type Row = Record<string, unknown>;
type Queryable = Pick<pg.Pool, "query">;

const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const camel = (column: string) => column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** Postgres refuses NUL in text and jsonb, and agent output can carry one, so it becomes U+FFFD. */
function withoutNul(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll("\u0000", "\uFFFD");
  if (Array.isArray(value)) return value.map(withoutNul);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key.replaceAll("\u0000", "\uFFFD"), withoutNul(inner)]));
  }
  return value;
}

export function toRow(entity: object): Row {
  const row: Row = {};
  const set = (column: string, value: unknown) => {
    // Column names are interpolated into SQL, so only plain identifiers pass.
    if (!/^[a-z][a-z0-9_]*$/.test(column)) throw new Error(`Invalid column name: ${column}`);
    row[column] = withoutNul(value);
  };
  for (const [key, value] of Object.entries(entity)) {
    // pg would send undefined as NULL; an absent field leaves the column alone.
    if (value === undefined) continue;
    if (key === "capabilities") {
      for (const [capability, allowed] of Object.entries(value as Row)) set(`cap_${snake(capability)}`, allowed);
    } else {
      set(key === "check" ? "check_name" : snake(key), value);
    }
  }
  return row;
}

export function fromRow(row: Row): Row {
  const entity: Row = {};
  const capabilities: Row = {};
  for (const [column, raw] of Object.entries(row)) {
    // timestamptz arrives as a Date; the contracts use ISO strings ending in Z.
    const value = raw instanceof Date ? raw.toISOString() : raw;
    if (column.startsWith("cap_")) capabilities[camel(column.slice(4))] = value;
    else entity[column === "check_name" ? "check" : camel(column)] = value;
  }
  if (Object.keys(capabilities).length > 0) entity.capabilities = capabilities;
  return entity;
}

function insertQuery(table: string, entity: object, suffix: string): pg.QueryConfig {
  const row = toRow(entity);
  const columns = Object.keys(row);
  return {
    text: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) ${suffix}`,
    values: Object.values(row),
  };
}

export async function insertRow(client: Queryable, table: string, entity: object): Promise<Row> {
  const { rows } = await client.query(insertQuery(table, entity, "RETURNING *"));
  return rows[0] as Row;
}

/** Inserts the row unless one with the same key already exists. For seed data. */
export async function ensureRow(client: Queryable, table: string, entity: object): Promise<void> {
  await client.query(insertQuery(table, entity, "ON CONFLICT DO NOTHING"));
}

/** Sets the given fields on one row by id. Throws when the row does not exist. */
export async function updateRow(client: Queryable, table: string, id: string, changes: object): Promise<Row> {
  const row = toRow(changes);
  delete row.id;
  const columns = Object.keys(row);
  const { rows } = await client.query(
    `UPDATE ${table} SET ${columns.map((column, i) => `${column} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
    [id, ...Object.values(row)],
  );
  if (rows[0] === undefined) throw new Error(`Unknown ${table} row ${id}`);
  return rows[0] as Row;
}

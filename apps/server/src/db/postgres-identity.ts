import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { userSchema, type User, type WorkspaceRole, type WorkspaceSummary } from "@launchpad/shared";
import type pg from "pg";
import { fromRow } from "./rows.js";

// Users sign in with an email and password. A session is a random bearer token;
// only its SHA-256 is stored (sessions.token_hash), so a database leak does not
// leak live sessions. Workspace access comes only from workspace_members.

const SESSION_TTL_MS = 12 * 60 * 60_000;
const KEY_LENGTH = 64;

const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, KEY_LENGTH, (error, key) => (error ? reject(error) : resolve(key))),
  );

/** `scrypt$<salt>$<key>`, both base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${(await derive(password, salt)).toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || salt === undefined || key === undefined) return false;
  const expected = Buffer.from(key, "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  return timingSafeEqual(await derive(password, Buffer.from(salt, "base64url")), expected);
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Checked against when the email is unknown, so a miss costs as long as a wrong password.
let decoy: Promise<string> | undefined;

export interface Session {
  token: string;
  user: User;
  expiresAt: string;
}

export class PostgresIdentity {
  constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => Date = () => new Date(),
  ) {
    // Made up front: making it during the first miss would make that miss slower than a wrong password.
    decoy ??= hashPassword(randomUUID());
  }

  /** A new session for a matching email and password, otherwise null. The token is never stored. */
  async signIn(email: string, password: string): Promise<Session | null> {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
    const row = rows[0] as { id: string; password_hash: string | null } | undefined;
    const matches = await verifyPassword(password, row?.password_hash ?? (await decoy!));
    if (row === undefined || row.password_hash === null || !matches) return null;

    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    await this.pool.query("DELETE FROM sessions WHERE expires_at <= $1", [now.toISOString()]);
    await this.pool.query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
      hashToken(token),
      row.id,
      now.toISOString(),
      expiresAt,
    ]);
    return { token, user: userSchema.parse(fromRow(row)), expiresAt };
  }

  /** The signed-in user for a bearer token, or null when it is unknown or expired. */
  async userForToken(token: string): Promise<User | null> {
    const { rows } = await this.pool.query(
      "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2",
      [hashToken(token), this.now().toISOString()],
    );
    return rows[0] === undefined ? null : userSchema.parse(fromRow(rows[0]));
  }

  async signOut(token: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  }

  /** The user's role in the workspace, or null for a non-member. */
  async workspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const { rows } = await this.pool.query<{ role: WorkspaceRole }>(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    return rows[0]?.role ?? null;
  }

  async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    const { rows } = await this.pool.query<WorkspaceSummary>(
      `SELECT w.id, w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = $1 ORDER BY w.name, w.id`,
      [userId],
    );
    return rows;
  }
}

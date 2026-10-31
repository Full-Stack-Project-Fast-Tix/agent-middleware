import { text } from "node:stream/consumers";
import { workspaceRoleSchema } from "@launchpad/shared";
import type pg from "pg";
import { addUser, addWorkspace, seedRoleDemo, setMember } from "./admin.js";
import { openDatabase } from "./pool.js";

const USAGE = `Usage (DATABASE_URL must be set):
  npm run db:admin -- add-user <email> <name>                 password on stdin
  npm run db:admin -- add-workspace <name> <source-path> <owner-email>
  npm run db:admin -- add-workspace <name> - <owner-email>   empty workspace, no host path
  npm run db:admin -- set-member <workspace-id> <email> <developer|security_admin|auditor>
  npm run db:admin -- list-users
  npm run db:admin -- list-workspaces
  npm run db:admin -- seed-demo <source-path>                 one user per role; password on stdin`;

const [command, ...args] = process.argv.slice(2);
const connectionString = process.env.DATABASE_URL;
if (!connectionString || command === undefined) {
  console.error(USAGE);
  process.exit(1);
}

const need = (count: number) => {
  if (args.length !== count) {
    console.error(USAGE);
    process.exit(1);
  }
  return args as string[];
};

const pool: pg.Pool = await openDatabase({ connectionString });
try {
  if (command === "add-user") {
    const [email, name] = need(2);
    // From stdin, so it stays out of the shell history and the process list.
    const password = (await text(process.stdin)).replace(/\r?\n$/, "");
    console.log(await addUser(pool, { email: email!, name: name!, password }));
  } else if (command === "add-workspace") {
    const [name, sourcePath, ownerEmail] = need(3);
    console.log(await addWorkspace(pool, { name: name!, sourcePath: sourcePath === "-" ? null : sourcePath!, ownerEmail: ownerEmail! }));
  } else if (command === "set-member") {
    const [workspaceId, email, role] = need(3);
    await setMember(pool, { workspaceId: workspaceId!, email: email!, role: workspaceRoleSchema.parse(role) });
  } else if (command === "seed-demo") {
    const [sourcePath] = need(1);
    const password = (await text(process.stdin)).replace(/\r?\n$/, "");
    console.log(await seedRoleDemo(pool, { sourcePath: sourcePath!, password }));
  } else if (command === "list-users") {
    need(0);
    const { rows } = await pool.query<{ id: string; email: string; name: string; created_at: Date }>(
      "SELECT id, email, name, created_at FROM users ORDER BY lower(email), id",
    );
    for (const user of rows) console.log(`${user.id}\t${user.email}\t${user.name}\t${user.created_at.toISOString()}`);
  } else if (command === "list-workspaces") {
    need(0);
    const { rows } = await pool.query<{ id: string; name: string; source_path: string | null; members: number }>(
      `SELECT w.id, w.name, w.source_path, count(m.user_id)::int AS members
       FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id = w.id
       GROUP BY w.id ORDER BY lower(w.name), w.id`,
    );
    for (const workspace of rows) {
      console.log(`${workspace.id}\t${workspace.name}\t${workspace.members} member(s)\t${workspace.source_path ?? "(empty workspace)"}`);
    }
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}

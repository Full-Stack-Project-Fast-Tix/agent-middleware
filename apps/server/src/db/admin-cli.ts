import { text } from "node:stream/consumers";
import { workspaceRoleSchema } from "@launchpad/shared";
import type pg from "pg";
import { addUser, addWorkspace, seedRoleDemo, setMember } from "./admin.js";
import { openDatabase } from "./pool.js";

const USAGE = `Usage (DATABASE_URL must be set):
  npm run db:admin -- add-user <email> <name>                 password on stdin
  npm run db:admin -- add-workspace <name> <source-path> <owner-email>
  npm run db:admin -- set-member <workspace-id> <email> <developer|security_admin|auditor>
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
    console.log(await addWorkspace(pool, { name: name!, sourcePath: sourcePath!, ownerEmail: ownerEmail! }));
  } else if (command === "set-member") {
    const [workspaceId, email, role] = need(3);
    await setMember(pool, { workspaceId: workspaceId!, email: email!, role: workspaceRoleSchema.parse(role) });
  } else if (command === "seed-demo") {
    const [sourcePath] = need(1);
    const password = (await text(process.stdin)).replace(/\r?\n$/, "");
    console.log(await seedRoleDemo(pool, { sourcePath: sourcePath!, password }));
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}

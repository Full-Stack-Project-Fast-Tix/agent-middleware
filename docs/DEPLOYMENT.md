# Deployment

Multi-agent Runs on Claude run on a Linux host with a container engine:
[Multi-agent deployment](#multi-agent-deployment), and what that means for Claude
under [Claude runtime](#claude-runtime).

## Multi-agent deployment

Multi-agent Runs need one disposable container per execution, and the Compose app
container cannot start containers. `scripts/deploy-multi-agent.sh` therefore runs the
control plane on the host under systemd, with PostgreSQL still in Compose. Giving the
app container the Docker socket would work too, but it would hand it control of the
host.

Needs Linux with systemd, Docker Engine 24+, the Compose plugin, Node.js 22+ and
`sudo`. Install Docker, then set these in `.env.production`:

```dotenv
APP_AUTH_MODE=password
POSTGRES_PASSWORD=letters-digits-only-and-not-the-default
ANTHROPIC_API_KEY=your-anthropic-api-key
PUBLIC_PORT=3000
# Optional. Copies each nightly backup off the machine; the dump's path is $1.
BACKUP_UPLOAD_COMMAND=tosutil cp "$1" tos://your-bucket/agentguard/
```

Then deploy and add people:

```bash
chmod 600 .env.production
./scripts/deploy-multi-agent.sh .env.production
export DATABASE_URL=postgres://launchpad:your-password@127.0.0.1:5433/launchpad
printf '%s' 'a-long-password' | npm run db:admin -w @launchpad/server -- add-user you@example.com "Your Name"
npm run db:admin -w @launchpad/server -- add-workspace checkout /srv/checkout you@example.com
npm run db:admin -w @launchpad/server -- list-users
npm run db:admin -w @launchpad/server -- list-workspaces
```

Use `-` as the source path to create an empty workspace. First-account
bootstrap and project-path registration remain operator-only. After signing in,
a workspace security admin can create an account attached to that workspace,
manage its roles, or create another workspace in the Members view: empty, or
with a project folder inside one of the `WORKSPACE_SOURCE_ROOTS` the operator set
(contract decision 32). Deliver
new account passwords to their owners through a secure channel.

For a demo, `seed-demo <source-path>` makes one workspace with one person per role,
with the password from stdin.

What it sets up: `agentguard.service`, and `agentguard-backup.timer`, which runs
`scripts/pg-backup-nightly.sh` at 03:00. State is under `.state/`, or
`AGENTGUARD_STATE_DIR`. Its `agentguard.env` holds the database password, readable
only by you. `GET /api/health` answers 503 when the database is down.

This deployment does not enforce provider-only egress at the host or Docker network
layer for a profile granted network access. Workspace roles and per-Run copies
remain logical separation, not hardened isolation between mutually untrusted
tenants.

> [!IMPORTANT]
> This script has not yet been run on a real host: its checks and the backup
> script were tested, the systemd steps were not. Serve it over TLS before real use, because sessions are bearer tokens.

Settings worth knowing: `RUN_ARTIFACT_RETENTION_DAYS` (30, 0 keeps files forever)
removes a finished Run's working copy and raw traces, and `RUN_TOKEN_BUDGET`
(2,000,000) stops new attempts once a Run has used that many tokens.

## Claude runtime

Runs run on Claude. The first-run steps
and costs are in the README, under
[Run on Claude](../README.md#run-on-claude). What is different for deployment:

- **It runs on a host with a container engine.** The server process starts one
  container per execution, so it needs access to Docker, Colima or Podman. `npm run poc` does this. The
  Compose app container has no engine, and mounting the Docker socket into it would
  give it control of the host, so run the server on the host.
- **Build the tool image** first with `npm run build:claude-runtime`
  (`Dockerfile.claude-runtime`). The default name is
  `agentguard-claude-runtime:local`, and it is never pulled from a registry.
- **The API key stays with the server process.** Only the server needs
  `ANTHROPIC_API_KEY`. The server needs outbound HTTPS to `api.anthropic.com`. The
  tool containers need no route to it, and get none when policy denies network.
- **Only the host's network matters for model calls.** With any guard enabled the
  policy denies network to every execution, so containers run with
  `--network none`. An agent profile with the `network` capability and no guard
  gets a bridge network, which can reach the host, including
  `host.docker.internal`. Treat that capability accordingly.
- **Tools run as a non-root user.** Set `CONTAINER_USER` to a non-root `uid:gid` if
  the server itself runs as root; the runtime refuses to start a container as root.
- **Check the boundary after any image change:**
  `npm run verify:claude-runtime -w @launchpad/server`. It needs Docker and no key.

## Back up and restore PostgreSQL

`scripts/pg-backup.sh` works on the running compose stack's `postgres` container
and needs only Docker on the host. It finds the container by its Compose labels
and does not read `docker-compose.yml`, `.env` or `.env.production`. The database
user and default database name come from the container's own environment. If the
stack runs under another project name, set `COMPOSE_PROJECT_NAME`, or name the
container directly with `POSTGRES_CONTAINER`.

Stopping and starting the app does go through Compose. The `launchpad` service
loads its settings from `LAUNCHPAD_ENV_FILE`, which defaults to `.env`, so point
that at your env file as below if yours has another name.

```bash
# Writes backups/<db>-<UTC time>.dump, readable only by you
scripts/pg-backup.sh backup

# Row count of every table, to compare before and after
scripts/pg-backup.sh counts --db launchpad

# Restore into a new database, to inspect a backup safely
scripts/pg-backup.sh restore --db launchpad_check backups/launchpad-20261031T120000Z.dump

# Recover the live database: stop the app first, then replace
export LAUNCHPAD_ENV_FILE=.env.production
docker compose --env-file "$LAUNCHPAD_ENV_FILE" stop launchpad
scripts/pg-backup.sh restore --db launchpad --replace backups/launchpad-20261031T120000Z.dump
docker compose --env-file "$LAUNCHPAD_ENV_FILE" start launchpad
```

`--replace` restores into a temporary database and swaps it in only after that
succeeds, so a damaged backup leaves the current database in place. It fails
while anything is connected to the database.

What to know before relying on this:

- **Only the multi-agent deployment runs on a schedule.** Elsewhere, run
  `scripts/pg-backup-nightly.sh` from cron. Set `BACKUP_UPLOAD_COMMAND` to copy each
  dump to another machine: a backup on the database's own disk does not survive
  losing that disk. A failed upload fails the run, and only `nightly-*` dumps older
  than `BACKUP_KEEP_DAYS` (14) are removed, and only after the upload has worked.
- **A backup is sensitive.** It holds password hashes, session token hashes, and
  stored agent output. Encrypt it wherever it is kept. `backups/` is ignored by
  Git.
- **Sessions come back too.** A session in the backup works after a restore until
  it expires, up to 12 hours after it began. To sign everyone out, run `DELETE FROM
  sessions` after restoring.
- **Restoring loses what came after the backup,** including audit events. Audit
  rows are append-only for the application, not for whoever operates the database.
- **Restore drill.** On 31 October 2026 a backup was restored into a new database on
  a disposable local PostgreSQL 16, and every table's row count matched. That was a
  small test database, not a deployed one, so repeat it on the real host.
- **Only PostgreSQL is covered.** Traces under `data/`, Run working copies under
  and `workspaces/` are files on the host. Back them up separately.
  A restored Run can point at a trace that no longer exists.
- **Active Runs do not resume.** On startup, the server closes any Run the restored
  database still shows as active.

## Secret handling

- `.env.production` must not be committed. Production deployments require managed
  secrets.
- Never pass cloud account credentials to an Agent Runtime.

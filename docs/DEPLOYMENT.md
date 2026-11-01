# Deployment

Use one of these Volcengine ECS paths:

- Install and deploy to an existing Linux ECS instance. This runs token mode, the
  single-agent path.
- Provision the complete network and ECS stack with Terraform. This also runs token
  mode.
- [Multi-agent deployment](#multi-agent-deployment) on an existing Linux host, for
  signed-in users and multi-agent Runs.

All of them require a Volcengine Ark API key and a Responses-capable endpoint.
They run Codex. Multi-agent Runs on Claude run on a host with a container engine
instead: see [Claude runtime](#claude-runtime).

## Existing Linux ECS

Recommended host:

- Ubuntu 22.04/24.04, Debian 12, or veLinux 2
- 2 vCPU, 4 GiB memory, and a 40 GiB system disk
- Docker Engine 24+ and the Docker Compose plugin

The procedure was verified from a clean veLinux 2 host with Docker Engine
29.6.2 and Compose 5.3.1. Debian 10 is unsupported.

### Install Docker

Install prerequisites:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git openssl
```

Select the Docker repository. veLinux 2 uses Debian 12 Bookworm:

```bash
. /etc/os-release
case "$ID" in
  ubuntu|debian)
    DOCKER_DISTRO="$ID"
    DOCKER_CODENAME="$VERSION_CODENAME"
    ;;
  velinux)
    DOCKER_DISTRO=debian
    DOCKER_CODENAME=bookworm
    ;;
  *)
    echo "Use the Docker-supported parent distribution."
    exit 1
    ;;
esac
```

Download the signing key and compare its full fingerprint with the official
[Docker installation guide](https://docs.docker.com/engine/install/):

```bash
curl -fsSL "https://download.docker.com/linux/$DOCKER_DISTRO/gpg" \
  -o /tmp/docker.asc
gpg --show-keys --with-fingerprint /tmp/docker.asc
```

After verification, install Docker:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo gpg --batch --yes --dearmor \
  -o /etc/apt/keyrings/docker.gpg /tmp/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$DOCKER_DISTRO $DOCKER_CODENAME stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log in again, then verify:

```bash
docker version
docker compose version
docker run --rm hello-world
```

Do not replace an existing engine on a host with important containers. Use a
dedicated ECS instance for this POC.

### Deploy

```bash
git clone https://github.com/your-org/volc-agent-launchpad.git
cd volc-agent-launchpad
cp .env.example .env.production
openssl rand -hex 32
```

Set these values in `.env.production`:

```dotenv
PUBLIC_PORT=80
APP_AUTH_MODE=token
MODEL_PROVIDER=ark
RUNTIME_PROVIDER=local-process
CONTAINER_RUNTIME_IMAGE=volc-agent-runtime:local
ARK_API_KEY=your-ark-api-key
ARK_MODEL=ep-your-endpoint-id
APP_AUTH_TOKEN=the-random-token-generated-above
```

The template now documents Claude as its default, and this Compose path runs
Codex, so these first three lines are required here. See
[Claude runtime](#claude-runtime) for why it does not use Compose.

Deploy:

```bash
chmod 600 .env.production
./scripts/deploy-existing-ecs.sh .env.production
```

Verify:

```bash
curl http://127.0.0.1/api/health
export APP_AUTH_TOKEN=your-shared-demo-token
curl -H "Authorization: Bearer $APP_AUTH_TOKEN" \
  http://127.0.0.1/api/system
docker compose --env-file .env.production ps
```

Deploy updates with `git pull --ff-only`, then rerun the deployment script.

### Network and cleanup

- Allow TCP 80 only from the event network.
- Allow TCP 22 only from administrator IP addresses.
- Allow outbound HTTPS to Ark and package registries.
- Add HTTPS before using `APP_AUTH_TOKEN` across an untrusted network.
- In password mode, failed sign-ins currently have no rate limit. Treat password
  authentication as a proof-of-concept feature and keep the service behind
  appropriate network access controls.

Stop the application without deleting Agent data:

```bash
docker compose --env-file .env.production down
```

## Terraform deployment

Terraform uses `volcenginecc` to create a VPC, subnet, security group, ECS
instance, EIP, and cloud-init configuration.

Requirements:

- Terraform 1.6+
- Volcengine account AK/SK with resource-creation permissions
- Existing ECS SSH key pair
- Ubuntu image ID and instance type available in the selected region
- Public Git URL for this repository

Create configuration files:

```bash
cp .env.example .env.production
cp deploy/volcengine/terraform.tfvars.example \
  deploy/volcengine/terraform.tfvars
```

Set `APP_AUTH_MODE=token`, `MODEL_PROVIDER=ark`, `ARK_API_KEY` and `ARK_MODEL` in
`.env.production`. Set the region, zone,
image, instance type, key pair, allowed CIDRs, and repository URL in
`terraform.tfvars`.

Provide account credentials only through the current shell:

```bash
export VOLCENGINE_ACCESS_KEY=your-access-key
export VOLCENGINE_SECRET_KEY=your-secret-key
./scripts/deploy-volcengine.sh
```

After Terraform prints `app_url`, allow 5 to 10 minutes for cloud-init and the
Docker build. Inspect progress with:

```bash
ssh root@your-ecs-public-ip
cloud-init status --wait
tail -n 200 /var/log/cloud-init-output.log
```

Destroy the stack when the event ends:

```bash
terraform -chdir=deploy/volcengine destroy
```

> [!CAUTION]
> Destroying the stack removes the ECS instance, system disk, and Agent
> workspaces. Back up required code first.

## Multi-agent deployment

Multi-agent Runs need one disposable container per execution, and the Compose app
container cannot start containers. `scripts/deploy-multi-agent.sh` therefore runs the
control plane on the host under systemd, with PostgreSQL still in Compose. Giving the
app container the Docker socket would work too, but it would hand it control of the
host.

Needs Linux with systemd, Docker Engine 24+, the Compose plugin, Node.js 22+ and
`sudo`. Install Docker as above, then set these in `.env.production`:

```dotenv
APP_AUTH_MODE=password
POSTGRES_PASSWORD=letters-digits-only-and-not-the-default
ARK_API_KEY=your-ark-api-key
ARK_MODEL=ep-your-endpoint-id
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
manage its roles, or create another empty workspace in the Members view. Deliver
new account passwords to their owners through a secure channel.

For a demo, `seed-demo <source-path>` makes one workspace with one person per role,
with the password from stdin.

What it sets up: `agentguard.service`, and `agentguard-backup.timer`, which runs
`scripts/pg-backup-nightly.sh` at 03:00. State is under `.state/`, or
`AGENTGUARD_STATE_DIR`. Its `agentguard.env` holds the database password, readable
only by you. `GET /api/health` answers 503 when the database is down.

The multi-agent script requires Codex's `workspace-write` sandbox check to pass
and rejects `CODEX_SANDBOX_MODE=danger-full-access`. Do not work around a failed
check by relaxing the sandbox. Agent command networking relies on Codex sandbox
controls; this deployment does not enforce provider-only egress at the host or
Docker network layer. Runtime containers get an execution-specific Codex home
with generated provider configuration only. Workspace roles and per-Run copies
remain logical separation, not hardened isolation between mutually untrusted
tenants.

> [!IMPORTANT]
> This script has not yet been run on a real ECS host: its checks and the backup
> script were tested, the systemd steps were not. Terraform's cloud-init still deploys
> token mode. Serve it over TLS before real use, because sessions are bearer tokens.

Settings worth knowing: `RUN_ARTIFACT_RETENTION_DAYS` (30, 0 keeps files forever)
removes a finished Run's working copy and raw traces, and `RUN_TOKEN_BUDGET`
(2,000,000) stops new attempts once a Run has used that many tokens.

## Claude runtime

`MODEL_PROVIDER=anthropic` runs multi-agent Runs on Claude. The first-run steps
and costs are in the README, under
[Run on Claude](../README.md#run-on-claude). What is different for deployment:

- **It runs on a host with a container engine.** The server process starts one
  container per execution, so it needs `RUNTIME_PROVIDER=container` and access to
  Docker, Colima or Podman. `npm run poc` does this. The Compose and ECS paths in
  this file do not give the application container an engine, and mounting the
  Docker socket into it would give it control of the host, so they stay on Codex
  for now.
- **The image contains no Codex.** Build it with `npm run build:claude-runtime`
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
  `workspaces/`, and `codex-home/` are files on the host. Back them up separately.
  A restored Run can point at a trace that no longer exists.
- **Active Runs do not resume.** On startup, the server closes any Run the restored
  database still shows as active.

## Secret handling

- Ark keys configure model access; Volcengine account AK/SK configures
  Terraform. Never pass account AK/SK to an Agent Runtime.
- `.env.production`, `terraform.tfvars`, and Terraform state must not be
  committed.
- The POC stores the Ark key in Terraform user data and state. Production
  deployments require managed secrets and an encrypted remote state backend.

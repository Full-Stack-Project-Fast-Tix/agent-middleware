#!/usr/bin/env bash
set -euo pipefail

# Deploys multi-agent runs on one Linux host: PostgreSQL in Compose, the control
# plane as a systemd service on the host, and one disposable Docker container per
# agent execution. The control plane stays on the host so the app never needs the
# Docker socket inside a container. See "Multi-agent deployment" in docs/DEPLOYMENT.md.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

env_file="${1:-.env.production}"
service=agentguard

fail() {
  echo "deploy-multi-agent: $*" >&2
  exit 1
}

env_value() {
  sed -n "s/^$1=//p" "$env_file" | tail -n 1
}

[[ -f "$env_file" ]] || fail "missing $env_file. Copy .env.example and fill it in."
[[ "$(stat -c '%a' "$env_file")" == "600" ]] || fail "$env_file holds secrets: run chmod 600 $env_file"
[[ "$(env_value APP_AUTH_MODE)" == "password" ]] || fail "set APP_AUTH_MODE=password in $env_file. Multi-agent runs need signed-in users."
[[ -n "$(env_value POSTGRES_PASSWORD)" ]] || fail "set POSTGRES_PASSWORD in $env_file."
if [[ "$(env_value MODEL_PROVIDER)" == "openai" ]]; then
  [[ -n "$(env_value OPENAI_API_KEY)" ]] || fail "set OPENAI_API_KEY in $env_file."
else
  [[ -n "$(env_value ARK_API_KEY)" && -n "$(env_value ARK_MODEL)" ]] || fail "set ARK_API_KEY and ARK_MODEL in $env_file."
fi
command -v systemctl >/dev/null 2>&1 || fail "this script needs systemd. Use scripts/start-local-poc.sh on a laptop."
command -v docker >/dev/null 2>&1 || fail "Docker Engine 24 or newer is required."
docker compose version >/dev/null 2>&1 || fail "the Docker Compose plugin is required."
command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required."
(( "$(node -p 'Number(process.versions.node.split(".")[0])')" >= 22 )) || fail "Node.js 22 or newer is required."
[[ "$(env_value POSTGRES_PASSWORD)" != "launchpad" ]] || fail "choose a POSTGRES_PASSWORD other than the default."
# It goes into DATABASE_URL as it is, so it must not need URL-encoding.
[[ "$(env_value POSTGRES_PASSWORD)" =~ ^[A-Za-z0-9_-]+$ ]] || fail "POSTGRES_PASSWORD may use only letters, digits, _ and -."

run_user="$(id -un)"
state_dir="${AGENTGUARD_STATE_DIR:-$repo_dir/.state}"
mkdir -p "$state_dir/data" "$state_dir/workspaces" "$state_dir/codex-home" backups

echo "Starting PostgreSQL."
LAUNCHPAD_ENV_FILE="$env_file" docker compose --env-file "$env_file" up -d --wait postgres

runtime_image="$(env_value CONTAINER_RUNTIME_IMAGE)"
runtime_image="${runtime_image:-volc-agent-runtime:local}"
echo "Building $runtime_image."
docker build --file Dockerfile.runtime --tag "$runtime_image" \
  --build-arg "NODE_IMAGE=$(env_value CONTAINER_RUNTIME_BASE_IMAGE | grep . || echo node:22-bookworm-slim)" \
  --build-arg "DEBIAN_MIRROR=$(env_value CONTAINER_APT_MIRROR)" \
  --build-arg "DEBIAN_SECURITY_MIRROR=$(env_value CONTAINER_APT_SECURITY_MIRROR)" \
  --build-arg "RUNTIME_APT_PACKAGES=$(env_value CONTAINER_RUNTIME_APT_PACKAGES | grep . || echo 'ca-certificates curl git ripgrep')" \
  .

echo "Building the app."
npm ci
npm run build

sandbox_mode="$(env_value CODEX_SANDBOX_MODE)"
sandbox_mode="${sandbox_mode:-workspace-write}"
if [[ "$sandbox_mode" == "workspace-write" ]] \
  && ! docker run --rm "$runtime_image" codex sandbox linux --full-auto -- true >/dev/null 2>&1; then
  echo "Codex Landlock is unavailable here, so executions rely on the disposable container boundary."
  sandbox_mode=danger-full-access
fi

public_port="$(env_value PUBLIC_PORT)"
public_port="${public_port:-3000}"
postgres_user="$(env_value POSTGRES_USER)"
postgres_db="$(env_value POSTGRES_DB)"
postgres_port="$(env_value POSTGRES_PORT)"

# Read after the operator's file, so these cannot drift from what this script set up.
overrides="$state_dir/$service.env"
( umask 077; cat >"$overrides" <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=$public_port
RUNTIME_PROVIDER=container
CONTAINER_ENGINE=docker
CONTAINER_RUNTIME_IMAGE=$runtime_image
CONTAINER_USER=$(id -u):$(id -g)
CODEX_SANDBOX_MODE=$sandbox_mode
APP_DATA_DIR=$state_dir/data
AGENT_WORKSPACE_ROOT=$state_dir/workspaces
CODEX_HOME=$state_dir/codex-home
DATABASE_URL=postgres://${postgres_user:-launchpad}:$(env_value POSTGRES_PASSWORD)@127.0.0.1:${postgres_port:-5433}/${postgres_db:-launchpad}
EOF
)

sudo tee "/etc/systemd/system/$service.service" >/dev/null <<EOF
[Unit]
Description=AgentGuard control plane
After=docker.service network-online.target
Requires=docker.service

[Service]
User=$run_user
WorkingDirectory=$repo_dir
EnvironmentFile=$repo_dir/$env_file
EnvironmentFile=$overrides
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=$(command -v npm) start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo tee "/etc/systemd/system/$service-backup.service" >/dev/null <<EOF
[Unit]
Description=AgentGuard nightly PostgreSQL backup

[Service]
Type=oneshot
User=$run_user
WorkingDirectory=$repo_dir
EnvironmentFile=$repo_dir/$env_file
ExecStart=$repo_dir/scripts/pg-backup-nightly.sh
EOF

sudo tee "/etc/systemd/system/$service-backup.timer" >/dev/null <<EOF
[Unit]
Description=Run the AgentGuard backup every night

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "$service-backup.timer"
sudo systemctl enable "$service.service"
sudo systemctl restart "$service.service"

echo "Waiting for the health check."
for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:$public_port/api/health" >/dev/null; then
    echo "AgentGuard is up on port $public_port. Add users with: npm run db:admin -w @launchpad/server -- add-user"
    exit 0
  fi
  sleep 2
done
fail "the health check did not pass. See: journalctl -u $service -n 50"

#!/usr/bin/env bash
set -euo pipefail

# Backs up and restores the compose stack's PostgreSQL database. The tools run
# inside the postgres container, so they always match the server's version and
# the host needs only Docker. See "Back up and restore PostgreSQL" in
# docs/DEPLOYMENT.md.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/pg-backup.sh backup [--db NAME] [FILE]       default FILE: backups/<db>-<UTC time>.dump
  scripts/pg-backup.sh restore --db NAME [--replace] FILE
  scripts/pg-backup.sh counts --db NAME                row count of every table

backup uses the stack's POSTGRES_DB unless --db names another database.
restore creates NAME, and refuses if it exists unless --replace is given.
--replace restores to a temporary database first, so a bad backup leaves NAME
untouched. It fails while anything is connected to NAME: stop the app first.
EOF
  exit 2
}

fail() {
  echo "pg-backup: $*" >&2
  exit 1
}

# Found by Compose's labels rather than `docker compose exec`, so this reads
# neither docker-compose.yml nor an env file. POSTGRES_CONTAINER overrides it.
postgres_container() {
  if [[ -n "${POSTGRES_CONTAINER:-}" ]]; then
    printf '%s' "$POSTGRES_CONTAINER"
    return
  fi
  local project found
  project="$(printf '%s' "${COMPOSE_PROJECT_NAME:-$(basename "$repo_dir")}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  found="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=postgres")"
  [[ -n "$found" ]] || fail "no running postgres container in Compose project $project. Start it, or set COMPOSE_PROJECT_NAME or POSTGRES_CONTAINER."
  [[ "$found" != *$'\n'* ]] || fail "more than one postgres container in Compose project $project. Set POSTGRES_CONTAINER."
  printf '%s' "$found"
}

# Everything runs through `sh -c` so $POSTGRES_USER and $POSTGRES_DB are the
# container's own. Arguments follow as "$1", "$2" and are never pasted into the
# script text.
in_postgres() {
  docker exec -i "$container" sh -c "$@"
}

default_db() {
  in_postgres 'printf %s "${POSTGRES_DB:-$POSTGRES_USER}"'
}

# Database names go into SQL as identifiers, which cannot be bound parameters.
check_db_name() {
  [[ "$1" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] || fail "not a usable database name: $1"
}

sql() {
  in_postgres 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -Atc "$2"' _ "$1" "$2"
}

db_exists() {
  [[ "$(sql postgres "SELECT count(*) FROM pg_database WHERE datname = '$1'")" == "1" ]]
}

backup() {
  local db="" file=""
  while (($#)); do
    case "$1" in
      --db) db="${2:-}"; [[ -n "$db" ]] || usage; shift 2 ;;
      -*) usage ;;
      *) [[ -z "$file" ]] || usage; file="$1"; shift ;;
    esac
  done
  [[ -n "$db" ]] || db="$(default_db)"
  check_db_name "$db"
  [[ -n "$file" ]] || file="backups/$db-$(date -u +%Y%m%dT%H%M%SZ).dump"
  [[ ! -e "$file" ]] || fail "$file already exists"

  mkdir -p "$(dirname "$file")"
  # A backup holds password hashes and agent output: readable by this user only.
  umask 077
  # Written beside the target and moved once complete and readable, so a failed
  # dump never looks like a backup.
  local partial="$file.partial"
  trap 'rm -f "$partial"' EXIT
  in_postgres 'pg_dump -U "$POSTGRES_USER" -d "$1" --format=custom' _ "$db" >"$partial"
  in_postgres 'pg_restore --list >/dev/null' <"$partial" || fail "the dump of $db could not be read back"
  mv "$partial" "$file"
  trap - EXIT
  echo "$file"
}

restore() {
  local db="" file="" replace=false
  while (($#)); do
    case "$1" in
      --db) db="${2:-}"; [[ -n "$db" ]] || usage; shift 2 ;;
      --replace) replace=true; shift ;;
      -*) usage ;;
      *) [[ -z "$file" ]] || usage; file="$1"; shift ;;
    esac
  done
  [[ -n "$db" && -n "$file" ]] || usage
  check_db_name "$db"
  [[ -f "$file" ]] || fail "no backup at $file"
  if db_exists "$db" && [[ "$replace" != true ]]; then
    fail "database $db already exists. Use --replace to overwrite it."
  fi

  local target="${db:0:50}_restoring"
  db_exists "$target" && fail "$target already exists, probably from an interrupted restore. Check it, then drop it."
  sql postgres "CREATE DATABASE \"$target\"" >/dev/null
  trap 'sql postgres "DROP DATABASE IF EXISTS \"$target\"" >/dev/null || true' EXIT
  # A fresh database and one transaction: all of it arrives or none. Triggers,
  # including the audit table's append-only ones, are created after the data.
  in_postgres 'pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --single-transaction --exit-on-error' _ "$target" <"$file"

  # From here the restored copy may be the only one left, so nothing may drop it
  # automatically: only a refused DROP, which leaves the original intact, cleans up.
  trap - EXIT
  if db_exists "$db"; then
    if ! sql postgres "DROP DATABASE \"$db\"" >/dev/null; then
      sql postgres "DROP DATABASE IF EXISTS \"$target\"" >/dev/null || true
      fail "could not replace $db. Is the app still connected? Stop it first."
    fi
  fi
  sql postgres "ALTER DATABASE \"$target\" RENAME TO \"$db\"" >/dev/null \
    || fail "the restored data is in $target, not $db. Rename it by hand: ALTER DATABASE \"$target\" RENAME TO \"$db\""
  echo "Restored $file into $db"
}

counts() {
  [[ "${1:-}" == "--db" && -n "${2:-}" && $# -eq 2 ]] || usage
  local db="$2" table
  check_db_name "$db"
  db_exists "$db" || fail "no database named $db"
  # Exact counts, not the planner's estimates: this is for checking a restore.
  for table in $(sql "$db" "SELECT quote_ident(tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY 1"); do
    printf '%s\t%s\n' "$table" "$(sql "$db" "SELECT count(*) FROM $table")"
  done
}

command="${1:-}"
[[ $# -gt 0 ]] && shift
case "$command" in backup | restore | counts) container="$(postgres_container)" ;; esac
case "$command" in
  backup) backup "$@" ;;
  restore) restore "$@" ;;
  counts) counts "$@" ;;
  *) usage ;;
esac

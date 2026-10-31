#!/usr/bin/env bash
set -euo pipefail

# One scheduled backup: dump, copy off the machine, prune old local dumps. A
# backup on the database's own disk does not survive losing that disk, so a failed
# upload fails this run, and nothing is pruned until the upload has worked.
#
#   BACKUP_UPLOAD_COMMAND  Run with the dump's path as $1. For Volcengine object
#                          storage: tosutil cp "$1" tos://your-bucket/agentguard/
#                          Empty keeps the dump on this machine only, and says so.
#   BACKUP_KEEP_DAYS       Local dumps older than this are removed. Default 14.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

keep_days="${BACKUP_KEEP_DAYS:-14}"
[[ "$keep_days" =~ ^[1-9][0-9]*$ ]] || { echo "pg-backup-nightly: BACKUP_KEEP_DAYS must be a positive number" >&2; exit 2; }

file="backups/nightly-$(date -u +%Y%m%dT%H%M%SZ).dump"
scripts/pg-backup.sh backup "$file"

if [[ -n "${BACKUP_UPLOAD_COMMAND:-}" ]]; then
  bash -c "$BACKUP_UPLOAD_COMMAND" upload "$file"
  echo "pg-backup-nightly: uploaded $file"
else
  echo "pg-backup-nightly: BACKUP_UPLOAD_COMMAND is not set, so $file is only on this machine." >&2
fi

# Only this script's own dumps, so a hand-made backup is never removed.
find backups -maxdepth 1 -type f -name 'nightly-*.dump' -mtime "+$keep_days" -print -delete

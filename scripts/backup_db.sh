#!/usr/bin/env sh
set -eu

BACKUP_DIR="${BACKUP_DIR:-/opt/sol-rsi-bot/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d_%H%M%S)"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
umask 077
pg_dump --format=custom --no-owner "$DATABASE_URL" > "$BACKUP_DIR/solbot_$STAMP.dump"
find "$BACKUP_DIR" -type f -name 'solbot_*.dump' -mtime "+$RETENTION_DAYS" -delete

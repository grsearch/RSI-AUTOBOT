#!/usr/bin/env sh
set -eu

HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:3001/healthz}"
SERVICE_NAME="${SERVICE_NAME:-sol-rsi-bot}"
MAX_FAILURES="${MAX_FAILURES:-3}"
STATE_FILE="${STATE_FILE:-/tmp/sol-rsi-bot-healthcheck.failures}"

if curl --fail --silent --show-error --max-time 10 "$HEALTHCHECK_URL" >/dev/null; then
  rm -f "$STATE_FILE"
  exit 0
fi

failures=0
if [ -f "$STATE_FILE" ]; then
  failures="$(cat "$STATE_FILE" 2>/dev/null || printf '0')"
fi
case "$failures" in
  ''|*[!0-9]*) failures=0 ;;
esac
failures=$((failures + 1))
printf '%s\n' "$failures" > "$STATE_FILE"

if [ "$failures" -lt "$MAX_FAILURES" ]; then
  echo "Health check failed ($failures/$MAX_FAILURES); restart deferred." >&2
  exit 1
fi

echo "Health check failed $failures consecutive times; restarting $SERVICE_NAME." >&2
systemctl restart "$SERVICE_NAME"
rm -f "$STATE_FILE"

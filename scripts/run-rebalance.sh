#!/bin/bash
set -e

LOCKFILE="/tmp/rebalance.lock"

if [ -f "$LOCKFILE" ]; then
  OLD_PID=$(cat "$LOCKFILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') - Rebalance already running (PID $OLD_PID), skipping."
    exit 0
  else
    rm -f "$LOCKFILE"
  fi
fi

echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

if [ -f /app/.env ]; then
  set -a
  source /app/.env
  set +a
fi

find /app/logs -name "rebalance-*.log" -mtime +7 -delete 2>/dev/null || true

cd /app
./rebalance

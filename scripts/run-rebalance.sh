#!/bin/bash
set -e

LOCKFILE="/tmp/rebalance.lock"
MAX_AGE_SECONDS=1800 # 30 min — kill stale processes (e.g. hung after laptop sleep)

if [ -f "$LOCKFILE" ]; then
  OLD_PID=$(cat "$LOCKFILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCKFILE" 2>/dev/null || stat -f %m "$LOCKFILE") ))
    if [ "$LOCK_AGE" -gt "$MAX_AGE_SECONDS" ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') - Rebalance (PID $OLD_PID) stale after ${LOCK_AGE}s, killing."
      kill -9 "$OLD_PID" 2>/dev/null || true
      rm -f "$LOCKFILE"
    else
      echo "$(date '+%Y-%m-%d %H:%M:%S') - Rebalance already running (PID $OLD_PID, age ${LOCK_AGE}s), skipping."
      exit 0
    fi
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

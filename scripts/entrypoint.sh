#!/bin/bash
set -e

# Source environment variables from .env if it exists
if [ -f /app/.env ]; then
  set -a
  source /app/.env
  set +a
fi

printf 'PATH=/usr/local/bin:/usr/bin:/bin\n0 */6 * * * /app/scripts/run-rebalance.sh >> /proc/1/fd/1 2>> /proc/1/fd/2\n' | crontab -

echo "Rebalance cron started — running every 6 hours"

# Start cron in foreground as PID 1
exec cron -f

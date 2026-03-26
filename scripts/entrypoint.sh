#!/bin/bash
set -e

# Source environment variables from .env if it exists
if [ -f /app/.env ]; then
  set -a
  source /app/.env
  set +a
fi

CRON_SCHEDULE="*/5 * * * *"

printf 'PATH=/usr/local/bin:/usr/bin:/bin\n%s /app/scripts/run-rebalance.sh >> /proc/1/fd/1 2>> /proc/1/fd/2\n' "$CRON_SCHEDULE" | crontab -

echo "Rebalance cron started — schedule: $CRON_SCHEDULE"

# Start crond in foreground as PID 1
exec crond -f

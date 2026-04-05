#!/bin/bash
set -e

if [ -f /app/.env ]; then
  set -a
  source /app/.env
  set +a
fi

exec /app/scheduler

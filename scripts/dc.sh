#!/usr/bin/env bash
# Wrapper around docker compose that injects GIT_COMMIT automatically.
# Usage: ./scripts/dc.sh up --build -d
#        ./scripts/dc.sh build
#        ./scripts/dc.sh down
set -euo pipefail

export GIT_COMMIT
GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

exec docker compose "$@"

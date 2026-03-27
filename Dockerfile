# --- Build stage: compile into a standalone binary ---
FROM oven/bun:latest AS build

WORKDIR /app

COPY package.json bun.lock ./
COPY .papi/ ./.papi/
RUN SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN bun build --compile --minify --sourcemap \
    --compile-exec-argv="--smol" \
    --target=bun-linux-arm64-musl \
    src/main.ts --outfile rebalance

# --- Runtime stage: minimal image with just the binary ---
FROM alpine:3

WORKDIR /app

RUN apk add --no-cache bash ca-certificates libstdc++ libgcc

COPY --from=build /app/rebalance /app/rebalance
COPY scripts/ ./scripts/
RUN chmod +x /app/rebalance /app/scripts/entrypoint.sh /app/scripts/run-rebalance.sh

RUN mkdir -p /app/logs /app/.papi/cache

HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD pidof crond > /dev/null || exit 1

ENTRYPOINT ["/app/scripts/entrypoint.sh"]

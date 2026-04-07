# --- Build stage: compile into a standalone binary ---
FROM --platform=$BUILDPLATFORM oven/bun:latest AS build

ARG TARGETARCH
ARG GIT_COMMIT=unknown

WORKDIR /app

COPY package.json bun.lock ./
COPY .papi/ ./.papi/
RUN SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN bun build --compile --minify --sourcemap \
    --compile-exec-argv="--smol" \
    --target=bun-linux-${TARGETARCH}-musl \
    --define "process.env.GIT_COMMIT='${GIT_COMMIT}'" \
    src/scheduler.ts --outfile scheduler

# --- Runtime stage: minimal image with just the binary ---
FROM alpine:3

WORKDIR /app

RUN apk add --no-cache bash ca-certificates libstdc++ libgcc

COPY --from=build /app/scheduler /app/scheduler
COPY scripts/ ./scripts/
COPY src/strategies/ /app/src/strategies/
RUN chmod +x /app/scheduler /app/scripts/entrypoint.sh

RUN mkdir -p /app/logs /app/data /app/.papi/cache

HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD pidof scheduler > /dev/null || exit 1

ENTRYPOINT ["/app/scripts/entrypoint.sh"]

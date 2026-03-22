FROM oven/bun:latest

WORKDIR /app

# Install cron daemon
RUN apt-get update && \
    apt-get install -y --no-install-recommends cron && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock ./
COPY .papi/ ./.papi/
RUN SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 bun install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/
COPY *.ts ./

# Create logs directory
RUN mkdir -p /app/logs

# Copy and make scripts executable
COPY entrypoint.sh run-rebalance.sh ./
RUN chmod +x /app/entrypoint.sh /app/run-rebalance.sh

HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD pgrep cron > /dev/null || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]

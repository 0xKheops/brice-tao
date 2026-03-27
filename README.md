# brice-tao

Automated portfolio rebalancer for Bittensor subnets.

https://www.youtube.com/watch?v=jBHYiRT_Zz0

## Prerequisites

- [Bun](https://bun.sh) (for local development)
- [Docker](https://docs.docker.com/get-docker/) (for containerized deployment)

## Configuration

Set the following environment variables (see `.env.example` for reference):

```env
WS_ENDPOINT=wss://your-rpc-endpoint
COLDKEY_ADDRESS=your-coldkey-ss58-address
PROXY_MNEMONIC=your proxy account mnemonic phrase
# Optional fallback only: used when dynamic yield-based validator selection fails
VALIDATOR_HOTKEY=your-validator-hotkey-ss58-address
SN45_API_KEY=your-sn45-api-key
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Environment variables are for secrets and connection strings only. Tunable parameters (slippage buffers, thresholds, strategy settings) live in `src/config.yaml`.

## Local Development

```bash
bun install
bun rebalance            # run rebalance once
bun rebalance --dry-run  # simulate without submitting transactions
```

## Docker

The container runs the rebalancer every 5 minutes via cron.

### Start

```bash
docker compose up -d --build
```

### Stop

```bash
docker compose down
```

### View logs

```bash
# Container status & health
docker ps

# Rebalance execution logs (persisted on host)
ls logs/
cat logs/rebalance-*.log
```

### Rebuild after code changes

```bash
docker compose up -d --build
```

Log files older than 7 days are automatically cleaned up.

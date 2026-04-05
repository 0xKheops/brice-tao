# brice-tao

Automated portfolio rebalancer for [Bittensor](https://bittensor.com/) subnets. Monitors subnet performance, selects optimal allocation targets via pluggable strategies, and executes on-chain staking operations through a proxy account — with MEV protection, slippage simulation, and Discord notifications.

## Strategies

The bot ships with three strategies. Select one with `--strategy <name>` or the `STRATEGY` env var (defaults to `root-emission`).

| | root-emission | copy-trade | sma-stoploss |
|---|---|---|---|
| **Approach** | Fixed % to root (SN0), rest to best emission-yield subnet | Mirror a leader wallet's portfolio proportions | SMA crossover momentum + emission yield scoring |
| **Scheduling** | Cron (every 12 h) | Event-driven (leader staking events) | Cron (every 4 h) |
| **# Slots** | 2 (root + alpha) | Dynamic (matches leader) | 3 fixed (33% each, unfilled → SN0) |
| **Risk management** | Simple (fixed root allocation) | Follows leader | Fixed % trailing stop-loss |
| **State** | Stateless | Stateless | Persistent (SQLite price history) |
| **Complexity** | Low | Low | Medium |
| **Best for** | Small portfolios, passive yield | Tracking an expert allocator | Trend-following with downside protection |

Each strategy has its own `config.yaml` with tunable parameters — see `src/strategies/<name>/config.yaml`.

> **Want to build your own?** See the [Custom Strategies Guide](docs/custom-strategies.md).

## Prerequisites

- [Bun](https://bun.sh) (for local development)
- [Docker](https://docs.docker.com/get-docker/) (for containerized deployment)
- Two Bittensor wallets: a **main wallet** that holds your funds, and a separate **bot wallet** used only to sign staking transactions.

### Why use a staking proxy?

Think of this as separating your **funds wallet** from your **automation wallet**. Your main wallet holds your TAO and stake. The bot wallet is only there to sign staking transactions for the bot. In Bittensor terms, the main wallet is the **coldkey**, and the bot wallet is the **staking proxy**.

This is safer because the bot only needs the secret phrase of the bot wallet. Your main wallet's secret phrase never has to live on your laptop, server, or container. The bot only needs the public address of the main wallet (`COLDKEY_ADDRESS`). Because the bot wallet phrase is shared with the bot, treat it as a higher-risk wallet and keep only a small amount of TAO on it for transaction fees.

### Set up the staking proxy

1. In [Talisman](https://www.talisman.xyz/), create a brand new account using a **newly generated mnemonic**. This mnemonic will be provided to the bot so do not create any other accounts from it, and never use this mnemonic for anything else. This will be your proxy account.
2. Open [dev.papi.how](https://dev.papi.how), connect to the bittensor chain (provide the rpc url) then from the Extrinsics tab submit a `Proxy -> addProxy` with the **Proxy Account** address as the delegate, `Staking` as the proxy type, and `0` delay. Sign this transaction using your **Main Account**. ![Create staking proxy](./docs/create-staking-proxy.png)
3. In the bot config, set `COLDKEY_ADDRESS` to the public address of your main account, and set `PROXY_MNEMONIC` to the secret phrase of the proxy account. Do **not** put your main account secret phrase in the bot config.

## Configuration

### Environment variables

Set the following in your environment or `.env` file (see `.env.example`):

| Variable | Required | Description |
|----------|----------|-------------|
| `WS_ENDPOINT` | ✅ | RPC WebSocket endpoints (comma-separated for failover) |
| `COLDKEY_ADDRESS` | ✅ | Your coldkey SS58 address |
| `PROXY_MNEMONIC` | ✅ | Proxy account mnemonic (12 or 24 words) |
| `DISCORD_WEBHOOK_URL` | | Discord webhook for notifications (silent if unset) |
| `VALIDATOR_HOTKEY` | | Fallback validator when yield-based selection fails |
| `STRATEGY` | | Active strategy (default: `root-emission`) |
| `LEADER_ADDRESS` | | Leader coldkey to mirror (copy-trade strategy only) |
| `ARCHIVE_WS_ENDPOINT` | | Archive node for price history warmup (sma-stoploss) |

### Strategy config

Environment variables are for secrets and connection strings only. Tunable parameters (slippage buffers, scoring weights, thresholds) live in each strategy's `config.yaml`:

- [`src/strategies/root-emission/config.yaml`](src/strategies/root-emission/config.yaml)
- [`src/strategies/copy-trade/config.yaml`](src/strategies/copy-trade/config.yaml)
- [`src/strategies/sma-stoploss/config.yaml`](src/strategies/sma-stoploss/config.yaml)

### Discord notifications (optional)

The bot can send real-time alerts to a Discord channel — rebalance results, errors, and proxy balance warnings.

<details>
<summary>Example notification</summary>

<img src="docs/discord-notification.png" width="400" alt="Discord rebalance notification showing portfolio value, operations, balances, and transaction link" />

</details>

To set it up:

1. Open your Discord server → **Server Settings** → **Integrations** → **Webhooks**
2. Click **New Webhook**, pick a channel, and optionally set a name/avatar
3. Click **Copy Webhook URL**
4. Set the `DISCORD_WEBHOOK_URL` environment variable to the copied URL

If not configured, the bot runs silently (terminal + file logs only).

## Quick Start

```bash
bun install
bun rebalance                                     # one-shot rebalance (default: root-emission)
bun rebalance -- --strategy copy-trade --dry-run   # dry run a specific strategy
bun preview   -- --strategy root-emission          # preview with audit report
bun scheduler                                      # long-running scheduler
bun scheduler -- --strategy sma-stoploss             # scheduler with specific strategy
bun bunker                                          # emergency exit: move all positions to SN0
bun bunker    -- --dry-run                          # preview bunker operations without executing
```

### `bun preview` vs `bun rebalance --dry-run`

These commands serve different purposes:

| | `bun preview` | `bun rebalance --dry-run` |
|---|---|---|
| **Purpose** | "Show me the plan" — quick, read-only analysis | "Rehearse the deployment" — full pipeline validation |
| **Requires secrets?** | No (`WS_ENDPOINT` + `COLDKEY_ADDRESS` only) | Yes (all production env vars including `PROXY_MNEMONIC`) |
| **Output** | Terminal audit tables + `reports/preview-*.md` | Terminal logs + decoded extrinsic JSON + log file |
| **Validates** | Strategy logic, allocation math, operation planning | Everything above + signer, proxy, MEV shield, slippage simulation |
| **Safe to share?** | Yes — no secrets needed or exposed | No — requires full production credentials |
```

## Docker

The container runs a long-lived scheduler process. Strategy configs are baked into the image at build time — rebuild after editing `config.yaml`. The `.env` file is mounted at runtime.

```bash
docker compose up -d --build     # start (or rebuild after changes)
docker compose down              # stop
docker ps                        # check status
cat logs/rebalance-*.log         # view execution logs (persisted on host)
```

Set `TZ` in your environment to control the container timezone (defaults to UTC):

```bash
TZ=America/New_York docker compose up -d --build
```

## Architecture

The rebalance pipeline:

```
Fetch Balances → Strategy Targets → Compute Operations → Simulate Slippage → MEV Shield → Execute → Verify → Notify
```

See [docs/architecture.md](docs/architecture.md) for the full system design.

### Key concepts

- **TAO/Alpha** — TAO is the base token (1 TAO = 10⁹ RAO). Alpha is a per-subnet staking token; staking TAO converts it via an AMM pool.
- **MEV Shield** — Transactions are encrypted (XChaCha20-Poly1305 + ML-KEM-768) before submission to prevent frontrunning.
- **Price limits** — U64F64 fixed-point values protecting swaps against slippage, computed via on-chain simulation.
- **Proxy account** — The bot signs with a staking-only proxy, never the coldkey. Limits blast radius.

## CI

All pushes and PRs to `main` are checked via GitHub Actions: lint, type-check, tests, and dead-code detection.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for code style, quality gates, and PR process.

## Why "brice-tao"?

The name is a nod to [**Brice de Nice**](https://en.wikipedia.org/wiki/Brice_de_Nice), a cult French comedy character created by Jean Dujardin (of *The Artist* fame). Brice is an arrogant yet loveable surfer who spends every day on the waveless shores of Nice, surfboard in hand, waiting for the perfect wave that will never come. His catchphrase — *"Je t'ai cassé !"* ("I broke you!") — and his iconic yellow wetsuit made him a pop-culture phenomenon in France after the 2005 hit film.

**brice-tao** = **Brice** 🏄 + **TAO** ⛓️ — like Brice patiently scanning the Mediterranean horizon for the next big wave, this bot watches the Bittensor network for the best subnets to ride.

## License

[MIT](LICENSE)

## Resources

- [Video walkthrough](https://www.youtube.com/watch?v=jBHYiRT_Zz0) — Overview of the rebalancer concept and setup
- [Architecture](docs/architecture.md) — System design and data flow
- [Custom Strategies](docs/custom-strategies.md) — Guide to building your own strategy
- [Bittensor docs](https://docs.bittensor.com/) — Bittensor network documentation

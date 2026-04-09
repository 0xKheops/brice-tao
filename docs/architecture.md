# Architecture

Automated Bittensor portfolio rebalancer that monitors subnet performance, selects optimal allocation targets via a pluggable strategy system, and executes on-chain staking operations through a proxy account.

## Project Layout

```
scripts/
  entrypoint.sh           → Docker entrypoint (sources .env → exec /app/scheduler)
  show-balances.ts        → Portfolio balance viewer
  preview-rebalance.ts   → Strategy-agnostic preview shell (audit report + planned operations)
  backfill-history.ts    → History DB backfill from archive nodes
  backtest.ts            → Strategy backtester with AMM simulation
  bunker.ts              → Emergency exit script (move everything to SN0)
src/
  main.ts                 → One-shot CLI entrypoint
  scheduler.ts            → Long-running scheduler (signal handling + graceful shutdown)
  errors.ts               → Custom error classes
  version.ts              → Git commit hash resolution (env var or git CLI)
  accounts/
    deriveSigner.ts       → Mnemonic → signer + SS58 address derivation
  api/
    createClient.ts       → PAPI WebSocket client + metadata caching
    fetchSubnetNames.ts   → On-chain subnet name lookups
    rpcThrottle.ts        → RPC block-lookup helpers
    suppressRpcNoise.ts   → RPC log noise suppression
  config/
    env.ts                → Environment variable validation
  balances/
    getBalances.ts        → TAO/Alpha balance queries
  validators/
    pickBestValidator.ts  → Yield-based validator selection per subnet
    resolveValidators.ts  → Validator hotkey resolution (existing position reuse + yield pick + fallback)
  history/
    constants.ts          → Block-interval constant (DB_HISTORY_BLOCK_INTERVAL), grid helpers
    db.ts                 → SQLite database wrapper (open, record, query)
    fetch.ts              → On-chain snapshot fetcher (subnet data at a given block)
    index.ts              → Barrel exports + convenience aliases
    record.ts             → Live recording (recordCurrentBlock — grid-aligned snapshots)
    schema.ts             → SQLite schema (blocks, subnets, cycles, trades)
    types.ts              → History domain types (BlockMeta, SubnetSnapshot, etc.)
  scheduling/
    types.ts              → StrategyRunner, RunnerContext, CreateRunnerFn
    blockInterval.ts      → Block-interval runner (fires on modulo-aligned finalized blocks)
    cron.ts               → Cron runner with overlap protection + stale timeout
    once.ts               → One-shot runner for CLI
    context.ts            → Shared context factory
  strategies/
    types.ts              → Strategy contract (StrategyFn, StrategyModule, StrategyResult, backtest types)
    loader.ts             → Strategy registry + CLI arg parsing
    root-emission/        → Simple root + best-emission strategy (cron-based)
    copy-trade/           → Mirror a leader's portfolio (event-driven)
    sma-stoploss/         → SMA crossover momentum + trailing stop-loss (block-interval)
  notifications/
    discord.ts            → Discord webhook notifications
  rebalance/
    types.ts              → Domain types (RebalanceConfig, Operation variants, Plan, Results)
    cycle.ts              → Rebalance cycle pipeline (shared by scheduler + CLI)
    tao.ts                → TAO constant (1 TAO = 1e9 RAO) + helpers
    computeRebalance.ts   → Operation generation from strategy targets + balances
    executeRebalancePlan.ts → Plan executor: MEV check → simulate → submit → verify
    executeRebalance.ts   → Batch build, dual extrinsic paths, MEV-shielded submission
    simulateSlippage.ts   → Runtime API swap simulation → price limits
    mevShield.ts          → XChaCha20-Poly1305 + ML-KEM-768 encryption
    waitForBatch.ts       → Block scanning, event extraction
    proxyEvents.ts        → Proxy event decoding for batch results
    tradeRecorder.ts      → Trade history recording to the history DB
    amm.ts                → Constant-product AMM math for backtesting
    constants.ts          → Shared constants (re-exports TAO)
    logger.ts             → Dual logger: terminal + JSON file
```

## Data Flow

The rebalance pipeline runs as a single cycle, either on a cron schedule or as a one-shot CLI invocation:

```
Fetch Balances → Compute Targets → Compute Operations → Simulate Slippage → MEV Shield → Execute → Verify → Notify
```

1. **Fetch balances** — query on-chain TAO and Alpha balances for the coldkey.
2. **Compute targets** — the active strategy scores subnets and returns allocation targets (`netuid` + `hotkey` + `share`).
3. **Compute operations** — diff current positions against targets to generate add/remove/move operations.
4. **Simulate slippage** — use the runtime API to estimate swap outcomes and compute price limits.
5. **MEV Shield** — encrypt the batch extrinsic (XChaCha20-Poly1305 + ML-KEM-768) to prevent frontrunning. Falls back to limit-price extrinsics when unavailable.
6. **Execute** — build a batch extrinsic and submit to the chain.
7. **Verify** — scan blocks for batch events, fetch post-balances, and compare against expectations.
8. **Notify** — send results to a Discord webhook.

## Key Design Decisions

### Proxy Account

The bot signs transactions with a proxy account, not the coldkey directly. This limits blast radius — the proxy can only submit staking transactions, not transfer funds.

### MEV Shield

Transactions are encrypted using XChaCha20-Poly1305 + ML-KEM-768 before submission to prevent frontrunning. When MEV Shield is unavailable (`NextKey=null`), the bot falls back to limit-price extrinsics.

### Strategy Isolation

Each strategy is self-contained in its own subfolder with its own config, types, and logic. Strategies share no code with each other. The rebalance pipeline is strategy-agnostic — it executes whatever targets the strategy returns.

### Static Strategy Registry

Strategies are statically imported (not dynamically loaded) to support Bun's binary compilation. Adding a new strategy requires registering it in `src/strategies/loader.ts`.

## Strategy System

The bot supports three strategies, each in `src/strategies/<name>/`:

| Strategy | Scheduling | Description |
|---|---|---|
| `root-emission` | Cron | Allocates to root subnet plus the highest-emission subnets |
| `copy-trade` | Event-driven | Mirrors a leader address's portfolio in real time |
| `sma-stoploss` | Block-interval | SMA crossover momentum with fixed trailing stop-loss |

### Strategy Contract

Every strategy exports a `StrategyModule` with two functions:

- **`getStrategyTargets(client, env, balances)`** — computes allocation targets (used by the rebalance pipeline and preview).
- **`createRunner(context)`** — creates a `StrategyRunner` that owns the scheduling lifecycle (`start()` / `stop()`).

### Strategy Resolution

The active strategy is selected at runtime: `--strategy` CLI flag takes priority over the `STRATEGY` environment variable. If neither is set, the bot defaults to `root-emission`.

## Key Concepts

### TAO and Alpha

- **TAO** is the base token of Bittensor (1 TAO = 1,000,000,000 RAO).
- **Alpha** is a per-subnet staking token; staking TAO into a subnet converts it to Alpha via an AMM pool.
- All internal amounts are in RAO (`bigint`) for precision.

### Subnets

Bittensor subnets are independent networks that perform specific AI tasks. Each has its own token (Alpha), validators, and emission rewards.

### Price Limits

U64F64 fixed-point values that protect swaps against slippage. The bot simulates swaps before execution to compute appropriate limits.

### Operations

The rebalance pipeline generates five types of operations:

- **`swap`** — move stake directly between subnets via AMM (cross-subnet swap).
- **`unstake`** — fully unstake a position from a subnet back to free TAO.
- **`unstake_partial`** — partially unstake from a subnet (reduce overweight position).
- **`stake`** — stake free TAO into a subnet.
- **`move`** — reassign stake to a different validator hotkey within the same subnet.

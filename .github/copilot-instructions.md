# Copilot Instructions — brice-tao

Automated Bittensor portfolio rebalancer: monitors subnet holdings, computes allocation targets via pluggable strategies, simulates slippage, batches operations through MEV shield, and reports results to Discord.

## Package Manager

Use **Bun** for everything. Do not use npm, pnpm, or yarn. Lockfile is `bun.lock`.

## Commands

| Action | Command |
|--------|---------|
| Install deps | `bun install` |
| One-shot rebalance | `bun rebalance -- --strategy <name>` |
| Dry run | `bun rebalance -- --strategy <name> --dry-run` |
| Preview (read-only) | `bun preview -- --strategy <name>` |
| Scheduler | `bun scheduler -- --strategy <name>` |
| List strategies | `bun rebalance -- --list-strategies` |
| Emergency exit (SN0) | `bun bunker` (dry run: `bun bunker -- --dry-run`) |
| Backfill history DB | `bun backfill -- --days 30` |
| Lint / format | `bun check` (fix: `bun check --fix --unsafe`) |
| Type-check | `bun typecheck` |
| Dead code | `bun knip` |
| Tests | `bun test` |

## Code Conventions

- No semicolons, double quotes, tab indentation (Biome)
- Named + type imports with `.ts` extension (`import { foo } from "./bar.ts"`)
- No default exports — always named exports
- `Promise.all()` for parallel calls; top-level `await` in scripts
- All amounts in RAO (`bigint`) — use `TAO` constant from `src/rebalance/tao.ts`
- Union types for operation kinds, interfaces for domain models — see `src/rebalance/types.ts`
- Custom error classes from `src/errors.ts` — use typed catch blocks
- Dual logger (terminal + JSON file) in `src/rebalance/logger.ts`: `info`, `verbose`, `warn`, `error` — every JSON entry includes the git commit hash from `src/version.ts`
- Tests co-located with source files (e.g., `foo.test.ts` next to `foo.ts`)

## Key Entrypoints

- `src/main.ts` — one-shot CLI; `src/scheduler.ts` — long-running scheduler
- `src/strategies/types.ts` — strategy contract (`StrategyFn`, `StrategyModule`, `StrategyResult`)
- `src/strategies/loader.ts` — strategy registry + CLI arg parsing
- `src/rebalance/` — shared pipeline (compute, execute, slippage, MEV shield)
- `src/history/` — shared history database (`data/history.sqlite`) — records finalized block + subnet data on a 25-block grid (~5 min) for all strategies (future backtesting)
- `src/scheduling/` — block-interval runner, one-shot runner, shared context
- `src/config/env.ts` — environment variable validation
- `src/validators/` — shared default validator selection (yield-based)

## Strategy System

- Each strategy is a self-contained folder under `src/strategies/<name>/` with `index.ts`, `runner.ts`, `config.yaml`
- Strategies export a `StrategyModule` (`getStrategyTargets` + `createRunner`) — see `src/strategies/types.ts`
- Strategies must be **statically imported** and registered in `src/strategies/loader.ts` (dynamic `import()` breaks Bun-compiled binaries)
- Strategy folders are self-contained — do not import from other strategy folders. Shared infra (`src/validators/`, `src/rebalance/`, `src/scheduling/`) is fine.
- Each strategy owns its config, scoring, scheduling, and audit rendering
- See `docs/custom-strategies.md` for the full guide

## Environment Variables

| Variable | Description |
|----------|-------------|
| `WS_ENDPOINT` | RPC WebSocket endpoints (comma-separated for failover) |
| `COLDKEY_ADDRESS` | SS58 coldkey address |
| `PROXY_MNEMONIC` | Proxy account mnemonic (transaction signer) |
| `VALIDATOR_HOTKEY` | Optional fallback hotkey for validator selection |
| `DISCORD_WEBHOOK_URL` | Discord webhook (optional — silent if unset) |
| `STRATEGY` | Active strategy name (overridden by `--strategy` flag) |
| `ARCHIVE_WS_ENDPOINT` | Optional archive node endpoints for indicator warmup |
| `GIT_COMMIT` | Git commit hash embedded in log entries (auto-detected locally; baked in via Docker build arg) |

No `.env` file in repo — variables set externally (Docker mounts `.env`).

## Domain Concepts

- **TAO/Alpha**: TAO is the base token (1 TAO = 1e9 RAO). Alpha is per-subnet staking token.
- **Price limits**: U64F64 fixed-point values protecting swaps against slippage. The runtime's `get_max_amount_move` is broken for swap v3 subnets.
- **MEV Shield**: XChaCha20-Poly1305 + ML-KEM-768 encrypted batches. Falls back to limit-price extrinsics when unavailable (NextKey=null).
- **`enforceSlippage`**: when `false` (default), uses simple extrinsics when MEV Shield is active (lower fees). When `true`, always uses limit-price extrinsics.

## Pitfalls

- All amounts are RAO (`bigint`) — always use `TAO` constant for conversions
- Price limits are U64F64 fixed-point
- The rebalancer signs with a proxy account, never the coldkey
- RPC rate limits are enforced server-side — calls will throw if the limit is hit
- Each strategy's `config.yaml` is required — fail-fast if missing

## History Database — 25-Block Grid

The shared history DB (`data/history.sqlite`) records on-chain subnet snapshots on a fixed **25-block grid** (~5 min per sample, since Bittensor produces 1 block every ~12 s). This keeps disk usage manageable for long-term backtesting while providing sufficient resolution.

**Invariant:** every `block_number` in the DB satisfies `block_number % 25 === 0`. Enforced at:
1. Code level — `recordCurrentBlock()` calls `isGridBlock()` and skips non-grid blocks
2. Schema level — `CHECK(block_number % 25 = 0)` on the `blocks` table

**Rules for backfill / backtest scripts:**
- Iterate in steps of `BLOCK_INTERVAL` (25): `for (let b = snapToGrid(start); b <= end; b += BLOCK_INTERVAL)`
- Use `snapToGrid()` and `isGridBlock()` from `src/history/constants.ts` — never hardcode `25`
- Only query archive nodes at grid-aligned block numbers
- The `recordCurrentBlock()` function in `src/history/record.ts` is the only way to populate the DB during live operation; backfill scripts may use `db.recordSnapshot()` directly but must pre-validate block numbers

## Strategy Scheduling

Strategies can use different scheduling mechanisms. The `StrategyRunner` interface is generic (`start()`/`stop()`), and three concrete runner types exist:

1. **Cron-based** (`src/scheduling/cron.ts`) — UTC cron expression via `croner`. Used by `root-emission`.
2. **Block-interval** (`src/scheduling/blockInterval.ts`) — fires on `blockNumber % intervalBlocks === 0`. Used by `sma-stoploss`.
3. **Event-driven** — custom runner subscribing to on-chain events. Used by `copy-trade`.

**Key constants** (from `src/history/constants.ts`):
- `SECONDS_PER_BLOCK = 12` — Bittensor block time
- `BLOCK_INTERVAL = 25` — history DB grid (25 blocks ≈ 5 min)

**Rules for block-interval strategies:**
- `rebalanceIntervalBlocks` must be a **multiple of `BLOCK_INTERVAL` (25)** — enforced at runtime by `createBlockIntervalRunner`
- Config files use `rebalanceIntervalBlocks` and `staleTimeoutBlocks`

**Rules for cron strategies:**
- Cron expressions are always evaluated in **UTC** (both live and backtest)
- Config files use `cronSchedule` and `staleTimeoutMinutes`

**Rules for event-driven strategies:**
- Config files use `staleTimeoutMinutes` for cycle timeout
- Event-driven strategies are not currently backtestable

## Backtesting

The backtest script (`scripts/backtest.ts`) supports both scheduling types:

- **Block-interval**: pure modulo check (`blockNumber % intervalBlocks === 0`)
- **Cron**: evaluates cron expressions in UTC against historical block timestamps. Uses a persistent `nextScheduledAt` and triggers on the first snapshot at-or-after the scheduled time.

Schedule is auto-detected from the strategy's `getBacktestSchedule()` hook. CLI overrides: `--interval-blocks <n>` or `--cron "<expr>"`.

### Backtesting Limitations

Trade simulation uses **constant-product AMM math** (x·y=k) with pool reserves from the history DB, accounting for price impact from pool liquidity depth. SN0 (root network) trades at 1:1 with zero fees. Known limitations:

- **No emission accrual**: backtests do NOT model staking emission rewards. Real returns will differ from backtest returns because emission yield is a significant component of Bittensor staking returns.
- **Fee model**: pool fee of 33/65535 ≈ 0.05% on input (matches on-chain default) + fixed transaction fee (`TX_FEE_RAO`). SN0 trades are free. Sell→buy rotations charge **one** pool fee (on the sell leg), matching on-chain `swap_stake` behavior. Buys from pre-existing free balance charge a separate fee (`add_stake` model).
- **Constant-product approximation**: accurate for V2 pools and V3 pools with only the protocol's full-range position. Does not model concentrated liquidity from user LP positions (currently disabled on-chain).
- **No validator rewards/take**: validator commission is not modeled.

When interpreting backtest results, treat them as a relative comparison tool between strategies rather than an absolute return prediction.

## Quality Gates

Run after every change:
- `bun check --fix` (lint)
- `bun typecheck` (types)
- `bun knip` (dead code)
- `bun test` (tests)

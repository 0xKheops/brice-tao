# SMA Crossover + Stop-Loss Strategy

Block-interval momentum strategy using Simple Moving Average crossover with a fixed-percentage trailing stop-loss for Bittensor alpha token trading.

## Overview

This strategy combines:
- **SMA crossover momentum** — fast SMA(6) crossing above slow SMA(14) signals bullish momentum
- **Emission yield scoring** — annualized emission yield as a secondary quality signal
- **Fixed-percentage trailing stop-loss** — exits positions that drop more than 15% from their peak
- **SQLite persistence** — price history and stop-loss state survive restarts
- **Archive node warmup** — optional instant history from an archive node on cold start

## Portfolio Allocation

The portfolio is split into at most **3 equal slots** (33% each):
- Eligible subnets fill slots based on their blended score ranking
- Unfilled slots are parked in **SN0** (root subnet) as a safe harbor
- Example: 2 winners → `[SN_a=33%, SN_b=33%, SN0=34%]`

## SMA Crossover Indicator

The [Simple Moving Average](https://en.wikipedia.org/wiki/Moving_average#Simple_moving_average) is computed from price samples taken at each block-interval tick (every 1200 blocks / ~4 hours by default).

- **Fast SMA** (period 6): average of the 6 most recent price samples
- **Slow SMA** (period 14): average of the 14 most recent price samples
- **Bullish signal**: fast SMA > slow SMA (the "golden cross")
- **Momentum strength**: `(fastSMA - slowSMA) / slowSMA` — how far above the crossover

### Cold Start

Until enough price samples accumulate for the slow SMA (14 ticks × 1200 blocks = ~2.8 days), the strategy will not select any subnets and parks 100% in SN0. With archive node warmup configured, this cold start period is eliminated.

## Scoring Engine

Two-component blended score (weights configurable, must sum to 100%):

| Component | Default Weight | Formula |
|-----------|---------------|---------|
| Momentum (SMA) | 60% | SMA crossover strength, normalized across qualifying subnets |
| Emission Yield | 40% | `taoInEmission × blocksPerYear / marketCap`, normalized |

### Gates (all must pass)
- **Depth**: `taoIn > minTaoIn` (minimum AMM pool liquidity)
- **Age**: subnet age ≥ `minSubnetAgeDays`
- **Health**: not immune, not prune target
- **SMA Data**: enough samples to compute slow SMA
- **SMA Crossover**: fast SMA > slow SMA (bullish)
- **Cooldown**: not recently stopped-out (within `cooldownBlocks`)

### Incumbency Bonus
Held subnets receive an additive score bonus to reduce unnecessary churn.

## Stop-Loss Mechanics

### Fixed Percentage Trailing Stop
- When a position is entered, the current spot price becomes the **high-water mark** (HWM)
- **Stop price** = `HWM × (1 - stopLossPercent / 100)` (e.g., 15% below)
- HWM **ratchets up** — when price rises above HWM, the stop price rises too
- If price falls below stop price → position is **stopped out**

### Cooldown
After a stop triggers, the subnet enters a cooldown period (`cooldownBlocks`, default ~18h). During cooldown, the subnet is excluded from scoring and cannot be re-entered.

### 4-Hour Check Interval (Caveat)
Since this is a block-interval strategy (not always-online), stop-losses are only checked every 1200 blocks (~4 hours). Price can gap far below the stop or dip and recover between ticks. This is a deliberate simplification — for real-time protection, see the always-online architecture pattern used by more advanced strategies.

## Database Schema

SQLite database at `data/sma-stoploss.sqlite` (WAL mode):

| Table | Purpose | Columns |
|-------|---------|---------|
| `price_samples` | SMA computation | netuid, block_number, price (I96F32 as TEXT) |
| `stop_losses` | Trailing stop state | netuid, high_water_mark, stop_price |
| `stopped_out` | Cooldown tracking | netuid, triggered_at_block, exit_price |

Old price samples are evicted to keep at most `maxPriceSamples` per subnet.

## Archive Node Warmup

On startup, if `ARCHIVE_WS_ENDPOINT` is set and the DB is empty:
1. Create a temporary PAPI client to the archive node
2. Fetch historical spot prices via `current_alpha_price_all()` at ~1200-block intervals (matching `rebalanceIntervalBlocks`)
3. Insert into DB — SMA is immediately usable after warmup
4. Graceful fallback: if archive is unavailable, start with cold indicators

## Architecture

### Runner Owns State, Strategy is Read-Only

The runner handles all mutable state (DB writes, stop-loss updates). The strategy function (`getStrategyTargets`) only reads shared state, making it safe for dry-run/preview/simulation flows.

### Tick Order
1. Fetch on-chain subnet data (with accurate spot prices)
2. Insert current price samples → DB
3. Expire old cooldowns (block-based)
4. Update stop-losses: ratchet HWM, detect triggers → mark stopped-out
5. Update shared state snapshot for `getStrategyTargets`
6. Run rebalance cycle (calls `getStrategyTargets` read-only)
7. Post-rebalance: refresh stop-losses for new/exited positions

## Configuration

All parameters are in `config.yaml`. See the file for detailed comments.

Key sections:
- `rebalance`: standard rebalance engine parameters (min position, reserves, slippage)
- `strategy`: SMA periods, scoring weights, stop-loss params, allocation slots

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ARCHIVE_WS_ENDPOINT` | No | Comma-separated archive node WebSocket endpoints for warmup |

## Files

| File | Purpose |
|------|---------|
| `index.ts` | `getStrategyTargets()` — read-only scoring + allocation + audit |
| `runner.ts` | Block-interval runner: startup warmup, per-tick state updates, DB lifecycle |
| `config.yaml` / `config.ts` | Configuration and validation |
| `types.ts` | Strategy-specific type definitions |
| `db.ts` | SQLite price database (bun:sqlite, WAL mode) |
| `scoreSubnets.ts` | SMA computation + blended scoring engine |
| `warmup.ts` | Archive node historical data warmup |
| `fetchSubnetData.ts` | On-chain subnet data fetching |

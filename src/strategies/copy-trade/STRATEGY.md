# Copy-Trade Strategy

Mirror the on-chain portfolio of a **leader** wallet. Instead of scoring subnets independently, this strategy reads the leader's staking positions and rebalances the follower to match the same proportional allocation.

## How It Works

1. **Read leader portfolio** — query all `StakeInfo` entries for the leader's coldkey address
2. **Aggregate by subnet** — the leader may stake to multiple validators on the same subnet; positions are summed per-subnet to compute a single TAO value
3. **Compute shares** — each subnet's share = its aggregated TAO value ÷ leader's total staked TAO (free TAO is ignored)
4. **Dust filter** — if a subnet's share × follower's total portfolio < `minPositionTao`, the position is too small to replicate and gets dropped
5. **Re-normalize** — remaining shares are scaled back to sum to 100%
6. **Resolve validators** — for each target subnet, reuse the follower's largest existing validator; otherwise pick the highest-yield validator on-chain; fall back to `VALIDATOR_HOTKEY` env var if set
7. **Re-normalize again** — if any subnets were skipped during validator resolution, shares are re-normalized a second time
8. **Execute** — the standard rebalance pipeline computes operations (add/remove/move stake) and submits them through the MEV shield

### Fallback Behavior

| Scenario | Action |
| --- | --- |
| Leader has no staked positions (only free TAO) | Allocate 100% to SN0 |
| All leader positions filtered as dust | Allocate 100% to SN0 (unwinds stale positions) |
| No positions remain after filtering | Return empty targets (no-op cycle) |

## Event-Driven Runner

Unlike cron-based strategies, `copy-trade` reacts to on-chain events in real time.

### Trigger Mechanism

The runner subscribes to `client.finalizedBlock$` (an RxJS Observable from polkadot-api) and scans each finalized block's events for staking activity involving the leader address.

**Watched event types:**

| Event | Emitted by |
| --- | --- |
| `StakeAdded` | `add_stake`, and internally by `move_stake` / `swap_stake` |
| `StakeRemoved` | `remove_stake`, and internally by `move_stake` / `swap_stake` |
| `StakeMoved` | `move_stake` (separate event in addition to Added/Removed) |
| `StakeSwapped` | `swap_stake` |
| `StakeTransferred` | `transfer_stake` (has **two** coldkeys — origin at index 0, destination at index 1; both are checked) |

The full set is matched defensively — `StakeAdded` + `StakeRemoved` alone would catch most operations since `move_stake` emits both, but including `StakeMoved`, `StakeSwapped`, and `StakeTransferred` explicitly covers future edge cases.

### Block-Level Deduplication

Multiple leader events in the same block trigger only **one** rebalance cycle. The runner checks all events per block and fires a single trigger if any match.

### Overlap Protection

```
┌──────────────────────────────────────────────────────────────┐
│  Block N arrives → leader event detected                     │
│  → inflightRun = run()                                       │
│                                                              │
│  Block N+3 arrives → leader event detected                   │
│  → inflightRun is non-null → set pendingRerun = true         │
│                                                              │
│  Run completes → finally block checks pendingRerun           │
│  → pendingRerun is true → start new run immediately          │
│                                                              │
│  Block N+7 arrives → no leader events → skip                 │
└──────────────────────────────────────────────────────────────┘
```

- At most **one** rebalance cycle runs at a time (`inflightRun` promise)
- Events arriving during an in-flight cycle set a `pendingRerun` boolean flag
- When the cycle finishes, if `pendingRerun` is set, a new cycle starts immediately
- Since `pendingRerun` is a boolean (not a counter), bursts of events coalesce into a single rerun

### Startup Sequence

1. `start()` fires the initial sync (`inflightRun = run()`) **before** subscribing
2. This ensures the subscriber always sees `inflightRun` as non-null during startup, preventing a race where an early block could start a concurrent cycle
3. `start()` returns **immediately** (does not await the initial sync) so the scheduler can install SIGTERM/SIGINT handlers without delay
4. The initial sync runs in the background; `stop()` awaits it if needed

### Graceful Shutdown

1. `stop()` sets a `stopped` flag, unsubscribes from the block observable, and awaits any in-flight run
2. The `stopped` flag is checked at multiple async boundaries in the subscriber (before and after `Events.getValue()`) to prevent post-stop work

### Error Handling

- Individual cycle errors are caught and logged; the subscription continues
- Block subscription errors (`error` callback) are fatal — the process exits with code 1, relying on Docker's restart policy for reconnection

## Configuration

All settings live in `config.yaml`:

```yaml
staleTimeoutMinutes: 10    # Warn if a cycle exceeds 10 minutes

rebalance:
  minPositionTao: 0.5      # Drop leader subnets where follower allocation < this
  freeReserveTao: 0.1      # Keep this much free TAO (not staked)
  freeReserveTaoDriftPercent: 5
  minOperationTao: 0.01    # Minimum size for a single operation
  minStakeTao: 0.01        # Minimum stake per position
  minRebalanceTao: 0.1     # Skip cycle if total rebalance amount < this
  slippageBufferPercent: 2  # Slippage tolerance for swap simulations
  enforceSlippage: false    # When false, use simple extrinsics under MEV shield

strategy:
  leaderAddress: ""         # SS58 address of the wallet to copy
```

### Leader Address Resolution

Priority: `LEADER_ADDRESS` environment variable → `strategy.leaderAddress` in config.yaml → error.

Empty or whitespace-only env values are ignored (they don't override a valid config value).

## Running

```bash
# Live rebalance (reacts to leader events)
bun rebalance -- --strategy copy-trade

# Dry run (computes plan without submitting)
bun rebalance -- --strategy copy-trade --dry-run

# Simulate (point-in-time snapshot, no execution)
bun preview -- --strategy copy-trade
```

The `LEADER_ADDRESS` environment variable must be set (or `strategy.leaderAddress` filled in `config.yaml`).

## File Layout

```
src/strategies/copy-trade/
  STRATEGY.md             ← this file
  config.yaml             ← tunable parameters
  config.ts               ← YAML loader + validation + env override
  types.ts                ← RawCopyTradeConfig + CopyTradeConfig interfaces
  index.ts                ← getStrategyTargets (share computation + audit)
  runner.ts               ← Event-driven runner (block subscription + overlap protection)
  getLeaderShares.ts      ← Leader portfolio analysis, aggregation, dust filtering
  config.test.ts          ← Config loading + validation tests
  getLeaderShares.test.ts ← Share computation tests

# Shared infrastructure (used by all strategies):
src/validators/
  resolveValidators.ts    ← Validator hotkey resolution (reuse → yield-pick → fallback)
  pickBestValidator.ts    ← On-chain yield-based validator selection
```

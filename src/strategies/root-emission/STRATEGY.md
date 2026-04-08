# Root + Best Emission Strategy

## Overview

This is the most **conservative** strategy in the system. It maintains a **fixed split** between the root subnet (SN 0) and the single best emission-yield subnet, using only on-chain data.

The core idea: allocate the majority of the portfolio to root (stable, diversified exposure to the entire Bittensor network) and a minority to the highest-yielding alpha subnet (concentrated upside).

### How it works (step by step)

1. **Fetch on-chain subnet data** — queries all subnets' dynamic info (pool depths, emission, age, health)
2. **Apply 4 quality gates** — pool depth, health, age, and mcap > 0
3. **Compute emission yield** — `taoInEmission × BLOCKS_PER_YEAR / marketCap` for each qualifying subnet (annualized)
4. **Apply incumbency bonus** — held subnets get +3% additive yield boost, in order to reduce churn
5. **Pick the single winner** — highest biased yield
6. **Allocate the fixed split** — 65% to root, 35% to the winner
7. **Resolve validators** — reuse existing hotkey or pick by yield
8. **Fall back to 100% root** — if no subnet qualifies, everything goes to SN 0

### Key characteristics

- **Fully on-chain**: no external API — all data from the Polkadot runtime
- **Binary allocation**: always exactly 2 positions (root + one alpha) or 1 position (root only)
- **Fixed ratio**: the root/alpha split doesn't adapt to market conditions (configurable but static)
- **Conservative default**: 65% in root provides broad exposure with reduced volatility
- **Simplest strategy**: fewest moving parts, easiest to reason about

---

## Gate System

Every non-root subnet must pass **all 4 gates** to be eligible. Root (SN 0) is always included separately.

| # | Gate | Condition | Purpose |
|---|------|-----------|---------|
| 1 | **Pool Depth** | `taoIn > minTaoIn × TAO` | Ensures sufficient AMM liquidity |
| 2 | **Health** | Not immune AND not prune target | Avoids new/unstable subnets and those about to be deregistered |
| 3 | **Age** | `subnetAge ≥ minSubnetAgeDays × 7200 blocks` | Minimum track record |
| 4 | **Market Cap** | `mcapRao > 0` | Guards against division by zero in yield calculation |

Note: this strategy has **no score gate, no volume gate, no holder gate**. The only quality filter is emission yield itself — the highest yield wins. The pool depth gate and age gate serve as the primary safety filters.

---

## Scoring Formula

The scoring is simpler than the other strategies — it's pure emission yield with no blending:

```
marketCap      = (alphaOut × taoIn) / alphaIn     // in RAO
emissionYield  = (taoInEmission × BLOCKS_PER_YEAR × 10^18) / marketCap
```

If the subnet is held, an additive incumbency bonus is applied:

```
biasedYield = emissionYield + (incumbencyBonus × 10^18 / 100)
```

The subnet with the highest `biasedYield` wins. Ties are broken by raw `emissionYield`, then by lower `netuid`.

---

## The Root/Alpha Split

The split is defined by a single parameter: `rootSharePct`.

```
Root allocation  = rootSharePct%          (default: 65%)
Alpha allocation = (100 − rootSharePct)%  (default: 35%)
```

This split is **fixed at configuration time** and does not adjust based on market conditions. It's recalculated each cycle only to account for portfolio value changes.

### Why a fixed split?

- **Simplicity**: easy to understand and predict
- **Root as anchor**: SN 0 provides diversified exposure to the entire Bittensor network via delegated emission. It's the "index fund" of Bittensor.
- **Alpha as satellite**: the single best-yield subnet provides concentrated upside without excessive risk
- **Rebalancing naturally corrects**: if alpha outperforms, rebalancing sells alpha and buys root (taking profits). If alpha underperforms, rebalancing tops up alpha from root (buying the dip). This is automatic mean reversion.

### Edge case: no qualifying alpha subnet

If all non-root subnets fail the gates, the strategy allocates **100% to root**. The alpha share is absorbed into root rather than being left undeployed.

---

## Configuration Parameters

### Schedule

#### `cronSchedule: "0 */12 * * *"`

Cron expression (evaluated in **UTC**) that controls how often the rebalancer runs.

- **Current value**: every 12 hours (midnight and noon UTC)
- **Rationale**: emission yields change slowly (they're based on on-chain emission rates and market caps). Checking twice daily is sufficient to capture meaningful shifts.
- **Assessment**: ✅ well-calibrated

#### `staleTimeoutMinutes: 5`

Maximum execution time (in minutes) before stale warning.

- **Current value**: 5 minutes
- **Assessment**: ✅ reasonable

---

### Rebalance Parameters

#### `minPositionTao: 0.3`

Minimum TAO value per position.

- **Current value**: 0.3 τ
- **Context**: with only 2 positions max (root + alpha), even a 0.6 τ portfolio can run this strategy. The minimum useful portfolio is approximately `0.3 τ (alpha) + 0.05 τ (reserve) + 0.3 × 65/35 ≈ 0.86 τ` to maintain the 65/35 split with meaningful position sizes.
- **Assessment**: ✅ appropriate for small portfolios

#### `freeReserveTao: 0.05`

Minimum liquid TAO as fee buffer.

- **Current value**: 0.05 τ
- **Assessment**: ✅ reasonable for small portfolios

#### `freeReserveTaoDriftPercent: 5`

Tolerance before triggering reserve replenishment.

- **Current value**: 5%
- **Effective margin**: `0.05 × 0.05 = 0.0025 τ`
- **Assessment**: ✅ good hysteresis

#### `minOperationTao: 0.01`

Minimum operation size.

- **Current value**: 0.01 τ
- **Assessment**: ✅ standard

#### `minStakeTao: 0.01`

Minimum remaining stake after partial unstake.

- **Current value**: 0.01 τ
- **Assessment**: ✅ aligned

#### `minRebalanceTao: 0.15`

Minimum excess or deficit to trigger a rebalance operation.

- **Current value**: 0.15 τ
- **Context**: with a 1.5 τ portfolio split 65/35, positions are ~0.97 τ (root) and ~0.52 τ (alpha). The drift tolerance is:
  - Root: `0.15 / 0.97 ≈ 15%`
  - Alpha: `0.15 / 0.52 ≈ 29%`
- **Rationale**: the root position can drift ~15% before correction, and the alpha position ~29%. This is intentionally permissive because:
  - Only 2 positions → fewer operations needed
  - 12h cycle → natural drift between cycles
  - Small portfolio → gas costs proportionally significant
- **Assessment**: ✅ reasonable for the conservative nature of this strategy. The alpha position's 29% tolerance is high, but since this strategy only picks the *single best* yield subnet, the position will either perform well (no rebalance needed) or be replaced entirely (full exit/swap).

#### `slippageBufferPercent: 3`

Slippage tolerance.

- **Current value**: 3%
- **Assessment**: ✅ reasonable

#### `enforceSlippage: false`

Whether to always use limit-price extrinsics.

- **Current value**: `false`
- **Assessment**: ✅ correct default

---

### Strategy Parameters

#### `rootSharePct: 65`

The fixed percentage of the portfolio allocated to root (SN 0).

- **Current value**: 65%
- **Unit**: percent (validated: must be 1–99)
- **Effective split**: 65% root / 35% alpha
- **Rationale**: a 2:1 ratio favoring root provides broad, stable exposure while maintaining meaningful alpha upside. This is analogous to a traditional "core-satellite" portfolio (60/40 stocks/bonds, but adapted for Bittensor).
- **Trade-off**:
  - Higher (e.g., 85%): very conservative, tiny alpha exposure, essentially an index strategy with a small bet
  - Lower (e.g., 40%): aggressive, majority in a single high-yield subnet, higher risk/reward
- **Assessment**: ✅ well-calibrated for a conservative strategy. 65/35 is a classic balanced allocation.

#### `minTaoIn: 50`

Minimum TAO in the subnet's AMM pool.

- **Current value**: 50 τ
- **Rationale**: higher than the momentum strategy's 30 τ because this strategy is more conservative and concentrates 35% of the portfolio in a single alpha position. Deeper pools are needed to absorb that.
- **Assessment**: ✅ appropriately conservative. For a 1.5 τ portfolio, the alpha position is ~0.52 τ — that's ~1% of a 50 τ pool, which is acceptable.

#### `minSubnetAgeDays: 7`

Minimum subnet age.

- **Current value**: 7 days (50,400 blocks)
- **Rationale**: longer than momentum's 3 days because this strategy values stability over timeliness. A 7-day track record provides more reliable emission yield data.
- **Assessment**: ✅ appropriate for a conservative strategy

#### `incumbencyBonus: 3`

Additive yield bonus for held subnets.

- **Current value**: 3%
- **How it works**: a held subnet's emission yield gets +3 percentage points. So a held subnet yielding 12% competes equally with a non-held subnet yielding 15%.
- **Rationale**: since this strategy picks only 1 alpha subnet, rotation means swapping the entire alpha position — a costly operation. The 3% bonus prevents rotation on marginal yield differences.
- **Assessment**: ✅ well-calibrated. 3% is meaningful for a single-position rotation decision.

---

## Comparison with Other Strategies

| Dimension | root-emission | sma-stoploss | copy-trade |
|-----------|---------------|--------------|------------|
| **Positions** | 2 (root + alpha) | Up to 3 | Mirrors leader |
| **Data source** | On-chain only | On-chain only | On-chain (leader) |
| **Selection signal** | Emission yield | SMA crossover momentum + emission yield | Leader portfolio |
| **Allocation** | Fixed split (65/35) | Equal-weight | Leader shares |
| **Frequency** | Cron (every 12h UTC) | Every 1200 blocks (~4h) | Event-driven |
| **Risk profile** | Conservative | Moderate | Mirrors leader |
| **Root exposure** | Always 65%+ | Only if no momentum | If leader holds root |
| **Best for** | Capital preservation | Trend-following | Passive mirroring |

---

## Summary of Recommendations

| Parameter | Current | Concern | Recommendation |
|-----------|---------|---------|----------------|
| All parameters | — | — | ✅ Look good |

This is the most conservative and simplest strategy. All parameters are well-calibrated for its purpose. No changes recommended.

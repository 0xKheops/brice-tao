# Rebalancing Algorithm

How the rebalancer decides **what to do** given a set of current balances and a ranked list of profitable subnets.

## Table of Contents

- [Inputs](#inputs)
- [Constants & Thresholds](#constants--thresholds)
- [Allocation Algorithm](#allocation-algorithm)
  - [Target Count](#1-target-count)
  - [Target Subnet Selection](#2-target-subnet-selection)
  - [Position Classification](#3-position-classification)
  - [Operation Generation](#4-operation-generation)
- [Swap vs. Unstake Decision](#swap-vs-unstake-decision)
- [Skip Reasons](#skip-reasons)
- [Slippage Buffers](#slippage-buffers)
- [Worked Examples](#worked-examples)

---

## Inputs

The algorithm receives two inputs:

1. **Current balances** — the portfolio's free TAO balance and all existing stake positions (each with a netuid, hotkey, alpha amount, alpha price, and computed TAO value)
2. **Ranked profitable subnets** — an ordered list of subnet netuids scored by momentum (best first), already filtered for liquidity and quality gates (volume, market cap, holder count, buy/sell ratio). The score gate uses hysteresis: held subnets only need `minScore − INCUMBENCY_BONUS` (65) to stay in the candidate pool, while new subnets need `minScore` (70) to enter.

From these, it produces a **rebalance plan**: a list of target allocations and the operations (stake, unstake, swap) needed to reach them.

---

## Constants & Thresholds

| Constant | Value | Role |
|----------|-------|------|
| `FREE_RESERVE_TAO` | **0.05 TAO** | Always kept liquid for transaction fees — never allocated |
| `MIN_POSITION_TAO` | **0.5 TAO** | Minimum allocation per subnet — controls how many targets the portfolio can spread across |
| `MAX_SUBNETS` | **10** | Hard cap on number of target subnets |
| `MIN_REBALANCE_TAO` | **0.25 TAO** | Minimum adjustment size for reductions and stakes — operations below this are skipped to save fees |
| `MIN_STAKE_TAO` | **0.01 TAO** | Floor for existing positions — a reduction must not leave a position below this |
| `MIN_OPERATION_TAO` | **0.01 TAO** | Dust threshold for exits — positions below this in non-target subnets are not worth exiting |
| `INCUMBENCY_BONUS` | **5 points** | Score bonus for subnets already held — a new subnet must outscore a held one by this margin to displace it |

All amounts are in RAO internally (1 TAO = 1,000,000,000 RAO).

Threshold ordering: `MIN_OPERATION_TAO` (0.01) ≤ `MIN_STAKE_TAO` (0.01) < `MIN_REBALANCE_TAO` (0.25) ≤ `MIN_POSITION_TAO` (0.5)

---

## Allocation Algorithm

### 1. Target Count

The algorithm first decides **how many subnets** to spread across:

```
available = totalTaoValue − FREE_RESERVE_TAO

X = min(
  MAX_SUBNETS,                              // Never exceed 10
  max(⌊available / MIN_POSITION_TAO⌋, 1),   // At least 0.5 TAO per target
  max(profitableSubnets.length, 1)           // Can't target more subnets than exist
)
```

The portfolio is then divided equally:

```
targetTaoPerSubnet = available / X
```

**Example:** 5 TAO total → `available = 4.95 TAO` → `⌊4.95 / 0.5⌋ = 9` → with 12 profitable subnets: `X = min(10, 9, 12) = 9` targets at `0.55 TAO` each.

### 2. Target Subnet Selection

1. **Apply incumbency bias** — subnets already held in the portfolio receive a score bonus of `INCUMBENCY_BONUS` (5 points). This stabilises the target set when top scores are close together (e.g., 81, 74, 74, 73…) — a new subnet must outscore a held one by at least 5 points to displace it.
2. Re-sort subnets by adjusted score (descending)
3. Take the top **X** subnets from the re-ranked list
4. If fewer than X profitable subnets exist, pad remaining slots with **netuid 0** (root subnet)
5. Each target gets an equal allocation of `targetTaoPerSubnet`

### 3. Position Classification

Every existing stake position is classified:

- **"keep"** — the position's netuid is in the target set → it stays, but may be adjusted up or down to match the equal-weight target
- **"exit"** — the position's netuid is NOT in the target set → it must be fully liquidated

### 4. Operation Generation

Operations are generated in **three phases**, in strict order:

#### Phase 1 — Full Exits

For each "exit" position:

- **Skip** if `taoValue < MIN_OPERATION_TAO` (too small to bother)
- **Try swap** to an underweight target where the hotkeys match and the target's deficit is large enough to absorb the full position → picks the target with the highest deficit
- **Otherwise** → full unstake

#### Phase 2 — Overweight Reductions

For each "keep" position that exceeds its target allocation:

1. `excess = taoValue − targetTaoValue`
2. **Skip** if `excess < MIN_REBALANCE_TAO` (adjustment too small to justify fees)
3. Cap the reduction: `min(excess, taoValue − MIN_STAKE_TAO)` — never reduce a position below `MIN_STAKE_TAO`
4. **Skip** if the capped reduction < `MIN_REBALANCE_TAO`
5. **Try swap** to an underweight target with matching hotkey and sufficient deficit
6. **Otherwise** → partial unstake

The alpha amount to reduce is derived from the TAO amount: `reduceAlpha = (reduceAmount × TAO) / alphaPrice`.

#### Phase 3 — Stake from Free Balance

1. Pool the available capital: `freeBalance − FREE_RESERVE_TAO + Σ(unstake proceeds from phases 1 & 2)`
2. For each underweight target (ordered by deficit, largest first):
   - `deficit = targetTaoValue − currentFulfilled`
   - **Skip** if `deficit < MIN_REBALANCE_TAO` (adjustment too small to justify fees)
   - Stake `min(deficit, availableFree)`
   - **Skip** if that amount < `MIN_REBALANCE_TAO`
   - Deduct from the available pool

**Why this order?** Exits and reductions run first to unlock capital. Stakes then deploy the accumulated free balance. This avoids needing upfront liquidity.

---

## Swap vs. Unstake Decision

When exiting or reducing a position, the algorithm prefers **swap** over **unstake**:

- **Swap** is used when there is an underweight target whose validator hotkey matches the source position's hotkey, and the target's deficit is large enough to absorb the full operation amount. This transfers alpha directly between subnets without round-tripping through TAO.
- **Unstake** is used otherwise — when hotkeys differ or no matching underweight target exists. The TAO proceeds are added to the free balance pool for Phase 3.

All operations use `allow_partial: false` — they execute the full requested amount or fail entirely.

---

## Skip Reasons

Operations can be skipped for several reasons, logged in the plan:

| Reason | When |
|--------|------|
| Position too small to exit | Position value < `MIN_OPERATION_TAO` (0.01 TAO) |
| Would leave position below minimum | Reducing would breach `MIN_STAKE_TAO` (0.01 TAO) |
| Excess/deficit too small | Adjustment < `MIN_REBALANCE_TAO` (0.25 TAO) — not worth the fees |
| No validator selected | Validator selection failed and no `VALIDATOR_HOTKEY` fallback |
| Insufficient free balance | Not enough free TAO to fund the target's deficit |

---

## Slippage Buffers

Each operation gets a **limit price** computed from an on-chain simulation, with a safety buffer:

| Operation | Buffer | Direction | Meaning |
|-----------|--------|-----------|---------|
| Stake | 0.3% | Upward | "I will pay up to 0.3% more TAO per alpha than simulated" |
| Unstake / Partial unstake | 0.3% | Downward | "I will accept at least 0.3% less TAO per alpha than simulated" |
| Swap | 2% | Downward | "I will accept at least 2% worse exchange ratio than current" |

Swaps use a wider buffer (2% vs 0.3%) because operations within a batch execute sequentially — each swap impacts pool state before the next one's limit is checked. The 2% buffer absorbs this compound intra-batch price drift.

---

## Worked Examples

### Example 1: Full Rotation

Portfolio is entirely in subnets that fell out of the momentum ranking.

**Input:**

```
free: 0.1 TAO
stakes:
  SN99 (hotkey A): 2.0 TAO
  SN88 (hotkey B): 1.5 TAO
totalTaoValue: 3.6 TAO

Profitable subnets (ranked): SN1, SN2, SN3, SN4
```

**Target count:** `available = 3.55 TAO`, `X = min(10, 7, 4) = 4`, target = `0.8875 TAO` each.

**Classification:** SN99 → exit, SN88 → exit (neither in target set).

**Operations:**

| # | Phase | Operation | Detail |
|---|-------|-----------|--------|
| 1 | Exit | UNSTAKE SN99 | Hotkey A ≠ any target hotkey → unstake 2.0 TAO |
| 2 | Exit | UNSTAKE SN88 | Hotkey B ≠ any target hotkey → unstake 1.5 TAO |
| 3 | Stake | STAKE SN1 | 0.8875 TAO |
| 4 | Stake | STAKE SN2 | 0.8875 TAO |
| 5 | Stake | STAKE SN3 | 0.8875 TAO |
| 6 | Stake | STAKE SN4 | 0.8875 TAO |

Free after exits: `0.1 + 2.0 + 1.5 − 0.05 = 3.55 TAO` → covers all 4 stakes exactly.

---

### Example 2: Partial Rebalance with Swap

Some positions overlap with targets; one position has a matching hotkey.

**Input:**

```
free: 0.05 TAO
stakes:
  SN1 (hotkey C): 1.5 TAO   ← already a target, overweight
  SN2 (hotkey D): 0.8 TAO   ← already a target, roughly on-target
  SN77 (hotkey C): 0.6 TAO  ← not a target, shares hotkey C with SN1
totalTaoValue: 2.95 TAO

Profitable subnets (ranked): SN1, SN2, SN3
Target hotkeys: SN1→C, SN2→D, SN3→C
```

**Target count:** `available = 2.9 TAO`, `X = min(10, 5, 3) = 3`, target = `0.967 TAO` each.

**Classification:** SN1 → keep, SN2 → keep, SN77 → exit.

**Operations:**

| # | Phase | Operation | Detail |
|---|-------|-----------|--------|
| 1 | Exit | SWAP SN77 → SN3 | SN3 hotkey C matches SN77 hotkey C, deficit (0.967) ≥ value (0.6) → swap |
| 2 | Overweight | UNSTAKE_PARTIAL SN1 | Excess = 1.5 − 0.967 = 0.533. SN3 already partially filled by swap, remaining deficit < excess or hotkey mismatch → partial unstake |
| 3 | Stake | STAKE SN3 | Remaining deficit after swap: 0.967 − 0.6 = 0.367 TAO from free pool |

SN2 is at 0.8 vs. target 0.967 — deficit is `0.167 TAO` which is below `MIN_REBALANCE_TAO` (0.25 TAO), so no stake operation is generated. The position is close enough to target.

---

### Example 3: Small Portfolio

Portfolio too small to spread across many subnets.

**Input:**

```
free: 0.0 TAO
stakes:
  SN5 (hotkey E): 0.8 TAO
totalTaoValue: 0.8 TAO

Profitable subnets (ranked): SN1, SN2, SN3, SN4, SN5
```

**Target count:** `available = 0.75 TAO`, `⌊0.75 / 0.5⌋ = 1`, `X = min(10, 1, 5) = 1`, target = `0.75 TAO`.

**Classification:** SN5 is not SN1 → exit. Only target is SN1.

**Operations:**

| # | Phase | Operation | Detail |
|---|-------|-----------|--------|
| 1 | Exit | UNSTAKE SN5 | Full unstake 0.8 TAO |
| 2 | Stake | STAKE SN1 | 0.75 TAO (0.05 reserved for fees) |

With only 0.8 TAO, the portfolio concentrates into the single best subnet.

---

### Example 4: Already Balanced

No operations needed.

**Input:**

```
free: 0.05 TAO
stakes:
  SN1 (hotkey F): 0.97 TAO
  SN2 (hotkey G): 0.98 TAO
totalTaoValue: 2.0 TAO

Profitable subnets (ranked): SN1, SN2
```

**Target count:** `available = 1.95 TAO`, `X = min(10, 3, 2) = 2`, target = `0.975 TAO` each.

**Classification:** SN1 → keep (deficit 0.005), SN2 → keep (excess 0.005).

Both the deficit and excess are below `MIN_REBALANCE_TAO` (0.25 TAO) → all adjustments are skipped. The plan has zero operations, and the rebalancer reports "Portfolio Balanced".

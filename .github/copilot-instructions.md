# Copilot Instructions — brice-tao

Automated Bittensor portfolio rebalancer: monitors subnet holdings, scores momentum, computes equal-weight allocation, simulates slippage, batches operations through MEV shield, and reports results to Discord.

## Package Manager

This project uses **Bun** as its package manager and runtime. **Do not use npm, pnpm, or yarn.** All commands (install, run, test, etc.) must use `bun`. The lockfile is `bun.lock` — never generate or reference `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`.

## Quick Reference

| Action | Command |
|--------|---------|
| Install deps | `bun install` |
| Run rebalancer | `bun rebalance` |
| Run rebalancer (dry run) | `bun rebalance -- --dry-run` |
| Lint / format | `bun check` (fix: `bun check --fix --unsafe`) |
| Type-check | `bun typecheck` |
| Dead code detection | `bun knip` |
| Tests | `bun test` |
| Regenerate API clients | `bun generate-clients` |

## Code Conventions

- **No semicolons**, double quotes, tab indentation (enforced by Biome)
- **Imports**: named + type imports with `.ts` extension (`import { foo } from "./bar.ts"`)
- **No default exports** — always use named exports
- **Async**: `Promise.all()` for parallel calls; top-level `await` in scripts
- **Constants**: named `bigint` values; `TAO = 1e9` RAO conversion in [src/rebalance/tao.ts](../src/rebalance/tao.ts)
- **Types**: union types for operation kinds, interfaces for domain models — see [src/rebalance/types.ts](../src/rebalance/types.ts)
- **Config**: tunable parameters in `src/config.yaml` (YAML), loaded at startup — see [src/config/loadConfig.ts](../src/config/loadConfig.ts)
- **Errors**: custom error classes in [src/errors.ts](../src/errors.ts) — use typed catch blocks in orchestrator
- **Logging**: dual logger (terminal + JSON file) in [src/rebalance/logger.ts](../src/rebalance/logger.ts) with levels: `info`, `verbose`, `warn`, `error`

## Architecture

```
src/
  main.ts               → Rebalancer orchestrator (MEV-shielded batch execution)
  errors.ts             → Custom error classes (RebalanceError, ConfigError, etc.)
  config/
    types.ts            → Config schema types (RawConfig, AppConfig)
    loadConfig.ts       → YAML parser + validator (fail-fast)
  config.yaml           → Tunable parameters (rebalance/strategy/health)
  balances/
    getBalances.ts      → TAO/Alpha balance queries via polkadot-api
  subnets/
    fetchAllSubnets.ts  → Subnet registry (SN45 API)
    getHealthySubnets.ts → Liquidity & emission health checks
    getBestSubnets.ts   → Subnet selection (SN45 score ranking + quality gates)
  notifications/
    discord.ts          → Discord webhook notifications
  rebalance/
    types.ts            → Domain types (Operation, Plan, Results)
    tao.ts              → TAO constant (1 TAO = 1e9 RAO) + parseTao helper
    constants.ts        → Re-exports TAO from tao.ts
    computeRebalance.ts → Plan generation from positions & targets
    simulateSlippage.ts → Runtime API swap simulation → price limits
    executeRebalance.ts → Batch build, MEV encryption, submission
    mevShield.ts        → XChaCha20-Poly1305 + ML-KEM-768 encryption
    waitForBatch.ts     → Block scanning, event extraction
    pickBestValidator.ts → Yield-based validator selection per subnet
    logger.ts           → Dual logger: terminal (human-readable) + file (JSON lines)
  api/generated/
    Sn45Api.ts          → Auto-generated SN45 Swagger client
  __test__/
    setup.ts            → Test preload (console suppression)
```

## Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `WS_ENDPOINT` | all | RPC WebSocket endpoints (comma-separated for failover) |
| `COLDKEY_ADDRESS` | all | SS58 coldkey address |
| `PROXY_MNEMONIC` | rebalance | Mnemonic for proxy account (transaction signer) |
| `VALIDATOR_HOTKEY` | rebalance | Optional fallback hotkey when yield-based validator selection fails |
| `DISCORD_WEBHOOK_URL` | rebalance | Discord notifications webhook |
| `SN45_API_KEY` | all | SN45 leaderboard API key |
| `CRON_SCHEDULE` | Docker only | Cron expression for rebalance schedule (default: `*/5 * * * *`) |

No `.env` file — variables must be set externally (Docker uses `.env` mounted as a volume).

## Key Domain Concepts

- **TAO/Alpha**: TAO is the base token (1 TAO = 1e9 RAO). Alpha is per-subnet staking token.
- **Price limits**: U64F64 fixed-point values that protect swaps against slippage.
- **MEV Shield**: Encrypts transaction batches to prevent frontrunning (XChaCha20-Poly1305 + ML-KEM-768).
- **Slippage buffers**: configured in `src/config.yaml` — base buffer for stake/unstake, larger buffer for swaps.

## Skills

Domain-specific knowledge is available in `.github/skills/`:

- **bittensor-staking** — TAO staking extrinsics, runtime APIs, price limit math
- **hdkd** — Mnemonic → key derivation for polkadot-api signers
- **polkadot-api** — Substrate client setup, queries, transactions, code generation

## Pitfalls

- `src/api/generated/` is auto-generated — never edit manually; regenerate with `bun generate-clients`
- All amounts are in RAO (`bigint`), not TAO — always use `TAO` constant for conversions
- Price limits are U64F64 fixed-point — see bittensor-staking skill for encoding
- The rebalancer uses a proxy account (not the coldkey directly) to sign transactions
- `src/config.yaml` is required — the rebalancer will fail fast if it's missing or invalid
- Error classes should be used for all throw sites — enables typed Discord error notifications

## Quality Gates

Before completing work on any task, ensure that the following checks pass:
- `bun check --fix` (linter)
- `bun typecheck` (TypeScript type-checking)
- `bun knip` (dead code detection)
- `bun test` (unit tests, if applicable)

Also ensure that this file and tests stays up to date with any new conventions or architectural changes.

Keep documents in the docs folder up to date with any changes done in the code.

## Subnet Selection — Single Source of Truth

`src/subnets/getBestSubnets.ts` is the **single source of truth** for subnet selection logic (gate evaluation, filtering, ranking). All consumers must call `getBestSubnets()` directly — never reimplement gate logic inline.

**Rules:**
- `getBestSubnets()` returns `{ winners, evaluations }` — `winners` is the filtered/ranked list, `evaluations` has per-gate pass/fail for every leaderboard subnet
- `scripts/simulate-rebalance.ts` must call `getBestSubnets()` for its eligible list and use `evaluations` for its audit table — it must **not** contain its own gate evaluation code
- Any change to gate logic in `getBestSubnets.ts` is automatically reflected in the simulation (no manual sync needed)
- Any change to `getHealthySubnets.ts` thresholds or criteria must be tested against the simulation output
- If a PR introduces gate evaluation logic outside of `getBestSubnets.ts`, **push back** — direct the author to modify `getBestSubnets.ts` instead
- Gate thresholds live in `src/config.yaml` and `STRATEGY_DEFAULTS` in `getBestSubnets.ts` — both the rebalancer and simulation read from the same config

**Key files:**
- `src/subnets/getBestSubnets.ts` — gate evaluation + filtering (source of truth)
- `src/subnets/getHealthySubnets.ts` — on-chain health filter (pool liquidity, immunity, prune risk)
- `src/config.yaml` — tunable thresholds
- `scripts/simulate-rebalance.ts` — simulation (consumer, not source of truth)
- `src/main.ts` — rebalancer (consumer, not source of truth)

Also ensure that this file and tests stays up to date with any new conventions or architectural changes.
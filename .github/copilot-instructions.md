# Copilot Instructions — brice-tao

Automated Bittensor portfolio rebalancer: monitors subnet holdings, scores momentum, computes equal-weight allocation, simulates slippage, batches operations through MEV shield, and reports results to Discord.

## Quick Reference

| Action | Command |
|--------|---------|
| Install deps | `bun install` |
| Run portfolio dashboard | `bun run index.ts` |
| Run rebalancer | `bun run rebalance.ts` |
| Test slippage simulation | `bun run test-slippage.ts` |
| Lint / format | `pnpm check` (fix: `pnpm check --fix --unsafe`) |
| Type-check | `pnpm typecheck` |
| Dead code detection | `pnpm knip` |
| Regenerate API clients | `pnpm generate-clients` |

## Code Conventions

- **No semicolons**, double quotes, tab indentation (enforced by Biome)
- **Imports**: named + type imports with `.ts` extension (`import { foo } from "./bar.ts"`)
- **No default exports** — always use named exports
- **Async**: `Promise.all()` for parallel calls; top-level `await` in scripts
- **Constants**: named `bigint` values; `TAO = 1e9` RAO conversion in [src/rebalance/constants.ts](../src/rebalance/constants.ts)
- **Types**: union types for operation kinds, interfaces for domain models — see [src/rebalance/types.ts](../src/rebalance/types.ts)
- **Logging**: dual logger (terminal + file) in [src/rebalance/logger.ts](../src/rebalance/logger.ts) with levels: `info`, `verbose`, `warn`, `error`

## Architecture

```
index.ts              → Portfolio dashboard (read-only monitoring)
rebalance.ts          → Rebalancer orchestrator (MEV-shielded batch execution)
test-slippage.ts      → Swap simulation validator

src/
  getBalances.ts      → TAO/Alpha balance queries via polkadot-api
  getSubnets.ts       → Subnet registry
  getSubnetHealth.ts  → Liquidity & emission health checks
  getMostProfitableSubnets.ts → Momentum scoring (price change, volume, EMA)
  discord.ts          → Discord webhook notifications

  rebalance/
    types.ts          → Domain types (Operation, Plan, Results)
    constants.ts      → TAO constants, slippage buffers
    computeRebalance.ts → Plan generation from positions & targets
    simulateSlippage.ts → Runtime API swap simulation → price limits
    executeRebalance.ts → Batch build, MEV encryption, submission
    mevShield.ts      → XChaCha20-Poly1305 + ML-KEM-768 encryption
    waitForBatch.ts   → Block scanning, event extraction
    logger.ts         → Dual terminal + file logger

  api/generated/      → Auto-generated Swagger clients (excluded from lint)
```

## Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `WS_ENDPOINT` | all | RPC WebSocket endpoints (comma-separated for failover) |
| `COLDKEY_ADDRESS` | all | SS58 coldkey address |
| `PROXY_MNEMONIC` | rebalance, test-slippage | Mnemonic for proxy account (transaction signer) |
| `VALIDATOR_HOTKEY` | rebalance | Hotkey to stake under |
| `DISCORD_WEBHOOK_URL` | rebalance | Discord notifications webhook |
| `SN45_API_KEY` | all | SN45 leaderboard API key |

No `.env` file — variables must be set externally.

## Key Domain Concepts

- **TAO/Alpha**: TAO is the base token (1 TAO = 1e9 RAO). Alpha is per-subnet staking token.
- **Price limits**: U64F64 fixed-point values that protect swaps against slippage.
- **MEV Shield**: Encrypts transaction batches to prevent frontrunning (XChaCha20-Poly1305 + ML-KEM-768).
- **Slippage buffers**: 0.1% base for stake/unstake, 0.5% for swaps — defined in constants.

## Skills

Domain-specific knowledge is available in `.github/skills/`:

- **bittensor-staking** — TAO staking extrinsics, runtime APIs, price limit math
- **hdkd** — Mnemonic → key derivation for polkadot-api signers
- **polkadot-api** — Substrate client setup, queries, transactions, code generation

## Pitfalls

- `src/api/generated/` is auto-generated — never edit manually; regenerate with `pnpm generate-clients`
- All amounts are in RAO (`bigint`), not TAO — always use `TAO` constant for conversions
- Price limits are U64F64 fixed-point — see bittensor-staking skill for encoding
- The rebalancer uses a proxy account (not the coldkey directly) to sign transactions

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
- `src/scheduling/` — cron runner, one-shot runner, shared context
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
- RPC rate limit ~100 req/min — use throttled batches via `src/api/rpcThrottle.ts`
- Each strategy's `config.yaml` is required — fail-fast if missing

## Quality Gates

Run after every change:
- `bun check --fix` (lint)
- `bun typecheck` (types)
- `bun knip` (dead code)
- `bun test` (tests)

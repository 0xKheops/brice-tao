# Creating a Custom Strategy

The bot uses a pluggable strategy system. Each strategy is a self-contained folder under `src/strategies/` that decides which subnets to allocate to and when to rebalance.

The shared rebalance pipeline handles everything else: balance fetching, operation generation, slippage simulation, MEV-shielded submission, and Discord notifications. Your strategy just provides allocation targets.

---

## Strategy Contract

Each strategy must export a `StrategyModule` with two functions:

```typescript
// From src/strategies/types.ts
export interface StrategyModule {
	getStrategyTargets: StrategyFn
	createRunner: CreateRunnerFn
}
```

### 1. `getStrategyTargets` — Allocation Logic

```typescript
export type StrategyFn = (
	client: PolkadotClient,
	env: Env,
	balances: Balances,
) => Promise<StrategyResult>
```

Where `StrategyResult` contains:

| Field | Type | Description |
|-------|------|-------------|
| `targets` | `StrategyTarget[]` | Array of `{ netuid, hotkey, share }` — share is a fraction (0–1) of total portfolio |
| `skipped` | `Array<{ netuid: number; reason: string }>` | Subnets excluded with reasons |
| `rebalanceConfig` | `RebalanceConfig` | Min position sizes, slippage, drift thresholds (resolved to RAO bigints) |
| `audit` | `AuditSections` (optional) | `terminalLines` for CLI output (preview + dry-run), `reportMarkdown` for preview reports |

### 2. `createRunner` — Scheduling Logic

```typescript
export type CreateRunnerFn = (context: RunnerContext) => StrategyRunner

export interface StrategyRunner {
	start(): Promise<void>
	stop(): Promise<void>
}
```

`RunnerContext` gives your runner everything it needs:

```typescript
export interface RunnerContext {
	client: PolkadotClient
	env: Env
	strategyName: string
	/** Execute a full rebalance cycle */
	runRebalanceCycle(): Promise<RebalanceCycleResult>
}
```

**Runner types:**

- **Cron-based** — Use the shared `createCronRunner` from `src/scheduling/cron.ts`. Runs on a schedule with overlap protection and stale timeout. Best for simple strategies. (Used by `root-emission`)
- **Event-driven** — Custom runner that subscribes to chain events (e.g., `finalizedBlock$`). Best for real-time strategies. (Used by `copy-trade`)

---

## Step-by-Step Guide

### Step 1: Create the Folder Structure

```
src/strategies/my-strategy/
  index.ts       — exports getStrategyTargets
  runner.ts      — exports createRunner
  config.yaml    — tunable parameters
  config.ts      — YAML parser + validator
  types.ts       — strategy-specific types
```

### Step 2: Create `config.yaml`

```yaml
# Required for cron strategies:
cronSchedule: "0 */6 * * *"     # every 6 hours
staleTimeoutMinutes: 10          # max time for one cycle

# Rebalance parameters (controls operation generation):
# TAO amounts are in TAO (not RAO). Slippage/drift values are in percent.
# These get resolved to RAO bigints and decimal fractions in config.ts.
rebalance:
  minPositionTao: 0.3            # smallest position to maintain
  freeReserveTao: 0.05           # idle TAO to keep for fees
  freeReserveTaoDriftPercent: 5  # allowable drift before rebalancing reserve
  minOperationTao: 0.01          # minimum operation size
  minStakeTao: 0.01              # minimum stake amount
  minRebalanceTao: 0.15          # skip cycle if total rebalance < this
  slippageBufferPercent: 3       # slippage buffer for simulations
  enforceSlippage: false         # true = always use limit-price extrinsics
  allocationDriftPercent: 25     # rebalance when position drifts > 25% from target

# Your custom strategy parameters:
strategy:
  myParam: 42
```

### Step 3: Create `types.ts`

```typescript
export interface MyStrategyConfig {
	myParam: number
}
```

### Step 4: Create `config.ts`

The config loader parses your YAML and resolves TAO amounts to RAO bigints. The `$bunfs` path handling is required for compiled binary support.

```typescript
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parse } from "yaml"
import { ConfigError } from "../../errors.ts"
import { parseTao } from "../../rebalance/tao.ts"
import type { RebalanceConfig } from "../../rebalance/types.ts"
import type { CronScheduleConfig } from "../../scheduling/types.ts"
import type { MyStrategyConfig } from "./types.ts"

// Handle compiled binary vs source paths
const metaDir = new URL(".", import.meta.url).pathname
const CONFIG_PATH = metaDir.startsWith("/$bunfs")
	? join(
			dirname(process.execPath),
			"src",
			"strategies",
			"my-strategy",
			"config.yaml",
		)
	: new URL("./config.yaml", import.meta.url).pathname

export interface MyStrategyAppConfig {
	schedule: CronScheduleConfig
	rebalance: RebalanceConfig
	strategy: MyStrategyConfig
}

export function loadConfig(): MyStrategyAppConfig {
	let text: string
	try {
		text = readFileSync(CONFIG_PATH, "utf-8")
	} catch {
		throw new ConfigError(
			`Config file not found: ${CONFIG_PATH}. A config.yaml is required.`,
		)
	}

	const raw = parse(text) as Record<string, unknown>
	if (!raw || typeof raw !== "object") {
		throw new ConfigError("Config must be a YAML object")
	}

	// Validate and resolve — adapt this to your needs.
	// See root-emission/config.ts for a thorough validation example.
	const rebalance = raw.rebalance as Record<string, number>

	return {
		schedule: {
			cronSchedule: raw.cronSchedule as string,
			staleTimeoutMinutes: raw.staleTimeoutMinutes as number,
		},
		rebalance: {
			minPositionTao: parseTao(rebalance.minPositionTao),
			freeReserveTao: parseTao(rebalance.freeReserveTao),
			freeReserveTaoDriftPercent: rebalance.freeReserveTaoDriftPercent / 100,
			minOperationTao: parseTao(rebalance.minOperationTao),
			minStakeTao: parseTao(rebalance.minStakeTao),
			minRebalanceTao: parseTao(rebalance.minRebalanceTao),
			slippageBuffer: rebalance.slippageBufferPercent / 100,
			enforceSlippage: Boolean(rebalance.enforceSlippage),
			allocationDriftPercent: rebalance.allocationDriftPercent / 100,
		},
		strategy: {
			myParam: (raw.strategy as Record<string, number>).myParam,
		},
	}
}
```

> **Note:** `RebalanceConfig` stores TAO amounts as `bigint` (RAO) and percentages as decimal fractions (e.g., `0.03` for 3%). Use `parseTao()` from `src/rebalance/tao.ts` to convert TAO floats to RAO bigints.

### Step 5: Implement `getStrategyTargets` in `index.ts`

```typescript
import { dirname, join } from "node:path"
import { bittensor } from "@polkadot-api/descriptors"
import type { PolkadotClient, TypedApi } from "polkadot-api"
import type { Balances } from "../../balances/getBalances.ts"
import type { Env } from "../../config/env.ts"
import { log } from "../../rebalance/logger.ts"
import type { StrategyTarget } from "../../rebalance/types.ts"
import type { AuditSections, StrategyResult } from "../types.ts"
import { resolveValidators } from "../../validators/index.ts"
import { loadConfig } from "./config.ts"

type Api = TypedApi<typeof bittensor>

export async function getStrategyTargets(
	client: PolkadotClient,
	env: Env,
	balances: Balances,
): Promise<StrategyResult> {
	const api: Api = client.getTypedApi(bittensor)
	const config = loadConfig()

	// 1. Fetch on-chain data (subnet info, emissions, etc.)
	// 2. Score and filter subnets
	const targetNetuids = [0, 18]  // your subnet selection logic here

	// 3. Resolve validators (shared utility — handles existing positions,
	//    yield-based selection, and fallback to VALIDATOR_HOTKEY)
	const { hotkeysByTarget, skipped } = await resolveValidators(
		api,
		balances.stakes,
		targetNetuids,
		env.validatorHotkey,
	)

	// 4. Build targets with shares (must sum to ≤ 1.0)
	const targets: StrategyTarget[] = targetNetuids
		.filter((netuid) => hotkeysByTarget.has(netuid))
		.map((netuid) => ({
			netuid,
			hotkey: hotkeysByTarget.get(netuid)!,
			share: 1 / targetNetuids.length,
		}))

	log.info(`Selected ${targets.length} subnets, skipped ${skipped.length}`)

	return {
		targets,
		skipped,
		rebalanceConfig: config.rebalance,
		audit: {
			terminalLines: [`Selected subnets: ${targets.map((t) => `SN${t.netuid}`).join(", ")}`],
			reportMarkdown: `## My Strategy\n\nAllocated equally across ${targets.length} subnets.`,
		},
	}
}
```

### Step 6: Implement `createRunner` in `runner.ts`

For a **cron-based strategy** (simplest):

```typescript
import { createCronRunner } from "../../scheduling/cron.ts"
import type { RunnerContext, StrategyRunner } from "../../scheduling/types.ts"
import { loadConfig } from "./config.ts"

export function createRunner(ctx: RunnerContext): StrategyRunner {
	const { schedule } = loadConfig()
	return createCronRunner({
		schedule,
		onTick: () => ctx.runRebalanceCycle(),
		label: `scheduler:${ctx.strategyName}`,
	})
}
```

For an **event-driven strategy**, implement custom `start()`/`stop()` methods with chain subscriptions. See `src/strategies/copy-trade/runner.ts` for an example.

### Step 7: Register in `loader.ts`

Add static imports and a registry entry in `src/strategies/loader.ts`:

```typescript
// Add imports at the top
import { getStrategyTargets as myStrategy } from "./my-strategy/index.ts"
import { createRunner as myStrategyRunner } from "./my-strategy/runner.ts"

// Add to the strategyRegistry object
const strategyRegistry: Record<string, StrategyModule> = {
	// ... existing strategies
	"my-strategy": {
		getStrategyTargets: myStrategy,
		createRunner: myStrategyRunner,
	},
}
```

> **Why static imports?** Dynamic `import()` doesn't work in Bun-compiled binaries (`/$bunfs/` virtual FS). All strategies must be statically imported so Bun can bundle them.

### Step 8: Test and Run

```bash
# List all registered strategies
bun rebalance -- --list-strategies

# Simulate without submitting transactions
bun preview -- --strategy my-strategy

# Dry run (full pipeline, but skips submission)
bun rebalance -- --strategy my-strategy --dry-run

# Live run
bun rebalance -- --strategy my-strategy

# Run on a schedule
bun scheduler -- --strategy my-strategy
```

---

## Tips

- **Validator selection**: Choosing the right validator per subnet is an important part of strategy design. Ideally, your strategy implements its own selection logic that accounts for take rate, uptime, reputation, or external scoring APIs. If you don't have a better signal, use the shared defaults from `src/validators/` as a fallback — they handle existing-position reuse, yield-based selection, and env-var fallback out of the box:

  ```typescript
  import { resolveValidators } from "../../validators/index.ts"

  const { hotkeysByTarget, skipped } = await resolveValidators(
  	api,
  	balances.stakes,
  	targetNetuids,
  	env.validatorHotkey,  // optional fallback
  )
  ```

  The default picks validators by last-epoch alpha yield, which is a reasonable starting point but ignores take rate, uptime, and historical trends.

- **SN0 as safe harbor**: When in doubt, allocate remaining portfolio to SN0 (root network). It's the most liquid and lowest-risk subnet.

- **Incumbency bonus**: Give a small scoring bonus (+3–5%) to currently-held subnets to reduce unnecessary churn and transaction costs.

- **Audit sections**: Return `audit` in your `StrategyResult` for rich output. `terminalLines` appear in both `bun preview` and `bun rebalance --dry-run`; `reportMarkdown` goes into the preview report file.

- **Shares must sum to ≤ 1.0**: The rebalance pipeline distributes available TAO proportionally across your targets. Any unallocated share stays as free TAO.

- **Error handling**: Use custom error classes from `src/errors.ts` (e.g., `ConfigError`, `RebalanceError`) for typed catch blocks and Discord error notifications.

---

## Conventions

| Rule | Example |
|------|---------|
| No semicolons | `const x = 1` |
| Double quotes | `"hello"` |
| Tab indentation | (enforced by Biome) |
| Named exports only | `export function foo()` not `export default` |
| Import with `.ts` extension | `import { foo } from "./bar.ts"` |
| All amounts in RAO (`bigint`) | Use `TAO` constant from `src/rebalance/tao.ts` |
| Self-contained strategies | Don't import from other strategy folders (shared infra in `src/validators/`, `src/rebalance/`, `src/scheduling/` is fine) |

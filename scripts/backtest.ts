/**
 * Backtest script — replays historical DB snapshots through a strategy
 * and simulates portfolio changes at spot prices.
 *
 * This is a **price-only** backtest: it tracks portfolio value from spot
 * price changes and rebalance trades. It does NOT model emission rewards,
 * staking fees, or AMM slippage. Results represent an idealised upper bound.
 *
 * Fee model:
 * - 0.05% pool fee per trade (approximates AMM swap fee)
 * - Fixed transaction fee per trade (TX_FEE_RAO)
 *
 * Schedule detection:
 * - Reads the strategy's native schedule via `getBacktestSchedule()`.
 *   Cron schedules are evaluated in UTC against historical block timestamps.
 *   Block-interval schedules use modulo-aligned block numbers.
 * - CLI overrides: `--interval-blocks <n>` or `--cron "<expr>"` force a
 *   specific schedule regardless of strategy config.
 *
 * Usage:
 *   bun backtest -- --strategy <name> [--initial-tao <number>] [--interval-blocks <number>] [--cron "<expr>"]
 */

import { join } from "node:path";
import { Cron } from "croner";
import { DB_HISTORY_BLOCK_INTERVAL } from "../src/history/constants.ts";
import { openHistoryDatabase } from "../src/history/index.ts";
import { formatTao, TAO } from "../src/rebalance/tao.ts";
import { loadStrategy, resolveStrategyName } from "../src/strategies/loader.ts";
import type { BacktestSchedule } from "../src/strategies/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const F32 = 1n << 32n;

/** Pool fee applied per trade (0.05% = 5 basis points) */
const POOL_FEE_BPS = 5n;
const POOL_FEE_DENOM = 10_000n;

/** Fixed transaction fee per trade (~0.0001 TAO) */
const TX_FEE_RAO = TAO / 10_000n;

const DB_PATH = join("data", "history.sqlite");
const DEFAULT_INITIAL_TAO = 100;

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseIntArg(flag: string, fallback: number): number {
	const idx = process.argv.indexOf(flag);
	if (idx === -1) return fallback;
	const raw = process.argv[idx + 1];
	if (!raw || raw.startsWith("--")) {
		console.error(`${flag} requires a numeric value`);
		process.exit(1);
	}
	const value = Number.parseInt(raw, 10);
	if (Number.isNaN(value) || value <= 0) {
		console.error(`${flag} must be a positive integer, got: ${raw}`);
		process.exit(1);
	}
	return value;
}

function parseStringArg(flag: string): string | undefined {
	const idx = process.argv.indexOf(flag);
	if (idx === -1) return undefined;
	const raw = process.argv[idx + 1];
	if (!raw || raw.startsWith("--")) {
		console.error(`${flag} requires a value`);
		process.exit(1);
	}
	return raw;
}

const strategyName = resolveStrategyName(process.env.STRATEGY);
const initialTao = parseIntArg("--initial-tao", DEFAULT_INITIAL_TAO);
const cliIntervalBlocks = process.argv.includes("--interval-blocks")
	? parseIntArg("--interval-blocks", 0)
	: undefined;
const cliCron = parseStringArg("--cron");

if (cliIntervalBlocks !== undefined && cliCron !== undefined) {
	console.error("Cannot specify both --interval-blocks and --cron");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Backfill gap: bring history DB up to the current finalized block
// ---------------------------------------------------------------------------

const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const archiveEndpoints = process.env.ARCHIVE_WS_ENDPOINT?.split(",") ?? [];

if (!wsEndpoints.length || !archiveEndpoints.length) {
	console.warn(
		"⚠ WS_ENDPOINT or ARCHIVE_WS_ENDPOINT not set — skipping auto-backfill. History may be stale.",
	);
} else {
	// Determine how many days to request: cover the entire DB range + gap to now.
	// The backfill script auto-resumes and only fetches missing blocks, so
	// requesting a generous window is cheap when most data already exists.
	const db0 = openHistoryDatabase(DB_PATH);
	const existingMetas = db0.getBlockMetas();
	db0.close();

	// Default to 30 days if DB is empty; otherwise cover from latest block to now
	const backfillDays =
		existingMetas.length > 0
			? Math.ceil(
					(Date.now() -
						(existingMetas[existingMetas.length - 1]?.timestamp ?? 0)) /
						86_400_000,
				) + 1
			: 30;

	if (backfillDays > 0) {
		console.log(`\n🔄 Backfilling history (${backfillDays} day window)...`);
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				"scripts/backfill-history.ts",
				"--days",
				String(backfillDays),
			],
			{ cwd: process.cwd(), stdout: "inherit", stderr: "inherit" },
		);
		if (result.exitCode !== 0) {
			console.warn("⚠ Backfill failed — continuing with existing data.\n");
		} else {
			console.log();
		}
	}
}

// ---------------------------------------------------------------------------
// Load strategy
// ---------------------------------------------------------------------------

const strategyModule = await loadStrategy(strategyName);
if (!strategyModule.createBacktest) {
	console.error(
		`Strategy "${strategyName}" does not support backtesting (no createBacktest export).`,
	);
	process.exit(1);
}
const strategy = strategyModule.createBacktest();

// ---------------------------------------------------------------------------
// Resolve schedule: CLI override → strategy config → error
// ---------------------------------------------------------------------------

let schedule: BacktestSchedule;
if (cliCron) {
	schedule = { type: "cron", cronSchedule: cliCron };
} else if (cliIntervalBlocks !== undefined) {
	schedule = { type: "block-interval", intervalBlocks: cliIntervalBlocks };
} else if (strategyModule.getBacktestSchedule) {
	schedule = strategyModule.getBacktestSchedule();
} else {
	console.error(
		`Strategy "${strategyName}" has no getBacktestSchedule() — provide --interval-blocks or --cron`,
	);
	process.exit(1);
}

// Validate block-interval alignment
if (
	schedule.type === "block-interval" &&
	schedule.intervalBlocks % DB_HISTORY_BLOCK_INTERVAL !== 0
) {
	console.error(
		`--interval-blocks (${schedule.intervalBlocks}) must be a multiple of BLOCK_INTERVAL (${DB_HISTORY_BLOCK_INTERVAL}) for history DB alignment`,
	);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Load history
// ---------------------------------------------------------------------------

const db = openHistoryDatabase(DB_PATH);
const blockMetas = db.getBlockMetas();

if (blockMetas.length < 2) {
	console.error(
		"Not enough data in history DB to backtest. Run `bun backfill` first.",
	);
	db.close();
	process.exit(1);
}

// biome-ignore lint/style/noNonNullAssertion: length >= 2 guaranteed above
const firstBlock = blockMetas[0]!;
// biome-ignore lint/style/noNonNullAssertion: length >= 2 guaranteed above
const lastBlock = blockMetas[blockMetas.length - 1]!;

const scheduleLabel =
	schedule.type === "cron"
		? `cron "${schedule.cronSchedule}" (UTC)`
		: `every ${schedule.intervalBlocks} blocks`;

console.log(`\n📊 Backtest: ${strategyName} (price-only, no emission accrual)`);
console.log(
	`   Fee model: 0.05% pool fee + ${formatTao(TX_FEE_RAO)} τ tx fee per trade`,
);
console.log(`   Initial capital: ${initialTao} τ`);
console.log(
	`   Period: block ${firstBlock.blockNumber} → ${lastBlock.blockNumber} (${blockMetas.length} snapshots)`,
);
console.log(`   Rebalance schedule: ${scheduleLabel}`);
console.log();

// ---------------------------------------------------------------------------
// Price helpers
// ---------------------------------------------------------------------------

/** Convert alpha amount → TAO (RAO) using I96F32 spot price */
function alphaToTao(alpha: bigint, spotPrice: bigint): bigint {
	if (spotPrice <= 0n) return 0n;
	return (alpha * spotPrice) / F32;
}

/** Convert TAO (RAO) → alpha amount using I96F32 spot price */
function taoToAlpha(tao: bigint, spotPrice: bigint): bigint {
	if (spotPrice <= 0n) return 0n;
	return (tao * F32) / spotPrice;
}

// ---------------------------------------------------------------------------
// Virtual portfolio
// ---------------------------------------------------------------------------

interface Position {
	alpha: bigint;
}

let free: bigint = BigInt(initialTao) * TAO;
const positions: Map<number, Position> = new Map();
let totalTrades = 0;
let totalFeesPaid = 0n;

function getHeldNetuids(): Set<number> {
	const held = new Set<number>();
	for (const [netuid, pos] of positions) {
		if (pos.alpha > 0n) held.add(netuid);
	}
	return held;
}

function portfolioValue(priceMap: Map<number, bigint>): bigint {
	let total = free;
	for (const [netuid, pos] of positions) {
		const price = priceMap.get(netuid) ?? 0n;
		total += alphaToTao(pos.alpha, price);
	}
	return total;
}

function buildPriceMap(
	snapshots: Array<{ netuid: number; spotPrice: bigint }>,
): Map<number, bigint> {
	return new Map(snapshots.map((s) => [s.netuid, s.spotPrice]));
}

// ---------------------------------------------------------------------------
// Trade execution helpers
// ---------------------------------------------------------------------------

function formatTime(timestampMs: number): string {
	return new Date(timestampMs).toISOString().replace("T", " ").slice(0, 19);
}

function logTrade(
	side: "BUY " | "SELL",
	netuid: number,
	subnetName: string,
	taoAmount: bigint,
	blockNumber: number,
	timestamp: number,
) {
	console.log(
		`  ${side}  SN${String(netuid).padEnd(3)} (${subnetName.slice(0, 15).padEnd(15)})  ${formatTao(taoAmount).padStart(12)} τ  @ ${formatTime(timestamp)}  #${blockNumber}`,
	);
}

function sellAll(
	netuid: number,
	spotPrice: bigint,
	blockNumber: number,
	timestamp: number,
	subnetName: string,
) {
	const pos = positions.get(netuid);
	if (!pos || pos.alpha <= 0n) return;
	const grossTao = alphaToTao(pos.alpha, spotPrice);
	const poolFee = (grossTao * POOL_FEE_BPS) / POOL_FEE_DENOM;
	const taoReceived = grossTao - poolFee - TX_FEE_RAO;
	if (taoReceived <= 0n) return;
	free += taoReceived;
	totalFeesPaid += poolFee + TX_FEE_RAO;
	logTrade("SELL", netuid, subnetName, taoReceived, blockNumber, timestamp);
	positions.delete(netuid);
	totalTrades++;
}

function sellPartial(
	netuid: number,
	taoAmount: bigint,
	spotPrice: bigint,
	blockNumber: number,
	timestamp: number,
	subnetName: string,
) {
	const pos = positions.get(netuid);
	if (!pos || pos.alpha <= 0n || spotPrice <= 0n) return;
	const alphaToSell = taoToAlpha(taoAmount, spotPrice);
	const actualAlpha = alphaToSell > pos.alpha ? pos.alpha : alphaToSell;
	const grossTao = alphaToTao(actualAlpha, spotPrice);
	const poolFee = (grossTao * POOL_FEE_BPS) / POOL_FEE_DENOM;
	const taoReceived = grossTao - poolFee - TX_FEE_RAO;
	if (taoReceived <= 0n) return;
	pos.alpha -= actualAlpha;
	free += taoReceived;
	totalFeesPaid += poolFee + TX_FEE_RAO;
	if (pos.alpha <= 0n) positions.delete(netuid);
	logTrade("SELL", netuid, subnetName, taoReceived, blockNumber, timestamp);
	totalTrades++;
}

function buy(
	netuid: number,
	taoAmount: bigint,
	spotPrice: bigint,
	blockNumber: number,
	timestamp: number,
	subnetName: string,
) {
	if (taoAmount <= 0n || spotPrice <= 0n) return;
	const actual = taoAmount > free ? free : taoAmount;
	if (actual <= 0n) return;
	const poolFee = (actual * POOL_FEE_BPS) / POOL_FEE_DENOM;
	const netTao = actual - poolFee - TX_FEE_RAO;
	if (netTao <= 0n) return;
	const alphaReceived = taoToAlpha(netTao, spotPrice);
	free -= actual;
	totalFeesPaid += poolFee + TX_FEE_RAO;
	const pos = positions.get(netuid) ?? { alpha: 0n };
	pos.alpha += alphaReceived;
	positions.set(netuid, pos);
	logTrade("BUY ", netuid, subnetName, actual, blockNumber, timestamp);
	totalTrades++;
}

// ---------------------------------------------------------------------------
// Rebalance trigger helpers
// ---------------------------------------------------------------------------

/**
 * Build a trigger function that decides whether to rebalance at a given block.
 *
 * For block-interval: pure modulo check (blockNumber % intervalBlocks === 0).
 * For cron: persistent nextScheduledAt — trigger on first snapshot at-or-after
 * the scheduled time, then advance to the next cron tick.
 */
function buildTrigger(
	sched: BacktestSchedule,
	firstTimestamp: number,
): (blockNumber: number, timestamp: number) => boolean {
	if (sched.type === "block-interval") {
		const interval = sched.intervalBlocks;
		return (blockNumber) => blockNumber % interval === 0;
	}

	// Cron-based: maintain persistent nextScheduledAt
	const cron = new Cron(sched.cronSchedule, { timezone: "UTC" });
	// Initialize: find the first cron tick at-or-after the first snapshot
	let nextScheduledAt = cron.nextRun(new Date(firstTimestamp - 1));
	if (!nextScheduledAt) {
		console.error(
			`Cron expression "${sched.cronSchedule}" has no future ticks from ${new Date(firstTimestamp).toISOString()}`,
		);
		process.exit(1);
	}

	return (_blockNumber, timestamp) => {
		if (!nextScheduledAt) return false;
		if (timestamp < nextScheduledAt.getTime()) return false;

		// Fire! Advance to next cron tick.
		// Use nextScheduledAt (not current timestamp) as reference to avoid
		// skipping ticks that pile up during DB gaps.
		const next = cron.nextRun(nextScheduledAt);
		nextScheduledAt = next;
		return true;
	};
}

// ---------------------------------------------------------------------------
// Main simulation loop
// ---------------------------------------------------------------------------

const initialValue = free;
const shouldRebalance = buildTrigger(schedule, firstBlock.timestamp);
let rebalanceCount = 0;

for (const meta of blockMetas) {
	const snapshots = db.getSnapshotsAtBlock(meta.blockNumber);
	if (snapshots.length === 0) continue;

	const heldNetuids = getHeldNetuids();

	if (!shouldRebalance(meta.blockNumber, meta.timestamp)) {
		strategy.observe(snapshots, meta.blockNumber, meta.timestamp, heldNetuids);
		continue;
	}

	// Rebalance tick
	const { targets } = strategy.step(
		snapshots,
		meta.blockNumber,
		meta.timestamp,
		heldNetuids,
	);

	const priceMap = buildPriceMap(snapshots);
	const nameMap = new Map(snapshots.map((s) => [s.netuid, s.name]));
	const totalValue = portfolioValue(priceMap);

	// Build target set
	const targetSet = new Map(targets.map((t) => [t.netuid, t.share]));

	// 1. Sell positions not in target set
	for (const [netuid] of positions) {
		if (!targetSet.has(netuid)) {
			const price = priceMap.get(netuid) ?? 0n;
			sellAll(
				netuid,
				price,
				meta.blockNumber,
				meta.timestamp,
				nameMap.get(netuid) ?? "?",
			);
		}
	}

	// 2. Rebalance: compute target TAO values and adjust
	for (const target of targets) {
		const price = priceMap.get(target.netuid) ?? 0n;
		const targetTao =
			(totalValue * BigInt(Math.round(target.share * 1e9))) / 1_000_000_000n;
		const currentPos = positions.get(target.netuid);
		const currentTao = currentPos ? alphaToTao(currentPos.alpha, price) : 0n;

		const diff = targetTao - currentTao;
		const name = nameMap.get(target.netuid) ?? "?";

		// Skip tiny adjustments (< 0.01 τ)
		const MIN_TRADE = TAO / 100n;
		if (diff > MIN_TRADE) {
			buy(target.netuid, diff, price, meta.blockNumber, meta.timestamp, name);
		} else if (diff < -MIN_TRADE) {
			sellPartial(
				target.netuid,
				-diff,
				price,
				meta.blockNumber,
				meta.timestamp,
				name,
			);
		}
	}

	rebalanceCount++;
}

// ---------------------------------------------------------------------------
// Final valuation and summary
// ---------------------------------------------------------------------------

const finalSnapshots = db.getSnapshotsAtBlock(lastBlock.blockNumber);
const finalPriceMap = buildPriceMap(finalSnapshots);
const finalValue = portfolioValue(finalPriceMap);

db.close();

const pnlRao = finalValue - initialValue;
const pnlPct = Number((pnlRao * 10000n) / initialValue) / 100;

const durationMs = lastBlock.timestamp - firstBlock.timestamp;
const durationDays = durationMs / (86_400 * 1000);
const totalReturn = Number(finalValue) / Number(initialValue);
const annualizedReturn =
	durationDays > 0 ? (totalReturn ** (365.25 / durationDays) - 1) * 100 : 0;

console.log(`\n${"═".repeat(60)}`);
console.log("  BACKTEST SUMMARY (price-only, no emission accrual)");
console.log("═".repeat(60));
console.log(`  Strategy:         ${strategyName}`);
console.log(`  Schedule:         ${scheduleLabel}`);
console.log(`  Period:           ${durationDays.toFixed(1)} days`);
console.log(`  Rebalances:       ${rebalanceCount}`);
console.log(`  Total trades:     ${totalTrades}`);
console.log(`  Total fees paid:  ${formatTao(totalFeesPaid)} τ`);
console.log(`  Initial value:    ${formatTao(initialValue)} τ`);
console.log(`  Final value:      ${formatTao(finalValue)} τ`);
console.log(
	`  PnL:              ${pnlRao >= 0n ? "+" : ""}${formatTao(pnlRao)} τ (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
);
console.log(
	`  Annualized:       ${annualizedReturn >= 0 ? "+" : ""}${annualizedReturn.toFixed(2)}% APY`,
);

// Show final positions
if (positions.size > 0) {
	console.log("\n  Final positions:");
	for (const [netuid, pos] of positions) {
		const price = finalPriceMap.get(netuid) ?? 0n;
		const taoVal = alphaToTao(pos.alpha, price);
		const name = finalSnapshots.find((s) => s.netuid === netuid)?.name ?? "?";
		console.log(
			`    SN${String(netuid).padEnd(3)} (${name.slice(0, 15).padEnd(15)}): ${formatTao(taoVal).padStart(12)} τ`,
		);
	}
	if (free > 0n) {
		console.log(
			`    Free TAO:${"".padEnd(17)} ${formatTao(free).padStart(12)} τ`,
		);
	}
}
console.log("═".repeat(60));
console.log();

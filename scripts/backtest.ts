/**
 * Backtest script — replays historical DB snapshots through a strategy
 * and simulates portfolio changes at spot prices.
 *
 * This is a **price-only** backtest: it tracks portfolio value from spot
 * price changes and rebalance trades. It does NOT model emission rewards,
 * staking fees, or AMM slippage. Results represent an idealised upper bound.
 *
 * Usage:
 *   bun backtest -- --strategy <name> [--initial-tao <number>] [--interval-blocks <number>]
 */

import { join } from "node:path";
import { openHistoryDatabase } from "../src/history/index.ts";
import { formatTao, TAO } from "../src/rebalance/tao.ts";
import { loadStrategy, resolveStrategyName } from "../src/strategies/loader.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const F32 = 1n << 32n;

const DB_PATH = join("data", "history.sqlite");
const DEFAULT_INITIAL_TAO = 100;
const DEFAULT_INTERVAL_BLOCKS = 7200; // ~1 day at 12s/block

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

const strategyName = resolveStrategyName(process.env.STRATEGY);
const initialTao = parseIntArg("--initial-tao", DEFAULT_INITIAL_TAO);
const intervalBlocks = parseIntArg(
	"--interval-blocks",
	DEFAULT_INTERVAL_BLOCKS,
);

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

console.log(`\n📊 Backtest: ${strategyName} (price-only, no emission accrual)`);
console.log(`   Initial capital: ${initialTao} τ`);
console.log(
	`   Period: block ${firstBlock.blockNumber} → ${lastBlock.blockNumber} (${blockMetas.length} snapshots)`,
);
console.log(`   Rebalance interval: every ${intervalBlocks} blocks`);
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

function sellAll(
	netuid: number,
	spotPrice: bigint,
	blockNumber: number,
	subnetName: string,
) {
	const pos = positions.get(netuid);
	if (!pos || pos.alpha <= 0n) return;
	const taoReceived = alphaToTao(pos.alpha, spotPrice);
	free += taoReceived;
	console.log(
		`  SELL  SN${String(netuid).padEnd(3)} (${subnetName.slice(0, 15).padEnd(15)})  ${formatTao(taoReceived).padStart(12)} τ  @ block ${blockNumber}`,
	);
	positions.delete(netuid);
	totalTrades++;
}

function sellPartial(
	netuid: number,
	taoAmount: bigint,
	spotPrice: bigint,
	blockNumber: number,
	subnetName: string,
) {
	const pos = positions.get(netuid);
	if (!pos || pos.alpha <= 0n || spotPrice <= 0n) return;
	const alphaToSell = taoToAlpha(taoAmount, spotPrice);
	const actualAlpha = alphaToSell > pos.alpha ? pos.alpha : alphaToSell;
	const taoReceived = alphaToTao(actualAlpha, spotPrice);
	pos.alpha -= actualAlpha;
	free += taoReceived;
	if (pos.alpha <= 0n) positions.delete(netuid);
	console.log(
		`  SELL  SN${String(netuid).padEnd(3)} (${subnetName.slice(0, 15).padEnd(15)})  ${formatTao(taoReceived).padStart(12)} τ  @ block ${blockNumber}`,
	);
	totalTrades++;
}

function buy(
	netuid: number,
	taoAmount: bigint,
	spotPrice: bigint,
	blockNumber: number,
	subnetName: string,
) {
	if (taoAmount <= 0n || spotPrice <= 0n) return;
	const actual = taoAmount > free ? free : taoAmount;
	if (actual <= 0n) return;
	const alphaReceived = taoToAlpha(actual, spotPrice);
	free -= actual;
	const pos = positions.get(netuid) ?? { alpha: 0n };
	pos.alpha += alphaReceived;
	positions.set(netuid, pos);
	console.log(
		`  BUY   SN${String(netuid).padEnd(3)} (${subnetName.slice(0, 15).padEnd(15)})  ${formatTao(actual).padStart(12)} τ  @ block ${blockNumber}`,
	);
	totalTrades++;
}

// ---------------------------------------------------------------------------
// Main simulation loop
// ---------------------------------------------------------------------------

const initialValue = free;
let nextRebalanceBlock = firstBlock.blockNumber;
let rebalanceCount = 0;

for (const meta of blockMetas) {
	const snapshots = db.getSnapshotsAtBlock(meta.blockNumber);
	if (snapshots.length === 0) continue;

	const heldNetuids = getHeldNetuids();

	// Observe at every snapshot (updates SMA, stop-losses, etc.)
	if (meta.blockNumber < nextRebalanceBlock) {
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
			sellAll(netuid, price, meta.blockNumber, nameMap.get(netuid) ?? "?");
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
			buy(target.netuid, diff, price, meta.blockNumber, name);
		} else if (diff < -MIN_TRADE) {
			sellPartial(target.netuid, -diff, price, meta.blockNumber, name);
		}
	}

	rebalanceCount++;
	nextRebalanceBlock = meta.blockNumber + intervalBlocks;
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
console.log(`  Period:           ${durationDays.toFixed(1)} days`);
console.log(`  Rebalances:       ${rebalanceCount}`);
console.log(`  Total trades:     ${totalTrades}`);
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

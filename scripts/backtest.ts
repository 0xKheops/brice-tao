/**
 * Backtest script — replays historical DB snapshots through a strategy
 * and simulates portfolio changes using AMM-aware trade execution.
 *
 * Trade model:
 * - Uses constant-product AMM (x·y=k) with pool reserves from the history DB.
 *   Trade outputs account for price impact from pool liquidity depth.
 * - Accurate for V2 pools (direct constant product) and V3 pools with only
 *   the protocol's full-range position (mathematically equivalent).
 * - SN0 (root network / Stable mechanism): 1:1 TAO↔Alpha, zero pool fee.
 *
 * This backtest does NOT model emission rewards, staking fees, or concentrated
 * liquidity (V3 with user LP positions).
 *
 * Fee model:
 * - Pool fee: 33/65535 ≈ 0.05% on input (matches on-chain default FeeRate)
 * - Fixed transaction fee per trade (TX_FEE_RAO), charged for all operations
 * - Sell → buy rotations pay ONE pool fee (on the sell leg), matching on-chain
 *   `swap_stake` which drops the fee on the destination leg. Buys from pre-
 *   existing free balance pay the fee normally (`add_stake` model).
 *
 * Schedule detection:
 * - Reads the strategy's native schedule via `getBacktestSchedule()`.
 *   Cron schedules are evaluated in UTC against historical block timestamps.
 *   Block-interval schedules use modulo-aligned block numbers.
 * - CLI overrides: `--interval-blocks <n>` or `--cron "<expr>"` force a
 *   specific schedule regardless of strategy config.
 *
 * Usage:
 *   bun backtest -- --strategy <name> [--initial-tao <number>] [--interval-blocks <number>] [--cron "<expr>"] [--observe-gap <blocks>] [--backfill]
 */

import { join } from "node:path";
import { Cron } from "croner";
import { DB_HISTORY_BLOCK_INTERVAL } from "../src/history/constants.ts";
import { openHistoryDatabase } from "../src/history/index.ts";
import {
	alphaFeeInTao,
	alphaNeededForTao,
	swapAlphaForTao,
	swapTaoForAlpha,
} from "../src/rebalance/amm.ts";
import { formatTao, TAO } from "../src/rebalance/tao.ts";
import type { StrategyTarget } from "../src/rebalance/types.ts";
import { loadStrategy, resolveStrategyName } from "../src/strategies/loader.ts";
import type { BacktestSchedule } from "../src/strategies/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const F32 = 1n << 32n;

/** Fixed transaction fee per trade (~0.0012 TAO). Charged for all operations. */
const TX_FEE_RAO = (TAO * 12n) / 10_000n;

const DB_PATH = join("data", "history.sqlite");
const DEFAULT_INITIAL_TAO = 10;

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
const cliObserveGap = process.argv.includes("--observe-gap")
	? parseIntArg("--observe-gap", 0)
	: undefined;

if (cliIntervalBlocks !== undefined && cliCron !== undefined) {
	console.error("Cannot specify both --interval-blocks and --cron");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Optional backfill: only when --backfill is passed
// ---------------------------------------------------------------------------

if (process.argv.includes("--backfill")) {
	const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
	const archiveEndpoints = process.env.ARCHIVE_WS_ENDPOINT?.split(",") ?? [];

	if (!wsEndpoints.length || !archiveEndpoints.length) {
		console.warn(
			"⚠ WS_ENDPOINT or ARCHIVE_WS_ENDPOINT not set — skipping backfill.",
		);
	} else {
		const db0 = openHistoryDatabase(DB_PATH);
		const existingMetas = db0.getBlockMetas();
		db0.close();

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

console.log(
	`\n📊 Backtest: ${strategyName} (AMM-simulated, no emission accrual)`,
);
console.log(
	`   Fee model: constant-product AMM (33/65535 pool fee, one per swap) + ${formatTao(TX_FEE_RAO)} τ tx fee`,
);
console.log(`   SN0: 1:1 conversion, zero pool fee (tx fee still applies)`);
console.log(`   Initial capital: ${initialTao} τ`);
console.log(
	`   Period: block ${firstBlock.blockNumber} → ${lastBlock.blockNumber} (${blockMetas.length} snapshots)`,
);
console.log(`   Rebalance schedule: ${scheduleLabel}`);
console.log();

// ---------------------------------------------------------------------------
// Price helpers
// ---------------------------------------------------------------------------

/** Convert alpha amount → TAO (RAO) using I96F32 spot price (for valuation only) */
function alphaToTao(alpha: bigint, spotPrice: bigint): bigint {
	if (spotPrice <= 0n) return 0n;
	return (alpha * spotPrice) / F32;
}

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

/**
 * Validate and sanitize strategy targets. Warns on violations and normalizes
 * to prevent silent over-allocation from buggy strategies.
 */
function validateTargets(
	targets: StrategyTarget[],
	blockNumber: number,
): StrategyTarget[] {
	if (targets.length === 0) return targets;

	// Check for duplicate netuids
	const seen = new Set<number>();
	const deduped: StrategyTarget[] = [];
	for (const t of targets) {
		if (seen.has(t.netuid)) {
			console.warn(
				`  ⚠ Duplicate target SN${t.netuid} at #${blockNumber} — keeping first occurrence`,
			);
			continue;
		}
		seen.add(t.netuid);
		deduped.push(t);
	}

	// Check for invalid shares
	const valid: StrategyTarget[] = [];
	for (const t of deduped) {
		if (!Number.isFinite(t.share) || t.share < 0) {
			console.warn(
				`  ⚠ Invalid share ${t.share} for SN${t.netuid} at #${blockNumber} — skipping`,
			);
			continue;
		}
		valid.push(t);
	}

	// Check total share
	const totalShare = valid.reduce((sum, t) => sum + t.share, 0);
	if (totalShare > 1.001) {
		console.warn(
			`  ⚠ Target shares sum to ${totalShare.toFixed(4)} at #${blockNumber} — normalizing to 1.0`,
		);
		return valid.map((t) => ({ ...t, share: t.share / totalShare }));
	}

	return valid;
}

// ---------------------------------------------------------------------------
// Virtual portfolio
// ---------------------------------------------------------------------------

interface Position {
	alpha: bigint;
	costBasis: bigint;
}

interface PoolReserves {
	taoIn: bigint;
	alphaIn: bigint;
}

let free: bigint = BigInt(initialTao) * TAO;
const positions: Map<number, Position> = new Map();
let totalTrades = 0;
let totalFeesPaid = 0n;

/**
 * Last-known prices for each subnet — updated every snapshot.
 * Used to value positions in subnets that disappear from later snapshots
 * (delisted, data gaps). Prevents phantom zero-value zombie positions.
 */
const lastKnownPrices: Map<number, bigint> = new Map();

/**
 * Fee-free budget — tracks TAO received from non-SN0 sells within the current
 * rebalance tick. On-chain `swap_stake` charges pool fee on the origin leg only,
 * so buy legs funded by sell proceeds skip the pool fee. SN0 sells do NOT
 * contribute because root→SN swaps charge pool fee on the destination (buy) leg
 * instead.
 *
 * Reset to 0 at the start of each rebalance tick.
 * SN0 buys never consume from this budget (they use a separate path with no
 * pool fee but tx fee still applies).
 */
let feeFreeBudget = 0n;

/**
 * Virtual pool reserves — tracks AMM state within a rebalance tick.
 * Reset from on-chain snapshot at each new block, updated after each trade.
 */
let virtualReserves: Map<number, PoolReserves> = new Map();

function initVirtualReserves(
	snapshots: Array<{ netuid: number; taoIn: bigint; alphaIn: bigint }>,
): void {
	virtualReserves = new Map(
		snapshots.map((s) => [s.netuid, { taoIn: s.taoIn, alphaIn: s.alphaIn }]),
	);
}

function getReserves(netuid: number): PoolReserves {
	return virtualReserves.get(netuid) ?? { taoIn: 0n, alphaIn: 0n };
}

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
	const map = new Map(snapshots.map((s) => [s.netuid, s.spotPrice]));

	// Carry forward last-known prices for held subnets missing from this snapshot
	for (const [netuid] of positions) {
		if (!map.has(netuid)) {
			const lastPrice = lastKnownPrices.get(netuid);
			if (lastPrice && lastPrice > 0n) {
				map.set(netuid, lastPrice);
			}
		}
	}

	return map;
}

/** Update last-known prices from current snapshot */
function updateLastKnownPrices(
	snapshots: Array<{ netuid: number; spotPrice: bigint }>,
): void {
	for (const s of snapshots) {
		if (s.spotPrice > 0n) {
			lastKnownPrices.set(s.netuid, s.spotPrice);
		}
	}
}

// ---------------------------------------------------------------------------
// Trade execution helpers
// ---------------------------------------------------------------------------

function formatTime(timestampMs: number): string {
	return new Date(timestampMs).toISOString().replace("T", " ").slice(0, 19);
}

const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

interface TradeLog {
	side: "sell" | "buy";
	line: string;
}

const tickTrades: TradeLog[] = [];

function formatPnl(pnlPct: number | null): string {
	if (pnlPct === null) return "";
	const sign = pnlPct >= 0 ? "+" : "";
	const color = pnlPct >= 0 ? ANSI_GREEN : ANSI_RED;
	return `  ${color}PnL: ${sign}${pnlPct.toFixed(2)}%${ANSI_RESET}`;
}

function logSell(
	netuid: number,
	subnetName: string,
	taoReceived: bigint,
	pnlPct: number | null,
) {
	tickTrades.push({
		side: "sell",
		line: `  SELL  SN${String(netuid).padEnd(3)} (${subnetName.slice(0, 15).padEnd(15)})  ${formatTao(taoReceived).padStart(10)} τ${formatPnl(pnlPct)}`,
	});
}

function logBuy(netuid: number, subnetName: string, taoSpent: bigint) {
	tickTrades.push({
		side: "buy",
		line: `  BUY   SN${String(netuid).padEnd(3)} (${subnetName.slice(0, 15).padEnd(15)})  ${formatTao(taoSpent).padStart(10)} τ`,
	});
}

function flushTrades(blockNumber: number, timestamp: number) {
	if (tickTrades.length === 0) return;

	const sells = tickTrades.filter((t) => t.side === "sell");
	const buys = tickTrades.filter((t) => t.side === "buy");

	console.log(
		`${ANSI_DIM}── Rebalance  ${formatTime(timestamp)}  #${blockNumber} ──${ANSI_RESET}`,
	);
	for (const s of sells) console.log(s.line);
	if (sells.length > 0 && buys.length > 0) {
		console.log(`  ${ANSI_DIM}  ──→${ANSI_RESET}`);
	}
	for (const b of buys) console.log(b.line);
	console.log();

	tickTrades.length = 0;
}

function sellAll(
	netuid: number,
	_spotPrice: bigint,
	_blockNumber: number,
	_timestamp: number,
	subnetName: string,
) {
	const pos = positions.get(netuid);
	if (!pos || pos.alpha <= 0n) return;

	const isSN0 = netuid === 0;
	const reserves = getReserves(netuid);
	const swap = swapAlphaForTao(
		pos.alpha,
		reserves.taoIn,
		reserves.alphaIn,
		netuid,
	);
	// Fee accounting: on sells, the pool fee is denominated in alpha (the input).
	// We use the output-delta method (taoOut_noFee − taoOut_withFee) to express it
	// in TAO, which is more accurate than converting alpha fees via spot price.
	// The buy side tracks swap.poolFee directly (already in TAO for the input token).
	const feeInTao = isSN0
		? 0n
		: alphaFeeInTao(pos.alpha, reserves.taoIn, reserves.alphaIn, netuid);
	const txFee = TX_FEE_RAO;
	const taoReceived = swap.amountOut - txFee;
	if (taoReceived <= 0n) return;

	// Update virtual reserves (fee not added — goes to block author)
	if (!isSN0) {
		const netAlpha = pos.alpha - swap.poolFee;
		reserves.alphaIn += netAlpha;
		reserves.taoIn -= swap.amountOut;
	}

	const pnlPct =
		pos.costBasis > 0n
			? Number(((taoReceived - pos.costBasis) * 10000n) / pos.costBasis) / 100
			: null;

	free += taoReceived;
	totalFeesPaid += feeInTao + txFee;
	// Non-SN0 sell proceeds are fee-free for subsequent buys (swap_stake model)
	if (!isSN0) feeFreeBudget += taoReceived;
	logSell(netuid, subnetName, taoReceived, pnlPct);
	positions.delete(netuid);
	totalTrades++;
}

function sellPartial(
	netuid: number,
	taoAmount: bigint,
	_spotPrice: bigint,
	_blockNumber: number,
	_timestamp: number,
	subnetName: string,
) {
	const pos = positions.get(netuid);
	if (!pos || pos.alpha <= 0n) return;

	const isSN0 = netuid === 0;
	const reserves = getReserves(netuid);

	// Use inverse formula to find exact alpha needed for target TAO output
	let alphaToSell: bigint;
	const needed = alphaNeededForTao(
		taoAmount,
		reserves.taoIn,
		reserves.alphaIn,
		netuid,
	);
	if (needed === null) {
		// Target exceeds pool reserves — sell everything
		alphaToSell = pos.alpha;
	} else {
		alphaToSell = needed > pos.alpha ? pos.alpha : needed;
	}

	if (alphaToSell <= 0n) return;

	const swap = swapAlphaForTao(
		alphaToSell,
		reserves.taoIn,
		reserves.alphaIn,
		netuid,
	);
	// Fee accounting: output-delta method for alpha→TAO fee (see sellAll comment)
	const feeInTao = isSN0
		? 0n
		: alphaFeeInTao(alphaToSell, reserves.taoIn, reserves.alphaIn, netuid);
	const txFee = TX_FEE_RAO;
	const taoReceived = swap.amountOut - txFee;
	if (taoReceived <= 0n) return;

	// Update virtual reserves
	if (!isSN0) {
		const netAlpha = alphaToSell - swap.poolFee;
		reserves.alphaIn += netAlpha;
		reserves.taoIn -= swap.amountOut;
	}

	// Compute proportional cost basis and PnL before modifying position
	const proportionalCostBasis =
		pos.alpha > 0n ? (pos.costBasis * alphaToSell) / pos.alpha : 0n;
	const pnlPct =
		proportionalCostBasis > 0n
			? Number(
					((taoReceived - proportionalCostBasis) * 10000n) /
						proportionalCostBasis,
				) / 100
			: null;

	pos.alpha -= alphaToSell;
	pos.costBasis -= proportionalCostBasis;
	free += taoReceived;
	totalFeesPaid += feeInTao + txFee;
	// Non-SN0 sell proceeds are fee-free for subsequent buys (swap_stake model)
	if (!isSN0) feeFreeBudget += taoReceived;
	if (pos.alpha <= 0n) positions.delete(netuid);
	logSell(netuid, subnetName, taoReceived, pnlPct);
	totalTrades++;
}

function buy(
	netuid: number,
	taoAmount: bigint,
	_spotPrice: bigint,
	_blockNumber: number,
	_timestamp: number,
	subnetName: string,
) {
	if (taoAmount <= 0n) return;
	const actual = taoAmount > free ? free : taoAmount;
	if (actual <= 0n) return;

	const isSN0 = netuid === 0;
	const reserves = getReserves(netuid);

	// SN0: zero pool fee (stable 1:1 swap), but tx fee still applies.
	// Never consumes fee-free budget.
	if (isSN0) {
		const txFee = TX_FEE_RAO;
		const netTao = actual - txFee;
		if (netTao <= 0n) return;
		const swap = swapTaoForAlpha(netTao, reserves.taoIn, reserves.alphaIn, 0);
		if (swap.amountOut <= 0n) return;
		free -= actual;
		totalFeesPaid += txFee;
		const pos = positions.get(0) ?? { alpha: 0n, costBasis: 0n };
		pos.alpha += swap.amountOut;
		pos.costBasis += actual;
		positions.set(0, pos);
		logBuy(0, subnetName, actual);
		totalTrades++;
		return;
	}

	// Determine fee-free portion from sell proceeds (swap_stake destination leg).
	// On-chain swap_stake charges pool fee + tx fee on the origin leg only;
	// the destination leg swaps fee-free.
	const feeFreeAmount = actual < feeFreeBudget ? actual : feeFreeBudget;
	const feeChargedAmount = actual - feeFreeAmount;
	feeFreeBudget -= feeFreeAmount;

	let totalAlphaOut = 0n;

	// Fee-free portion: no pool fee, no tx fee (swap_stake destination leg)
	if (feeFreeAmount > 0n) {
		const swap = swapTaoForAlpha(
			feeFreeAmount,
			reserves.taoIn,
			reserves.alphaIn,
			netuid,
			true,
		);
		totalAlphaOut += swap.amountOut;
		// Full amount enters pool (no fee deducted)
		reserves.taoIn += feeFreeAmount;
		reserves.alphaIn -= swap.amountOut;
	}

	// Fee-charged portion: pool fee + tx fee (add_stake from free balance)
	if (feeChargedAmount > 0n) {
		const txFee = TX_FEE_RAO;
		const netTao = feeChargedAmount - txFee;
		if (netTao > 0n) {
			const swap = swapTaoForAlpha(
				netTao,
				reserves.taoIn,
				reserves.alphaIn,
				netuid,
			);
			totalAlphaOut += swap.amountOut;
			reserves.taoIn += netTao - swap.poolFee;
			reserves.alphaIn -= swap.amountOut;
			totalFeesPaid += swap.poolFee + txFee;
		}
	}

	if (totalAlphaOut <= 0n) return;

	free -= actual;
	const pos = positions.get(netuid) ?? { alpha: 0n, costBasis: 0n };
	pos.alpha += totalAlphaOut;
	pos.costBasis += actual;
	positions.set(netuid, pos);
	logBuy(netuid, subnetName, actual);
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

		// Fire! Advance nextScheduledAt past the current timestamp to coalesce
		// missed ticks after DB gaps into a single rebalance. Without this,
		// a multi-day gap would produce rapid-fire rebalances (one per snapshot)
		// burning unrealistic fees.
		let next = cron.nextRun(nextScheduledAt);
		while (next && next.getTime() <= timestamp) {
			next = cron.nextRun(next);
		}
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

// Model realistic execution latency: after any rebalance, block observe-triggered
// rebalances for a minimum gap. Matches the live runner's inflightRun guard which
// prevents concurrent rebalance cycles. Pending observe triggers are deferred and
// execute as soon as the gap expires.
const observeGap = cliObserveGap ?? schedule.minObserveRebalanceGapBlocks ?? 0;
let lastRebalanceBlock = 0;
let pendingObserveRebalance = false;

for (const meta of blockMetas) {
	const snapshots = db.getSnapshotsAtBlock(meta.blockNumber);
	if (snapshots.length === 0) continue;

	// Track prices for all observed subnets (carry-forward for missing data)
	updateLastKnownPrices(snapshots);

	const heldNetuids = getHeldNetuids();
	const isScheduled = shouldRebalance(meta.blockNumber, meta.timestamp);
	const gapExpired =
		observeGap <= 0 || meta.blockNumber - lastRebalanceBlock >= observeGap;

	if (!isScheduled) {
		const result = strategy.observe(
			snapshots,
			meta.blockNumber,
			meta.timestamp,
			heldNetuids,
		);
		if (result.needsRebalance) {
			pendingObserveRebalance = true;
		}
		// Execute pending observe-triggered rebalance only after gap expires
		if (!pendingObserveRebalance || !gapExpired) continue;
		pendingObserveRebalance = false;
		// Fall through to immediate rebalance
	}

	// Rebalance tick
	const { targets: rawTargets } = strategy.step(
		snapshots,
		meta.blockNumber,
		meta.timestamp,
		heldNetuids,
	);
	const targets = validateTargets(rawTargets, meta.blockNumber);

	const priceMap = buildPriceMap(snapshots);
	const nameMap = new Map(snapshots.map((s) => [s.netuid, s.name]));
	const snapshotNetuids = new Set(snapshots.map((s) => s.netuid));

	// Warn about held positions missing from this snapshot (delisted/data gap).
	// These positions are valued using last-known prices (via buildPriceMap)
	// but cannot be traded since we have no pool reserves for them.
	for (const netuid of heldNetuids) {
		if (!snapshotNetuids.has(netuid)) {
			const lastPrice = lastKnownPrices.get(netuid);
			console.warn(
				`  ⚠ SN${netuid} missing from snapshot at #${meta.blockNumber}` +
					` — position frozen (last price: ${lastPrice ? formatTao(alphaToTao(1n * TAO, lastPrice)) : "unknown"} τ/α)`,
			);
		}
	}

	const totalValue = portfolioValue(priceMap);

	// Initialize virtual reserves from this block's on-chain snapshot.
	// Reserves are updated after each trade within this rebalance tick.
	initVirtualReserves(snapshots);
	// Reset fee-free budget for this tick (accumulates from sells)
	feeFreeBudget = 0n;

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

	// 2. Compute diffs, execute all sells first, then buys
	const diffs: Array<{
		netuid: number;
		diff: bigint;
		price: bigint;
		name: string;
	}> = [];
	for (const target of targets) {
		const price = priceMap.get(target.netuid) ?? 0n;
		const targetTao =
			(totalValue * BigInt(Math.round(target.share * 1e9))) / 1_000_000_000n;
		const currentPos = positions.get(target.netuid);
		const currentTao = currentPos ? alphaToTao(currentPos.alpha, price) : 0n;
		diffs.push({
			netuid: target.netuid,
			diff: targetTao - currentTao,
			price,
			name: nameMap.get(target.netuid) ?? "?",
		});
	}

	const MIN_TRADE = TAO / 100n;

	// Sells first — free up capital
	for (const { netuid, diff, price, name } of diffs) {
		if (diff < -MIN_TRADE) {
			sellPartial(netuid, -diff, price, meta.blockNumber, meta.timestamp, name);
		}
	}

	// Then buys — use freed capital
	// Snapshot pre-buy state to compute effective fill prices after execution
	const preBuyAlpha = new Map<number, bigint>();
	for (const { netuid, diff } of diffs) {
		if (diff > MIN_TRADE) {
			preBuyAlpha.set(netuid, positions.get(netuid)?.alpha ?? 0n);
		}
	}

	for (const { netuid, diff, price, name } of diffs) {
		if (diff > MIN_TRADE) {
			buy(netuid, diff, price, meta.blockNumber, meta.timestamp, name);
		}
	}

	// Compute effective fill prices for buys this tick (I96F32 scale).
	// fillPrice = costBasis × 2^32 / alpha — accounts for AMM slippage.
	const fillPrices = new Map<number, bigint>();
	for (const [netuid, prevAlpha] of preBuyAlpha) {
		const pos = positions.get(netuid);
		if (!pos || pos.alpha <= prevAlpha) continue;
		const boughtAlpha = pos.alpha - prevAlpha;
		if (boughtAlpha > 0n) {
			// Proportional cost basis for just the new alpha
			const totalCost = pos.costBasis;
			const prevCostBasis =
				prevAlpha > 0n && pos.alpha > 0n
					? (totalCost * prevAlpha) / pos.alpha
					: 0n;
			const buyCost = totalCost - prevCostBasis;
			if (buyCost > 0n) {
				fillPrices.set(netuid, (buyCost * F32) / boughtAlpha);
			}
		}
	}

	// Post-trade hook: let strategy update state for newly opened positions
	strategy.afterRebalance?.(snapshots, meta.blockNumber, getHeldNetuids(), {
		fillPrices,
	});

	flushTrades(meta.blockNumber, meta.timestamp);
	rebalanceCount++;
	lastRebalanceBlock = meta.blockNumber;
	pendingObserveRebalance = false;
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
console.log("  BACKTEST SUMMARY (AMM-simulated, no emission accrual)");
console.log("═".repeat(60));
console.log(`  Strategy:         ${strategyName}`);
console.log(`  Schedule:         ${scheduleLabel}`);
if (observeGap > 0) {
	console.log(`  Observe gap:      ${observeGap} blocks`);
}
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

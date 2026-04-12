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
 * This backtest models emission accrual using a simplified drip model:
 * - Uses `alpha_out_emission` from DynamicInfo (per-block alpha minted)
 * - Applies owner cut (9%), 50/50 miner/validator split, validator take (12%)
 * - Root staking (SN0) positions earn dividends from all subnets (Swap claim)
 * - Accrual happens at every snapshot (25 blocks ≈ 5 min)
 *
 * Limitations:
 * - Does NOT model full Yuma consensus (~85-90% accuracy vs on-chain)
 * - Does NOT model staking fees or concentrated liquidity (V3 user LP)
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
 *   bun backtest -- --strategy <name> [--days <number>] [--initial-tao <number>] [--interval-blocks <number>] [--cron "<expr>"] [--observe-gap <blocks>] [--backfill]
 */

import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import type { EquitySample, TradeResult } from "../src/backtest/metrics.ts";
import {
	computeMetrics,
	formatMetricsJson,
	formatMetricsMarkdown,
	formatMetricsSummary,
} from "../src/backtest/metrics.ts";
import { DB_HISTORY_BLOCK_INTERVAL } from "../src/history/constants.ts";
import {
	assertEmissionData,
	openHistoryDatabase,
} from "../src/history/index.ts";
import type { SubnetSnapshot } from "../src/history/types.ts";
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
import { GIT_COMMIT } from "../src/version.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const F32 = 1n << 32n;

/** Fixed transaction fee per trade (~0.0012 TAO). Charged for all operations. */
const TX_FEE_RAO = (TAO * 12n) / 10_000n;

const DB_PATH = join("data", "history.sqlite");
const DEFAULT_INITIAL_TAO = 10;

// ---------------------------------------------------------------------------
// Emission model constants (hardcoded realistic defaults)
// ---------------------------------------------------------------------------

/** Subnet owner cut percentage — deducted before miner/validator split */
const OWNER_CUT_PCT = 9n;
/** Validator take percentage — deducted from validator dividends before delegators */
const VALIDATOR_TAKE_PCT = 12n;
/**
 * TAO weight — multiplier for root TAO stake when computing root proportion.
 * On-chain TaoWeight is ~0.18. We use 18/100 for bigint math.
 */
const TAO_WEIGHT_NUM = 18n;
const TAO_WEIGHT_DENOM = 100n;

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
const cliDays = process.argv.includes("--days")
	? parseIntArg("--days", 0)
	: undefined;
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
assertEmissionData(db);
let blockMetas = db.getBlockMetas();

// Apply --days filter: keep only snapshots within the last N days
if (cliDays !== undefined) {
	const lastTimestamp = blockMetas[blockMetas.length - 1]?.timestamp ?? 0;
	const cutoff = lastTimestamp - cliDays * 86_400_000;
	blockMetas = blockMetas.filter((m) => m.timestamp >= cutoff);
}

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

console.log(
	`\n📊 Backtest: ${strategyName} (AMM-simulated, with emission accrual)`,
);
console.log(`   Initial capital: ${initialTao} τ`);
console.log(
	`   Period: block ${firstBlock.blockNumber} → ${lastBlock.blockNumber} (${blockMetas.length} snapshots)`,
);
console.log();

// ---------------------------------------------------------------------------
// Markdown report accumulator
// ---------------------------------------------------------------------------

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const reportPath = join("reports", `backtest-${strategyName}-${ts}.md`);
const reportLines: string[] = [
	`# Backtest Report`,
	``,
	`> Generated ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC — strategy: \`${strategyName}\` — commit: \`${GIT_COMMIT}\``,
	``,
	`| Parameter | Value |`,
	`| --- | --- |`,
	`| Initial capital | ${initialTao} τ |`,
	`| Period | block ${firstBlock.blockNumber} → ${lastBlock.blockNumber} (${blockMetas.length} snapshots) |`,
	``,
	`## Operations`,
	``,
];

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

// ---------------------------------------------------------------------------
// Metrics tracking — equity curve, trade results, HODL benchmark
// ---------------------------------------------------------------------------

const equityCurve: EquitySample[] = [];
const tradeResults: TradeResult[] = [];

/**
 * HODL benchmark: what if all capital sat in SN0 collecting root emissions?
 * Tracked as a virtual alpha balance (SN0 is 1:1 stable mechanism).
 */
let hodlSn0Alpha: bigint = BigInt(initialTao) * TAO;
let hodlLastAccrualBlock = 0;
const hodlEquityCurve: EquitySample[] = [];

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

	// SN0 (Stable mechanism) is always 1:1 with TAO — force to F32 regardless
	// of what the DB contains (reserve ratio drifts from 1.0 due to emissions/fees
	// but actual trades are always 1:1).
	map.set(0, F32);

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
			// SN0 always 1:1 — don't carry forward a drifted reserve-ratio price
			lastKnownPrices.set(s.netuid, s.netuid === 0 ? F32 : s.spotPrice);
		}
	}
}

// ---------------------------------------------------------------------------
// Emission accrual
// ---------------------------------------------------------------------------

let totalEmissionsAccruedRao = 0n;
let lastAccrualBlock = 0;

/**
 * Accrue alpha emissions for non-SN0 positions.
 *
 * For each held alpha position on subnet i (skip SN0):
 *   validatorAlphaPerBlock = alphaOutEmission × (1 − ownerCut) × 0.5
 *   rootProp = (sn0TaoIn × taoWeight) / (sn0TaoIn × taoWeight + alphaOut)
 *   alphaStakerPerBlock = validatorAlphaPerBlock × (1 − rootProp)
 *   ourShare = alphaStakerPerBlock × (posAlpha / alphaOut)
 *   netEmission = ourShare × (1 − validatorTake)
 *   accrued = netEmission × blockDelta
 *   position.alpha += accrued
 *
 * Returns TAO-equivalent of accrued emissions (for reporting).
 */
function accrueAlphaEmissions(
	snapshots: SubnetSnapshot[],
	blockDelta: number,
	priceMap: Map<number, bigint>,
): bigint {
	if (blockDelta <= 0) return 0n;
	const delta = BigInt(blockDelta);

	const sn0 = snapshots.find((s) => s.netuid === 0);
	const sn0TaoIn = sn0?.taoIn ?? 0n;

	let totalTaoEquiv = 0n;

	for (const [netuid, pos] of positions) {
		if (netuid === 0 || pos.alpha <= 0n) continue;

		const snap = snapshots.find((s) => s.netuid === netuid);
		if (!snap || snap.alphaOutEmission <= 0n || snap.alphaOut <= 0n) continue;

		// validatorAlphaPerBlock = alphaOutEmission × (100 − ownerCut) / 100 × 0.5
		const afterOwnerCut =
			(snap.alphaOutEmission * (100n - OWNER_CUT_PCT)) / 100n;
		const validatorAlphaPerBlock = afterOwnerCut / 2n;

		// rootProp = (sn0TaoIn × taoWeight) / (sn0TaoIn × taoWeight + alphaOut)
		const weightedRoot = (sn0TaoIn * TAO_WEIGHT_NUM) / TAO_WEIGHT_DENOM;
		const rootDenom = weightedRoot + snap.alphaOut;
		// alphaStakerPerBlock = validatorAlphaPerBlock × (1 − rootProp)
		//                     = validatorAlphaPerBlock × alphaOut / rootDenom
		const alphaStakerPerBlock =
			rootDenom > 0n
				? (validatorAlphaPerBlock * snap.alphaOut) / rootDenom
				: validatorAlphaPerBlock;

		// ourShare = alphaStakerPerBlock × (posAlpha / alphaOut)
		const ourShare = (alphaStakerPerBlock * pos.alpha) / snap.alphaOut;

		// netEmission = ourShare × (1 − validatorTake)
		const netEmission = (ourShare * (100n - VALIDATOR_TAKE_PCT)) / 100n;

		const accrued = netEmission * delta;
		if (accrued > 0n) {
			pos.alpha += accrued;
			const price = priceMap.get(netuid) ?? 0n;
			totalTaoEquiv += price > 0n ? (accrued * price) / F32 : 0n;
		}
	}

	return totalTaoEquiv;
}

/**
 * Accrue root (SN0) emissions.
 *
 * SN0 stakers earn a share of every other subnet's emissions proportional
 * to root proportion and their share of total root stake. Modeled as Swap
 * claim type (alpha → TAO at spot price).
 *
 * For SN0 position, for each other subnet j:
 *   rootAlphaPerBlock = alphaOutEmission_j × (1 − ownerCut) × 0.5 × rootProp_j
 *   ourRootDiv = rootAlphaPerBlock × (sn0Pos.alpha / sn0TaoIn)
 *   afterTake = ourRootDiv × (1 − validatorTake)
 *   taoEquiv = afterTake × spotPrice_j / F32   (Swap claim type)
 *   totalTaoAccrued += taoEquiv
 *
 * SN0's "alpha" is denominated in TAO (1:1 stable mechanism), so adding
 * TAO-equivalent directly to sn0Pos.alpha is correct.
 *
 * Root sell flag: skip accrual when sum of moving prices ≤ 1.0 (F32),
 * matching on-chain behavior where root divs are recycled.
 */
function accrueRootEmissions(
	snapshots: SubnetSnapshot[],
	blockDelta: number,
	priceMap: Map<number, bigint>,
): bigint {
	if (blockDelta <= 0) return 0n;

	const sn0Pos = positions.get(0);
	if (!sn0Pos || sn0Pos.alpha <= 0n) return 0n;

	const sn0 = snapshots.find((s) => s.netuid === 0);
	const sn0TaoIn = sn0?.taoIn ?? 0n;
	if (sn0TaoIn <= 0n) return 0n;

	// Root sell flag: if sum of all moving prices ≤ 1.0 (F32), skip
	let movingPriceSum = 0n;
	for (const s of snapshots) {
		if (s.netuid !== 0) movingPriceSum += s.movingPrice;
	}
	if (movingPriceSum <= F32) return 0n;

	const delta = BigInt(blockDelta);
	let totalTaoAccrued = 0n;

	for (const snap of snapshots) {
		if (snap.netuid === 0 || snap.alphaOutEmission <= 0n || snap.alphaOut <= 0n)
			continue;

		// validatorAlphaPerBlock = alphaOutEmission × (100 − ownerCut) / 100 × 0.5
		const afterOwnerCut =
			(snap.alphaOutEmission * (100n - OWNER_CUT_PCT)) / 100n;
		const validatorAlphaPerBlock = afterOwnerCut / 2n;

		// rootProp = (sn0TaoIn × taoWeight) / (sn0TaoIn × taoWeight + alphaOut)
		const weightedRoot = (sn0TaoIn * TAO_WEIGHT_NUM) / TAO_WEIGHT_DENOM;
		const rootDenom = weightedRoot + snap.alphaOut;
		if (rootDenom <= 0n) continue;

		// rootAlphaPerBlock = validatorAlphaPerBlock × rootProp
		//                   = validatorAlphaPerBlock × weightedRoot / rootDenom
		const rootAlphaPerBlock =
			(validatorAlphaPerBlock * weightedRoot) / rootDenom;

		// ourRootDiv = rootAlphaPerBlock × (sn0Pos.alpha / sn0TaoIn)
		const ourRootDiv = (rootAlphaPerBlock * sn0Pos.alpha) / sn0TaoIn;

		// afterTake = ourRootDiv × (1 − validatorTake)
		const afterTake = (ourRootDiv * (100n - VALIDATOR_TAKE_PCT)) / 100n;

		// Swap claim type: convert alpha to TAO at spot price
		const price = priceMap.get(snap.netuid) ?? 0n;
		if (price <= 0n) continue;

		const taoEquiv = (afterTake * price) / F32;
		totalTaoAccrued += taoEquiv;
	}

	const totalAccrued = totalTaoAccrued * delta;
	if (totalAccrued > 0n) {
		sn0Pos.alpha += totalAccrued;
	}

	return totalAccrued;
}

// ---------------------------------------------------------------------------
// Trade execution helpers
// ---------------------------------------------------------------------------

function formatTime(timestampMs: number): string {
	return new Date(timestampMs).toISOString().replace("T", " ").slice(0, 19);
}

interface TradeLog {
	side: "sell" | "buy";
	mdLine: string;
}

const tickTrades: TradeLog[] = [];
let tickTxFees = 0n;

function formatPnlMd(pnlPct: number | null): string {
	if (pnlPct === null) return "";
	const sign = pnlPct >= 0 ? "+" : "";
	return ` (${sign}${pnlPct.toFixed(2)}%)`;
}

function logSell(
	netuid: number,
	subnetName: string,
	taoReceived: bigint,
	pnlPct: number | null,
) {
	tickTrades.push({
		side: "sell",
		mdLine: `| SELL | SN${netuid} ${subnetName.slice(0, 15)} | ${formatTao(taoReceived)} τ${formatPnlMd(pnlPct)} |`,
	});
}

function logBuy(netuid: number, subnetName: string, taoSpent: bigint) {
	tickTrades.push({
		side: "buy",
		mdLine: `| BUY | SN${netuid} ${subnetName.slice(0, 15)} | ${formatTao(taoSpent)} τ |`,
	});
}

function flushTrades(blockNumber: number, timestamp: number) {
	if (tickTrades.length === 0) return;

	const sells = tickTrades.filter((t) => t.side === "sell");
	const buys = tickTrades.filter((t) => t.side === "buy");

	reportLines.push(
		`### Rebalance — ${formatTime(timestamp)} — #${blockNumber}`,
	);
	reportLines.push("");
	if (sells.length > 0 || buys.length > 0) {
		reportLines.push("| Side | Subnet | Amount |");
		reportLines.push("| --- | --- | --- |");
		for (const s of sells) reportLines.push(s.mdLine);
		for (const b of buys) reportLines.push(b.mdLine);
		reportLines.push("");
	}
	reportLines.push(`> tx fees: ${formatTao(tickTxFees)} τ`);
	reportLines.push("");

	tickTrades.length = 0;
	tickTxFees = 0n;
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
	tickTxFees += txFee;
	// Non-SN0 sell proceeds are fee-free for subsequent buys (swap_stake model)
	if (!isSN0) feeFreeBudget += taoReceived;
	// Track realized trade result for metrics
	tradeResults.push({
		pnlAbsolute: Number(taoReceived - pos.costBasis) / Number(TAO),
	});
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
	tickTxFees += txFee;
	// Non-SN0 sell proceeds are fee-free for subsequent buys (swap_stake model)
	if (!isSN0) feeFreeBudget += taoReceived;
	// Track realized trade result for metrics
	tradeResults.push({
		pnlAbsolute: Number(taoReceived - proportionalCostBasis) / Number(TAO),
	});
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
		tickTxFees += txFee;
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
			tickTxFees += txFee;
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
	// Always trigger on the very first call — models the initial deployment
	// rebalance (`bun rebalance`) that positions the portfolio before the
	// scheduler takes over with cron / block-interval ticks.
	let isFirstCall = true;

	if (sched.type === "block-interval") {
		const interval = sched.intervalBlocks;
		return (blockNumber) => {
			if (isFirstCall) {
				isFirstCall = false;
				return true;
			}
			return blockNumber % interval === 0;
		};
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
		if (isFirstCall) {
			isFirstCall = false;
			return true;
		}
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

	// --- Emission accrual (every snapshot, not just rebalance ticks) ---
	const blockDelta =
		lastAccrualBlock > 0 ? meta.blockNumber - lastAccrualBlock : 0;
	if (blockDelta > 0 && positions.size > 0) {
		const emissionPriceMap = buildPriceMap(snapshots);
		const alphaEmTao = accrueAlphaEmissions(
			snapshots,
			blockDelta,
			emissionPriceMap,
		);
		const rootEmTao = accrueRootEmissions(
			snapshots,
			blockDelta,
			emissionPriceMap,
		);
		totalEmissionsAccruedRao += alphaEmTao + rootEmTao;
	}
	lastAccrualBlock = meta.blockNumber;

	// --- HODL benchmark emission accrual (SN0 root dividends) ---
	const hodlBlockDelta =
		hodlLastAccrualBlock > 0 ? meta.blockNumber - hodlLastAccrualBlock : 0;
	if (hodlBlockDelta > 0 && hodlSn0Alpha > 0n) {
		const sn0 = snapshots.find((s) => s.netuid === 0);
		const sn0TaoIn = sn0?.taoIn ?? 0n;
		if (sn0TaoIn > 0n) {
			let movingPriceSum = 0n;
			for (const s of snapshots) {
				if (s.netuid !== 0) movingPriceSum += s.movingPrice;
			}
			if (movingPriceSum > F32) {
				const delta = BigInt(hodlBlockDelta);
				let hodlRootAccrued = 0n;
				for (const snap of snapshots) {
					if (
						snap.netuid === 0 ||
						snap.alphaOutEmission <= 0n ||
						snap.alphaOut <= 0n
					)
						continue;
					const afterOwnerCut =
						(snap.alphaOutEmission * (100n - OWNER_CUT_PCT)) / 100n;
					const validatorAlphaPerBlock = afterOwnerCut / 2n;
					const weightedRoot = (sn0TaoIn * TAO_WEIGHT_NUM) / TAO_WEIGHT_DENOM;
					const rootDenom = weightedRoot + snap.alphaOut;
					if (rootDenom <= 0n) continue;
					const rootAlphaPerBlock =
						(validatorAlphaPerBlock * weightedRoot) / rootDenom;
					const ourRootDiv = (rootAlphaPerBlock * hodlSn0Alpha) / sn0TaoIn;
					const afterTake = (ourRootDiv * (100n - VALIDATOR_TAKE_PCT)) / 100n;
					const price =
						snapshots.find((ss) => ss.netuid === snap.netuid)?.spotPrice ?? 0n;
					if (price <= 0n) continue;
					hodlRootAccrued += (afterTake * price) / F32;
				}
				hodlSn0Alpha += hodlRootAccrued * delta;
			}
		}
	}
	hodlLastAccrualBlock = meta.blockNumber;

	// --- Record equity curve + HODL benchmark at every snapshot ---
	{
		const snapPriceMap = buildPriceMap(snapshots);
		const strategyValue = Number(portfolioValue(snapPriceMap)) / Number(TAO);
		equityCurve.push({ timestamp: meta.timestamp, value: strategyValue });
		hodlEquityCurve.push({
			timestamp: meta.timestamp,
			value: Number(hodlSn0Alpha) / Number(TAO),
		});
	}

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

// ---------------------------------------------------------------------------
// Unrealised PnL + final positions (markdown report)
// ---------------------------------------------------------------------------

if (positions.size > 0) {
	reportLines.push("## Unrealised PnL");
	reportLines.push("");
	reportLines.push("| Subnet | Cost | Value | PnL |");
	reportLines.push("| --- | --- | --- | --- |");
	for (const [netuid, pos] of positions) {
		const price = finalPriceMap.get(netuid) ?? 0n;
		const taoVal = alphaToTao(pos.alpha, price);
		const pnlRaoPos = taoVal - pos.costBasis;
		const pnlPctPos =
			pos.costBasis > 0n
				? Number((pnlRaoPos * 10000n) / pos.costBasis) / 100
				: 0;
		const name = finalSnapshots.find((s) => s.netuid === netuid)?.name ?? "?";
		const sign = pnlPctPos >= 0 ? "+" : "";
		reportLines.push(
			`| SN${netuid} ${name.slice(0, 15)} | ${formatTao(pos.costBasis)} τ | ${formatTao(taoVal)} τ | ${sign}${pnlPctPos.toFixed(2)}% |`,
		);
	}
	reportLines.push("");
}

if (positions.size > 0) {
	reportLines.push("## Final Positions");
	reportLines.push("");
	reportLines.push("| Subnet | Value |");
	reportLines.push("| --- | --- |");
	for (const [netuid, pos] of positions) {
		const price = finalPriceMap.get(netuid) ?? 0n;
		const taoVal = alphaToTao(pos.alpha, price);
		const name = finalSnapshots.find((s) => s.netuid === netuid)?.name ?? "?";
		reportLines.push(
			`| SN${netuid} ${name.slice(0, 15)} | ${formatTao(taoVal)} τ |`,
		);
	}
	if (free > 0n) {
		reportLines.push(`| Free TAO | ${formatTao(free)} τ |`);
	}
	reportLines.push("");
}

// ---------------------------------------------------------------------------
// Compute metrics + write report + print summary
// ---------------------------------------------------------------------------

const pnlRao = finalValue - initialValue;
const pnlPct = Number((pnlRao * 10000n) / initialValue) / 100;
const durationMs = lastBlock.timestamp - firstBlock.timestamp;
const durationDays = durationMs / (86_400 * 1000);

const tradePnl = pnlRao - totalEmissionsAccruedRao;

const metrics = computeMetrics(equityCurve, tradeResults);
const hodlMetrics = computeMetrics(hodlEquityCurve, []);

const scheduleLabel =
	schedule.type === "cron"
		? `cron "${schedule.cronSchedule}" (UTC)`
		: `every ${schedule.intervalBlocks} blocks`;

const gitBranch = (() => {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return undefined;
	}
})();

const metricsExtra = {
	strategyName,
	durationDays,
	rebalanceCount,
	totalTrades,
	totalFeesTao: formatTao(totalFeesPaid),
	initialTao: formatTao(initialValue),
	finalTao: formatTao(finalValue),
	pnlTao: `${pnlRao >= 0n ? "+" : ""}${formatTao(pnlRao)}`,
	pnlPct,
	tradePnlTao: `${tradePnl >= 0n ? "+" : ""}${formatTao(tradePnl)}`,
	emissionPnlTao: `+${formatTao(totalEmissionsAccruedRao)}`,
	hodlReturnPct: hodlMetrics.totalReturnPct,
	hodlCagr: hodlMetrics.cagr,
	equityCurve,
	hodlEquityCurve,
	gitCommit: GIT_COMMIT,
	gitBranch,
	strategyConfigPath: `src/strategies/${strategyName}/config.yaml`,
	schedule: scheduleLabel,
	blockRange: {
		first: firstBlock.blockNumber,
		last: lastBlock.blockNumber,
		snapshots: blockMetas.length,
	},
};

reportLines.push(formatMetricsMarkdown(metrics, metricsExtra));
reportLines.push(formatMetricsJson(metrics, metricsExtra));

await mkdir("reports", { recursive: true });
await writeFile(reportPath, reportLines.join("\n"));

const summary = formatMetricsSummary(metrics, metricsExtra);
console.log(summary);
console.log(`  📄 Full report: ${reportPath}`);
console.log();

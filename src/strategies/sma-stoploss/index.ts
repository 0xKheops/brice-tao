import { dirname, join } from "node:path";
import { bittensor } from "@polkadot-api/descriptors";
import type { PolkadotClient, TypedApi } from "polkadot-api";
import type { Balances } from "../../balances/getBalances.ts";
import type { Env } from "../../config/env.ts";
import { log } from "../../rebalance/logger.ts";
import { formatTao } from "../../rebalance/tao.ts";
import type { StrategyTarget } from "../../rebalance/types.ts";
import { resolveValidators } from "../../validators/index.ts";
import type { AuditSections, StrategyResult } from "../types.ts";
import { loadSmaStoplossConfig } from "./config.ts";
import { openPriceDatabase } from "./db.ts";
import { fetchAllSubnetData } from "./fetchSubnetData.ts";
import { type SubnetEvaluation, scoreSubnets } from "./scoreSubnets.ts";
import type {
	SharedState,
	SmaStoplossStrategyConfig,
	StopOutRecord,
	SubnetPriceHistory,
} from "./types.ts";

type Api = TypedApi<typeof bittensor>;

const metaDir = new URL(".", import.meta.url).pathname;
const CONFIG_PATH = metaDir.startsWith("/$bunfs")
	? join(
			dirname(process.execPath),
			"src",
			"strategies",
			"sma-stoploss",
			"config.yaml",
		)
	: new URL("./config.yaml", import.meta.url).pathname;

// Shared state — set by the runner, read by getStrategyTargets.
// This allows the runner to communicate price histories and stop-loss state
// to the strategy function without the strategy touching the DB.
let sharedState: SharedState | null = null;

/** Called by the runner to share its state with getStrategyTargets */
export function setSharedState(state: SharedState): void {
	sharedState = state;
}

const DB_PATH = join("data", "sma-stoploss.sqlite");

/**
 * Hydrate shared state from the SQLite DB so that preview/dry-run gets
 * accurate indicator and stop-loss data without a running scheduler.
 */
export async function preparePreview(): Promise<void> {
	const db = openPriceDatabase(DB_PATH);
	try {
		const priceHistories = db.getAllPriceHistories();
		const stoppedOut = new Map(db.getAllStoppedOut().map((r) => [r.netuid, r]));
		sharedState = { priceHistories, stoppedOut };
		log.info(
			`Preview: loaded ${priceHistories.size} subnet histories, ${stoppedOut.size} stopped-out from DB`,
		);
	} finally {
		db.close();
	}
}

/** Get the current config path (for runner to load config) */
export { CONFIG_PATH };

/**
 * SMA Crossover + Stop-Loss strategy: selects top subnets by blended
 * SMA momentum strength and emission yield scoring.
 *
 * This function is **read-only** — it does not write to the database.
 * All state mutations (price sampling, stop-loss updates) are handled
 * by the runner before this function is called.
 */
export async function getStrategyTargets(
	client: PolkadotClient,
	env: Env,
	balances: Balances,
): Promise<StrategyResult> {
	const api: Api = client.getTypedApi(bittensor);
	const config = loadSmaStoplossConfig(CONFIG_PATH);

	const allSubnets = await fetchAllSubnetData(api);

	// Current block approximation for age calculation
	let currentBlock = 0n;
	for (const sn of allSubnets) {
		const estimate = sn.networkRegisteredAt + sn.blocksSinceLastStep;
		if (estimate > currentBlock) currentBlock = estimate;
	}

	const heldNetuids = new Set(balances.stakes.map((s) => s.netuid));

	// Use shared state from runner, or empty maps for dry-run/preview
	const priceHistories: Map<number, SubnetPriceHistory> =
		sharedState?.priceHistories ?? new Map();
	const stoppedOut: Map<number, StopOutRecord> =
		sharedState?.stoppedOut ?? new Map();

	const { winners, evaluations, coldStart } = scoreSubnets(
		allSubnets,
		config.strategy,
		heldNetuids,
		currentBlock,
		priceHistories,
		stoppedOut,
	);

	log.info(
		`Portfolio: ${formatTao(balances.totalTaoValue)} τ total, ${balances.stakes.length} positions, ${winners.length} SMA winners`,
	);

	if (coldStart) {
		log.warn(
			"Cold start: insufficient price history for SMA indicators — keeping current positions",
		);
		return {
			targets: [],
			skipped: [],
			rebalanceConfig: config.rebalance,
			skipReason:
				"Cold start: insufficient price history for SMA indicators — keeping current positions",
			audit: buildAuditSections(
				evaluations,
				winners,
				config.strategy,
				heldNetuids,
				stoppedOut,
			),
		};
	}

	// Fixed slot allocation: winners fill slots, remainder → SN0
	const maxSlots = config.strategy.maxSubnets;
	const winnerNetuids = winners.map((w) => w.netuid);

	const sn0Slots = maxSlots - winnerNetuids.length;
	const allTargetNetuids = winnerNetuids.includes(0)
		? winnerNetuids
		: [...winnerNetuids, 0];

	if (winnerNetuids.length === 0) {
		log.info("No subnets pass SMA crossover — parking 100% in SN0 (root)");
	} else if (sn0Slots > 0) {
		log.info(
			`${winnerNetuids.length} winners + ${sn0Slots} slot(s) parked in SN0`,
		);
	}

	const { hotkeysByTarget, skipped } = await resolveValidators(
		api,
		balances.stakes,
		allTargetNetuids,
		env.validatorHotkey,
	);

	// Build targets: each winner gets exactly 1/maxSlots share, SN0 gets the rest
	const slotShare = 1 / maxSlots;
	const targets: StrategyTarget[] = [];

	for (const netuid of winnerNetuids) {
		if (!hotkeysByTarget.has(netuid)) continue;
		targets.push({
			netuid,
			// biome-ignore lint/style/noNonNullAssertion: guarded by .has() above
			hotkey: hotkeysByTarget.get(netuid)!,
			share: slotShare,
		});
	}

	// SN0 parking: absorbs all remaining share
	const resolvedWinnerCount = targets.length;
	const usedShare = resolvedWinnerCount * slotShare;
	const sn0Share = 1 - usedShare;
	if (sn0Share > 0.001 && hotkeysByTarget.has(0)) {
		targets.push({
			netuid: 0,
			// biome-ignore lint/style/noNonNullAssertion: guarded by .has() above
			hotkey: hotkeysByTarget.get(0)!,
			share: sn0Share,
		});
	}

	log.verbose(
		`Strategy: ${targets.length} targets, ${(slotShare * 100).toFixed(0)}% per winner slot`,
	);
	for (const t of targets) {
		log.verbose(
			`  Target SN${t.netuid}: ${t.hotkey.slice(0, 8)}… (${(t.share * 100).toFixed(0)}%)`,
		);
	}

	return {
		targets,
		skipped,
		rebalanceConfig: config.rebalance,
		audit: buildAuditSections(
			evaluations,
			winners,
			config.strategy,
			heldNetuids,
			stoppedOut,
		),
	};
}

// ---------------------------------------------------------------------------
// Audit rendering
// ---------------------------------------------------------------------------

/** Precision used in scoreSubnets */
const PRECISION = 10n ** 18n;

function buildAuditSections(
	evaluations: SubnetEvaluation[],
	winners: Array<{ netuid: number; name: string; score: bigint }>,
	strategyConfig: SmaStoplossStrategyConfig,
	heldNetuids: Set<number>,
	stoppedOut: Map<number, StopOutRecord>,
): AuditSections {
	const lines: string[] = [];
	const activeSet = new Set(winners.map((w) => w.netuid));

	lines.push(
		`\nSMA Crossover scoring (${winners.length} winners, max ${strategyConfig.maxSubnets} slots, unfilled → SN0):\n`,
	);
	lines.push(
		`${"".padStart(4)}${"#".padStart(3)}  ${"SN".padEnd(6)}  ${"Name".padEnd(23)}  ${"Fast SMA".padStart(10)}  ${"Slow SMA".padStart(10)}  ${"Momentum".padStart(10)}  ${"EmYield".padStart(10)}  ${"Pool (τ)".padStart(10)}  ${"Score".padStart(12)}  ${"Status".padStart(10)}`,
	);
	lines.push("─".repeat(115));

	// Sort: winners first (by score desc), then non-passing
	const sorted = [...evaluations].sort((a, b) => {
		if (a.passesAllGates !== b.passesAllGates) return a.passesAllGates ? -1 : 1;
		return b.score > a.score ? 1 : b.score < a.score ? -1 : 0;
	});

	let rank = 1;
	for (const ev of sorted) {
		const isActive = activeSet.has(ev.netuid);
		const isHeld = heldNetuids.has(ev.netuid);
		const isStopped = stoppedOut.has(ev.netuid) || ev.isCoolingDown;
		const icon = isStopped
			? "🛑"
			: isActive
				? "🟢"
				: ev.passesAllGates
					? "⚪"
					: "❌";
		const nameRaw = ev.name.length > 20 ? `${ev.name.slice(0, 19)}…` : ev.name;
		const name = isHeld ? `${nameRaw} ⭐` : nameRaw;
		const rankStr = ev.passesAllGates ? String(rank++) : "—";

		const fastStr = formatI96F32Short(ev.fastSma);
		const slowStr = formatI96F32Short(ev.slowSma);
		const momPct = formatScaledPct(ev.momentumStrength);
		const emPct = formatScaledPct(ev.emissionYield);
		const poolTao = formatTao(ev.taoIn);
		const scoreStr = ev.passesAllGates ? formatScaledScore(ev.score) : "—";

		let status = "";
		if (isStopped) status = "STOPPED";
		else if (!ev.passesDepthGate) status = "no-depth";
		else if (!ev.passesAgeGate) status = "too-new";
		else if (!ev.passesHealthGate) status = "unhealthy";
		else if (!ev.passesSmaDataGate) status = "cold-start";
		else if (!ev.passesCrossoverGate) status = "bearish";
		else status = "ok";

		lines.push(
			`${icon} ${rankStr.padStart(3)}  ${`SN${ev.netuid}`.padEnd(6)}  ${name.padEnd(23)}  ${fastStr.padStart(10)}  ${slowStr.padStart(10)}  ${momPct.padStart(10)}  ${emPct.padStart(10)}  ${poolTao.padStart(10)}  ${scoreStr.padStart(12)}  ${status.padStart(10)}`,
		);
	}

	if (evaluations.length === 0) {
		lines.push("  (no non-root subnets found)");
	}

	if (heldNetuids.size > 0) {
		lines.push(
			`\n⭐ = held subnet (+${strategyConfig.incumbencyBonus}% incumbency bonus)`,
		);
	}
	if (stoppedOut.size > 0) {
		lines.push(
			`🛑 = stopped out (${strategyConfig.cooldownBlocks} blocks cooldown)`,
		);
	}

	// --- Markdown report ---
	let md = "";

	md += "## Strategy: sma-stoploss\n\n";
	md += `SMA crossover momentum (fast=${strategyConfig.smaFastPeriod}, slow=${strategyConfig.smaSlowPeriod}) with ${strategyConfig.stopLossPercent}% trailing stop-loss.\n\n`;

	md += "## Gate Thresholds\n\n";
	md += "| Gate | Threshold |\n|---|---|\n";
	md += `| Min Pool Depth | ${strategyConfig.minTaoIn} τ |\n`;
	md += `| Min Subnet Age | ${strategyConfig.minSubnetAgeDays} days |\n`;
	md += `| SMA Crossover | fast(${strategyConfig.smaFastPeriod}) > slow(${strategyConfig.smaSlowPeriod}) |\n`;
	md += `| Health | not immune, not prune target |\n`;
	md += `| Scoring Weights | momentum ${strategyConfig.momentumWeight}% / emission ${strategyConfig.emissionWeight}% |\n`;
	md += `| Incumbency Bonus | +${strategyConfig.incumbencyBonus}% |\n`;
	md += `| Max Slots | ${strategyConfig.maxSubnets} (unfilled → SN0) |\n`;
	md += `| Stop-Loss | fixed ${strategyConfig.stopLossPercent}% trailing |\n`;
	md += `| Cooldown | ${strategyConfig.cooldownBlocks} blocks after stop-out |\n`;
	md += "\n";

	const qualifyingCount = evaluations.filter((e) => e.passesAllGates).length;
	md += `## All Subnets (${qualifyingCount} qualifying / ${evaluations.length} evaluated)\n\n`;

	const cols = [
		"Rank",
		"SN",
		"Name",
		"Fast SMA",
		"Slow SMA",
		"Momentum",
		"Em. Yield",
		"Pool (τ)",
		"Score",
		"Status",
	];
	md += `| ${cols.join(" | ")} |\n`;
	md += `| ${cols.map(() => "---").join(" | ")} |\n`;

	let mdRank = 1;
	for (const ev of sorted) {
		const isStopped = stoppedOut.has(ev.netuid) || ev.isCoolingDown;
		const rankStr = ev.passesAllGates ? `**${mdRank++}**` : "—";
		const nameStr = ev.name.length > 18 ? `${ev.name.slice(0, 18)}…` : ev.name;
		const statusIcon = isStopped ? "🛑" : ev.passesAllGates ? "✅" : "❌";

		const values = [
			rankStr,
			String(ev.netuid),
			`${statusIcon} ${nameStr}`,
			formatI96F32Short(ev.fastSma),
			formatI96F32Short(ev.slowSma),
			formatScaledPct(ev.momentumStrength),
			formatScaledPct(ev.emissionYield),
			formatTao(ev.taoIn),
			ev.passesAllGates ? formatScaledScore(ev.score) : "—",
			isStopped ? "stopped" : ev.passesAllGates ? "pass" : "fail",
		];
		md += `| ${values.join(" | ")} |\n`;
	}

	return { terminalLines: lines, reportMarkdown: md };
}

// --- Format helpers ---

function formatScaledPct(scaled: bigint): string {
	if (scaled === 0n) return "0.00%";
	const bps = (scaled * 10000n) / PRECISION;
	const whole = bps / 100n;
	const frac = (bps % 100n < 0n ? -(bps % 100n) : bps % 100n)
		.toString()
		.padStart(2, "0");
	const sign = scaled > 0n ? "+" : "";
	return `${sign}${whole}.${frac}%`;
}

function formatScaledScore(scaled: bigint): string {
	const shifted = (scaled * 10000n) / PRECISION;
	const whole = shifted / 10000n;
	const frac = shifted % 10000n;
	return `${whole}.${frac.toString().padStart(4, "0")}`;
}

/** Format I96F32 price as short decimal for display */
function formatI96F32Short(value: bigint): string {
	if (value === 0n) return "—";
	const F32 = 1n << 32n;
	const whole = value / F32;
	const frac = ((value % F32) * 10000n) / F32;
	return `${whole}.${frac.toString().padStart(4, "0")}`;
}

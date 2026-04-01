import { createBittensorClient } from "../src/api/createClient.ts";
import type { Balances } from "../src/balances/getBalances.ts";
import { getBalances } from "../src/balances/getBalances.ts";
import { loadConfig } from "../src/config/loadConfig.ts";
import { Sn45Api } from "../src/external-apis/generated/Sn45Api.ts";
import { computeRebalance } from "../src/rebalance/computeRebalance.ts";
import { TAO } from "../src/rebalance/tao.ts";
import type { RebalanceOperation } from "../src/rebalance/types.ts";
import type { SubnetInfo } from "../src/strategy/fetchAllSubnets.ts";
import { fetchAllSubnets } from "../src/strategy/fetchAllSubnets.ts";
import { getBestSubnets } from "../src/strategy/getBestSubnets.ts";
import { getHealthySubnets } from "../src/strategy/getHealthySubnets.ts";
import { getStrategyTargets } from "../src/strategy/getStrategyTargets.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const appConfig = loadConfig(
	new URL("../src/config.yaml", import.meta.url).pathname,
);
const GATES = appConfig.strategy;
const INCUMBENCY_BONUS = appConfig.strategy.incumbencyBonus;
const MAX_SUBNETS = appConfig.strategy.maxSubnets;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const sn45ApiKey = process.env.SN45_API_KEY;
const coldkey = process.env.COLDKEY_ADDRESS;

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!sn45ApiKey) throw new Error("SN45_API_KEY is not set");
if (!coldkey) throw new Error("COLDKEY_ADDRESS is not set");

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------
const { client, api } = createBittensorClient(wsEndpoints);
const sn45 = new Sn45Api({
	baseUrl: "https://sn45api.talisman.xyz",
	baseApiParams: { headers: { "X-API-Key": sn45ApiKey } },
});

try {
	console.log("Fetching on-chain subnet info and SN45 leaderboard…");

	// Fetch on-chain data + balances in parallel
	const [subnets, balances] = await Promise.all([
		fetchAllSubnets(api),
		getBalances(api, coldkey),
	]);
	const healthyNetuids = getHealthySubnets(subnets);
	const subnetMap = new Map(subnets.map((s) => [s.netuid, s]));
	const subnetNames = new Map(subnets.map((s) => [s.netuid, s.name]));
	const heldNetuids = new Set(balances.stakes.map((s) => s.netuid));

	// --- Eligible list: call getBestSubnets() (same logic as rebalancer) ---
	const { winners, evaluations } = await getBestSubnets(
		sn45,
		appConfig.strategy,
		healthyNetuids,
		undefined,
		subnetNames,
		heldNetuids,
	);

	// --- Terminal output ---
	const active = winners.slice(0, MAX_SUBNETS);
	const activeSet = new Set(active.map((s) => s.netuid));

	const hasIncumbency = heldNetuids && heldNetuids.size > 0;
	console.log(
		`\nEligible subnets (${winners.length} qualifying, top ${MAX_SUBNETS} active):\n`,
	);
	console.log(
		`${"".padStart(4)}${"#".padStart(3)}  ${"SN".padEnd(6)}  ${"Name".padEnd(23)}  ${"Score".padStart(7)}  ${"Price Δ".padStart(8)}  ${"Vol (τ)".padStart(10)}  ${"Mcap (τ)".padStart(10)}`,
	);
	console.log("─".repeat(80));

	for (const [i, w] of winners.entries()) {
		const ev = evaluations.find((e) => e.netuid === w.netuid);
		if (!ev) continue;
		const icon = activeSet.has(w.netuid) ? "🟢" : "⚪";
		const rank = i + 1;
		const isHeld = heldNetuids?.has(ev.netuid) ?? false;
		const nameRaw = ev.name.length > 20 ? `${ev.name.slice(0, 19)}…` : ev.name;
		const name = isHeld ? `${nameRaw} ⭐` : nameRaw;
		const scoreStr = isHeld
			? `${ev.score}+${INCUMBENCY_BONUS}`
			: String(Math.round(ev.biasedScore));
		const price =
			ev.priceChange !== null
				? `${ev.priceChange >= 0 ? "+" : ""}${ev.priceChange.toFixed(1)}%`
				: "—";
		const vol = ev.volumeTao.toLocaleString("en-US", {
			maximumFractionDigits: 0,
		});
		const mcap =
			ev.mcapTao !== null
				? ev.mcapTao.toLocaleString("en-US", { maximumFractionDigits: 0 })
				: "—";
		console.log(
			`${icon} ${String(rank).padStart(3)}  ${`SN${ev.netuid}`.padEnd(6)}  ${name.padEnd(23)}  ${scoreStr.padStart(7)}  ${price.padStart(8)}  ${vol.padStart(10)}  ${mcap.padStart(10)}`,
		);
	}

	if (winners.length === 0) {
		console.log("  (no subnets qualify)");
	}

	if (hasIncumbency) {
		console.log(`\n⭐ = held subnet (+${INCUMBENCY_BONUS} incumbency bonus)`);
	}

	// --- Compute strategy targets & rebalance plan ---
	const validatorHotkey = process.env.VALIDATOR_HOTKEY;
	const { targets, skipped: strategySkips } = await getStrategyTargets(
		api,
		sn45,
		balances,
		appConfig,
		{ fallbackValidatorHotkey: validatorHotkey },
	);
	const plan = computeRebalance(balances, targets, appConfig.rebalance);
	plan.skipped.push(...strategySkips);

	// --- Portfolio & operations terminal output ---
	printPortfolio(balances, subnetNames, appConfig.rebalance.freeReserveTao);
	printOperations(plan.operations, plan.skipped, subnetNames);

	// --- Build markdown audit table from evaluations + on-chain data ---
	const now = new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, " UTC");

	let md = `# Rebalance Simulation\n\n`;
	md += `> Generated ${now}\n\n`;

	md += `## Gate Thresholds\n\n`;
	md += `| Gate | Threshold |\n|---|---|\n`;
	md += `| Min Score | ${GATES.minScore} |\n`;
	md += `| Min Volume | ${GATES.minVolumeTao} τ |\n`;
	md += `| Min Market Cap | ${GATES.minMcapTao} τ |\n`;
	md += `| Min Holders | ${GATES.minHolders} |\n`;
	md += `| Min Emission % | ${GATES.minEmissionPct}% |\n`;
	md += `| Vol/Mcap Bottom Percentile Cutoff | ${GATES.bottomPercentileCutoff}% |\n`;
	md += `| Incumbency Bonus | +${INCUMBENCY_BONUS} pts |\n`;
	md += `| Max Subnets | ${MAX_SUBNETS} |\n`;
	md += `\n`;

	// Build rows by merging evaluations with on-chain data
	const qualifyingCount = evaluations.filter((e) => e.passesAllGates).length;
	md += `## All Subnets (${qualifyingCount} qualifying / ${evaluations.length} total)\n\n`;

	const sorted = [...evaluations].sort((a, b) => {
		if (a.passesAllGates !== b.passesAllGates) return a.passesAllGates ? -1 : 1;
		return b.score - a.score;
	});

	let rank = 1;
	const rankedRows = sorted.map((ev) => ({
		...ev,
		rank: ev.passesAllGates ? rank++ : 0,
	}));

	const cols = [
		"Rank",
		"SN",
		"Name",
		"Score",
		"Price Δ 24h",
		"Volume (τ)",
		"Mcap (τ)",
		"EMA Flow (τ)",
		"Holders",
		"Buys",
		"Sells",
		"Sell/Buy",
		"Emission %",
		"Vol/Mcap",
		"Registration",
	];
	md += `| ${cols.join(" | ")} |\n`;
	md += `| ${cols.map(() => "---").join(" | ")} |\n`;

	for (const r of rankedRows) {
		const health = subnetMap.get(r.netuid);
		const rankStr = r.rank > 0 ? `**${r.rank}**` : "—";
		const nameStr = r.name.length > 18 ? `${r.name.slice(0, 18)}…` : r.name;
		const allIcon = r.passesAllGates ? "✅" : "❌";
		const sellBuyRatio =
			r.buyCount > 0 ? r.sellCount / r.buyCount : r.sellCount > 0 ? null : 0;

		const values = [
			rankStr,
			String(r.netuid),
			`${allIcon} ${nameStr}`,
			gate(r.passesScoreGate, n(r.score, 0)),
			gate(r.passesPriceGate, pct(r.priceChange)),
			gate(r.passesVolumeGate, compact(r.volumeTao)),
			gate(r.passesMcapGate, compact(r.mcapTao)),
			compact(r.emaTaoFlow),
			gate(r.passesHoldersGate, n(r.totalHolders, 0)),
			n(r.buyCount, 0),
			n(r.sellCount, 0),
			sellBuyRatio !== null ? n(sellBuyRatio, 2) : "∞",
			gate(r.passesEmissionGate, pct(r.emissionPct)),
			gate(r.passesVolMcapGate, n(r.volMcapRatio, 4)),
			gate(r.passesHealthGate, formatRegistration(health)),
		];
		md += `| ${values.join(" | ")} |\n`;
	}

	// --- Portfolio section ---
	md += `\n## Portfolio\n\n`;
	md += `| Asset | Value (τ) |\n|---|---|\n`;
	md += `| **Native TAO** | ${formatTao(balances.free)} (reserve: ${formatTao(appConfig.rebalance.freeReserveTao)}) |\n`;
	for (const s of balances.stakes) {
		const name = subnetNames.get(s.netuid) ?? `SN${s.netuid}`;
		md += `| SN${s.netuid} ${name} | ${formatTao(s.taoValue)} |\n`;
	}
	md += `| **Total** | **${formatTao(balances.totalTaoValue)}** |\n`;

	// --- Operations section ---
	md += `\n## Planned Operations (${plan.operations.length})\n\n`;
	if (plan.operations.length === 0) {
		md += `Portfolio is balanced — nothing to do.\n`;
	} else {
		md += `| # | Operation | Details | ~Value (τ) |\n|---|---|---|---|\n`;
		for (const [i, op] of plan.operations.entries()) {
			md += `| ${i + 1} | ${formatOpKind(op)} | ${formatOpDetail(op, subnetNames)} | ${formatTao(opEstimatedValue(op))} |\n`;
		}
	}
	if (plan.skipped.length > 0) {
		md += `\n### Skipped\n\n`;
		for (const s of plan.skipped) {
			md += `- SN${s.netuid}: ${s.reason}\n`;
		}
	}

	// Write simulation output
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const outPath = `reports/simulation-${ts}.md`;
	await Bun.write(outPath, md);

	console.log(
		`\nSimulation written to ${outPath} — ${qualifyingCount} qualifying / ${evaluations.length} total subnets`,
	);
} finally {
	client.destroy();
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function n(v: number | null, decimals = 1): string {
	return v !== null
		? v.toLocaleString("en-US", {
				maximumFractionDigits: decimals,
				minimumFractionDigits: decimals,
			})
		: "—";
}

function compact(v: number | null): string {
	return v !== null
		? v.toLocaleString("en-US", {
				notation: "compact",
				maximumSignificantDigits: 4,
			})
		: "—";
}

function pct(v: number | null): string {
	return v !== null ? `${v.toFixed(2)}%` : "—";
}

function gate(passes: boolean, value: string): string {
	return `${passes ? "✅" : "❌"} ${value}`;
}

function formatRegistration(health: SubnetInfo | undefined): string {
	if (!health) return "—";
	if (health.isPruneTarget) return "⚠️ prune risk";
	if (health.isImmune) return "🛡️ immune";
	return "—";
}

function formatTao(rao: bigint): string {
	const whole = rao / TAO;
	const frac = ((rao % TAO) * 1000n) / TAO;
	return `${whole}.${frac.toString().padStart(3, "0")}`;
}

function formatOpKind(op: RebalanceOperation): string {
	switch (op.kind) {
		case "swap":
			return "Swap";
		case "unstake":
			return "Unstake";
		case "unstake_partial":
			return "Unstake (partial)";
		case "stake":
			return "Stake";
		case "move":
			return "Move hotkey";
	}
}

function formatOpDetail(
	op: RebalanceOperation,
	names: Map<number, string>,
): string {
	const sn = (netuid: number) =>
		`SN${netuid} ${names.get(netuid) ?? ""}`.trim();
	switch (op.kind) {
		case "swap":
			return `${sn(op.originNetuid)} → ${sn(op.destinationNetuid)}`;
		case "unstake":
		case "unstake_partial":
			return sn(op.netuid);
		case "stake":
			return sn(op.netuid);
		case "move":
			return `${sn(op.netuid)} (${op.originHotkey.slice(0, 8)}… → ${op.destinationHotkey.slice(0, 8)}…)`;
	}
}

function opEstimatedValue(op: RebalanceOperation): bigint {
	switch (op.kind) {
		case "swap":
		case "unstake":
		case "unstake_partial":
			return op.estimatedTaoValue;
		case "stake":
			return op.taoAmount;
		case "move":
			return 0n;
	}
}

function printPortfolio(
	balances: Balances,
	subnetNames: Map<number, string>,
	freeReserveTao: bigint,
): void {
	const reserveStatus =
		balances.free >= freeReserveTao
			? "✅"
			: `⚠️  below reserve (${formatTao(freeReserveTao)})`;
	console.log(`\n${"─".repeat(60)}`);
	console.log("Portfolio");
	console.log("─".repeat(60));
	console.log(`  Native TAO:  ${formatTao(balances.free)} τ  ${reserveStatus}`);
	console.log(`  Reserved:    ${formatTao(balances.reserved)} τ`);
	if (balances.stakes.length > 0) {
		console.log(`  Stakes (${balances.stakes.length}):`);
		const sorted = [...balances.stakes].sort((a, b) =>
			Number(b.taoValue - a.taoValue),
		);
		for (const s of sorted) {
			const name = subnetNames.get(s.netuid) ?? "";
			console.log(
				`    SN${s.netuid.toString().padStart(3)} ${name.padEnd(20).slice(0, 20)}  ${formatTao(s.taoValue).padStart(10)} τ`,
			);
		}
	}
	console.log(`  ${"─".repeat(40)}`);
	console.log(`  Total:       ${formatTao(balances.totalTaoValue)} τ`);
}

function printOperations(
	operations: RebalanceOperation[],
	skipped: Array<{ netuid: number; reason: string }>,
	subnetNames: Map<number, string>,
): void {
	console.log(`\n${"─".repeat(60)}`);
	console.log(`Operations (${operations.length})`);
	console.log("─".repeat(60));
	if (operations.length === 0) {
		console.log("  Portfolio is balanced — nothing to do.");
	} else {
		for (const [i, op] of operations.entries()) {
			const value = opEstimatedValue(op);
			const valueStr = value > 0n ? `~${formatTao(value)} τ` : "";
			console.log(
				`  ${String(i + 1).padStart(2)}. ${formatOpKind(op).padEnd(18)} ${formatOpDetail(op, subnetNames).padEnd(30).slice(0, 30)}  ${valueStr}`,
			);
		}
	}
	if (skipped.length > 0) {
		console.log(`\n  Skipped (${skipped.length}):`);
		for (const s of skipped) {
			console.log(`    SN${s.netuid}: ${s.reason}`);
		}
	}
}

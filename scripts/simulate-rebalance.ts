import {
	bittensor,
	getMetadata as getDescriptorsMetadata,
} from "@polkadot-api/descriptors";
import { createWsClient } from "polkadot-api/ws";
import { Sn45Api } from "../src/api/generated/Sn45Api.ts";
import { getBalances } from "../src/balances/getBalances.ts";
import { loadConfig } from "../src/config/loadConfig.ts";
import { TAO } from "../src/rebalance/tao.ts";
import type { SubnetInfo } from "../src/subnets/fetchAllSubnets.ts";
import { fetchAllSubnets } from "../src/subnets/fetchAllSubnets.ts";
import {
	getBestSubnets,
	STRATEGY_DEFAULTS,
} from "../src/subnets/getBestSubnets.ts";
import { getHealthySubnets } from "../src/subnets/getHealthySubnets.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const appConfig = loadConfig(
	new URL("../src/config.yaml", import.meta.url).pathname,
);
const GATES = {
	...STRATEGY_DEFAULTS,
	...appConfig.strategy,
};
const INCUMBENCY_BONUS = appConfig.rebalance.incumbencyBonus;
const MAX_SUBNETS = appConfig.rebalance.maxSubnets;

const RAO = 1_000_000_000;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const sn45ApiKey = process.env.SN45_API_KEY;
const coldkey = process.env.COLDKEY_ADDRESS;

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!sn45ApiKey) throw new Error("SN45_API_KEY is not set");

// ---------------------------------------------------------------------------
// Metadata caching
// ---------------------------------------------------------------------------
const CACHE_DIR = ".papi/cache";
await Bun.write(Bun.file(`${CACHE_DIR}/.gitkeep`), "");

const setMetadata = (codeHash: string, value: Uint8Array) => {
	Bun.write(Bun.file(`${CACHE_DIR}/${codeHash}.bin`), value);
};
const getMetadata = async (codeHash: string) => {
	const file = Bun.file(`${CACHE_DIR}/${codeHash}.bin`);
	if (await file.exists()) return new Uint8Array(await file.arrayBuffer());
	const metadata = await getDescriptorsMetadata(codeHash);
	if (metadata) setMetadata(codeHash, metadata);
	return metadata;
};

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------
const client = createWsClient(wsEndpoints, { getMetadata, setMetadata });
const sn45 = new Sn45Api({
	baseUrl: "https://sn45api.talisman.xyz",
	baseApiParams: { headers: { "X-API-Key": sn45ApiKey } },
});

try {
	const api = client.getTypedApi(bittensor);

	console.log("Fetching on-chain subnet info and SN45 leaderboard…");

	// Fetch on-chain data
	const subnets = await fetchAllSubnets(api);
	const healthyNetuids = getHealthySubnets(
		subnets,
		BigInt(appConfig.health.minPoolTao) * TAO,
	);
	const subnetMap = new Map(subnets.map((s) => [s.netuid, s]));
	const subnetNames = new Map(subnets.map((s) => [s.netuid, s.name]));
	const immuneNetuids = new Set(
		subnets.filter((s) => s.isImmune).map((s) => s.netuid),
	);

	// Optionally fetch balances for incumbency bonus
	let heldNetuids: Set<number> | undefined;
	if (coldkey) {
		const balances = await getBalances(api, coldkey);
		heldNetuids = new Set(balances.stakes.map((s) => s.netuid));
	}

	// --- Eligible list: call getBestSubnets() (same logic as rebalancer) ---
	const { winners, evaluations } = await getBestSubnets(
		sn45,
		appConfig.strategy,
		healthyNetuids,
		undefined,
		subnetNames,
		heldNetuids,
		immuneNetuids,
		INCUMBENCY_BONUS,
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

	for (let i = 0; i < winners.length; i++) {
		const w = winners[i]!;
		const ev = evaluations.find((e) => e.netuid === w.netuid)!;
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
	} else if (!coldkey) {
		console.log(
			"\nNote: Set COLDKEY_ADDRESS to apply incumbency bonus for held subnets.",
		);
	}

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
	md += `| Min Pool Liquidity | ${appConfig.health.minPoolTao} τ |\n`;
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
		"Pool τ In",
		"Chain Vol (τ)",
		"Emission τ In",
		"Tempo",
		"Blks Last Step",
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
			formatRegistration(health),
			gate(
				r.passesHealthGate,
				compact(health ? Number(health.taoIn) / RAO : null),
			),
			compact(health ? Number(health.subnetVolume) / RAO : null),
			n(health ? Number(health.taoInEmission) / RAO : null, 0),
			health?.tempo !== undefined ? String(health.tempo) : "—",
			health ? String(Number(health.blocksSinceLastStep)) : "—",
		];
		md += `| ${values.join(" | ")} |\n`;
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

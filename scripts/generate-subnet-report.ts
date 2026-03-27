import {
	bittensor,
	getMetadata as getDescriptorsMetadata,
} from "@polkadot-api/descriptors";
import { createWsClient } from "polkadot-api/ws";
import { Sn45Api } from "../src/api/generated/Sn45Api.ts";
import { loadConfig } from "../src/config/loadConfig.ts";
import { fetchAllSubnets } from "../src/subnets/fetchAllSubnets.ts";
import { STRATEGY_DEFAULTS } from "../src/subnets/getBestSubnets.ts";
import { getHealthySubnets } from "../src/subnets/getHealthySubnets.ts";

// ---------------------------------------------------------------------------
// Config — sourced from YAML config and strategy defaults
// ---------------------------------------------------------------------------
const appConfig = loadConfig(
	new URL("../src/config.yaml", import.meta.url).pathname,
);
const GATES = {
	...STRATEGY_DEFAULTS,
	...appConfig.strategy,
};
const INCUMBENCY_BONUS = appConfig.rebalance.incumbencyBonus;

const RAO = 1_000_000_000;

// ---------------------------------------------------------------------------
// SN45 leaderboard entry shape
// ---------------------------------------------------------------------------
interface LeaderboardEntry {
	netuid: number;
	priceChange: number | null;
	mcap: string | null;
	emaTaoFlow: string | null;
	volume: string;
	totalHolders: number;
	buyCount: number;
	sellCount: number;
	emissionPct: number | null;
	score: number;
}

// Row in the final report
interface ReportRow {
	rank: number;
	netuid: number;
	name: string;
	score: number;
	priceChange: number | null;
	volumeTao: number;
	mcapTao: number | null;
	emaTaoFlow: number | null;
	totalHolders: number;
	buyCount: number;
	sellCount: number;
	sellBuyRatio: number | null;
	emissionPct: number | null;
	volMcapRatio: number | null;
	taoInPool: number | null;
	subnetVolume: number | null;
	taoInEmission: number | null;
	tempo: number | null;
	blocksSinceLastStep: number | null;
	isImmune: boolean | null;
	isNextToPrune: boolean;
	passesPriceGate: boolean;
	passesHealthGate: boolean;
	passesScoreGate: boolean;
	passesVolumeGate: boolean;
	passesMcapGate: boolean;
	passesHoldersGate: boolean;
	passesEmissionGate: boolean;
	passesVolMcapGate: boolean;
	passesAllGates: boolean;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const sn45ApiKey = process.env.SN45_API_KEY;

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!sn45ApiKey) throw new Error("SN45_API_KEY is not set");

// ---------------------------------------------------------------------------
// Metadata caching (same pattern as rebalance.ts)
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

	const [subnets, leaderboardRes] = await Promise.all([
		fetchAllSubnets(api),
		sn45.v1.getSubnetLeaderboard({ period: "1d" }),
	]);

	const healthyNetuids = getHealthySubnets(subnets);
	const subnetMap = new Map(subnets.map((s) => [s.netuid, s]));
	const subnetNames = new Map(subnets.map((s) => [s.netuid, s.name]));

	const leaderboard = leaderboardRes.data.subnets as LeaderboardEntry[];

	// -----------------------------------------------------------------------
	// Evaluate every gate for every subnet and compute vol/mcap percentile
	// -----------------------------------------------------------------------
	const evaluated = leaderboard.map((s) => {
		const health = subnetMap.get(s.netuid);
		const hasPriceData = s.netuid !== 0 && s.priceChange !== null;
		const hasFullData =
			hasPriceData && s.mcap !== null && s.emaTaoFlow !== null;
		const isHealthy = healthyNetuids.has(s.netuid);
		const isImmune = health?.isImmune ?? false;

		const volumeTao = Number(s.volume) / RAO;
		const mcapTao = s.mcap !== null ? Number(s.mcap) / RAO : null;
		const sellBuyRatio =
			s.buyCount > 0 ? s.sellCount / s.buyCount : s.sellCount > 0 ? null : 0;

		return {
			entry: s,
			health,
			volumeTao,
			mcapTao,
			emaTaoFlow: s.emaTaoFlow !== null ? Number(s.emaTaoFlow) / RAO : null,
			sellBuyRatio,
			volMcapRatio:
				mcapTao !== null && mcapTao > 0 ? volumeTao / mcapTao : null,
			passesPriceGate: hasPriceData,
			passesDataGate: isImmune || (hasFullData && isHealthy),
			passesHealthGate: isImmune || isHealthy,
			passesScoreGate: s.score >= GATES.minScore,
			passesVolumeGate: isImmune || volumeTao >= GATES.minVolumeTao,
			passesMcapGate:
				isImmune || (mcapTao !== null && mcapTao >= GATES.minMcapTao),
			passesHoldersGate: isImmune || s.totalHolders >= GATES.minHolders,
			passesEmissionGate:
				isImmune ||
				(s.emissionPct !== null && s.emissionPct >= GATES.minEmissionPct),
		};
	});

	// Volume/mcap percentile gate (computed from the set that passed prior gates)
	const priorPassers = evaluated.filter(
		(e) =>
			e.passesDataGate &&
			e.passesScoreGate &&
			e.passesVolumeGate &&
			e.passesMcapGate &&
			e.passesHoldersGate &&
			e.passesEmissionGate,
	);
	const ratios = priorPassers
		.map((e) => e.volMcapRatio ?? 0)
		.sort((a, b) => a - b);
	const cutoffIdx = Math.floor(
		(GATES.bottomPercentileCutoff / 100) * ratios.length,
	);
	const cutoffValue = ratios[cutoffIdx] ?? 0;

	// -----------------------------------------------------------------------
	// Build rows
	// -----------------------------------------------------------------------
	const rows: ReportRow[] = evaluated.map((e) => {
		const isImmune = e.health?.isImmune ?? false;
		const passesVolMcapGate =
			isImmune || (e.volMcapRatio !== null && e.volMcapRatio >= cutoffValue);
		const passesAllGates =
			e.passesDataGate &&
			e.passesScoreGate &&
			e.passesVolumeGate &&
			e.passesMcapGate &&
			e.passesHoldersGate &&
			e.passesEmissionGate &&
			passesVolMcapGate;

		return {
			rank: 0,
			netuid: e.entry.netuid,
			name: subnetNames.get(e.entry.netuid) ?? `SN${e.entry.netuid}`,
			score: e.entry.score,
			priceChange: e.entry.priceChange,
			volumeTao: e.volumeTao,
			mcapTao: e.mcapTao,
			emaTaoFlow: e.emaTaoFlow,
			totalHolders: e.entry.totalHolders,
			buyCount: e.entry.buyCount,
			sellCount: e.entry.sellCount,
			sellBuyRatio: e.sellBuyRatio,
			emissionPct: e.entry.emissionPct,
			volMcapRatio: e.volMcapRatio,
			taoInPool: e.health ? Number(e.health.taoIn) / RAO : null,
			subnetVolume: e.health ? Number(e.health.subnetVolume) / RAO : null,
			taoInEmission: e.health ? Number(e.health.taoInEmission) / RAO : null,
			tempo: e.health?.tempo ?? null,
			blocksSinceLastStep: e.health
				? Number(e.health.blocksSinceLastStep)
				: null,
			isImmune: e.health?.isImmune ?? null,
			isNextToPrune: e.health?.isPruneTarget ?? false,
			passesPriceGate: e.passesPriceGate,
			passesHealthGate: e.passesHealthGate,
			passesScoreGate: e.passesScoreGate,
			passesVolumeGate: e.passesVolumeGate,
			passesMcapGate: e.passesMcapGate,
			passesHoldersGate: e.passesHoldersGate,
			passesEmissionGate: e.passesEmissionGate,
			passesVolMcapGate: passesVolMcapGate,
			passesAllGates,
		};
	});

	// Sort: passing subnets first (by score desc), then non-passing (by score desc)
	rows.sort((a, b) => {
		if (a.passesAllGates !== b.passesAllGates) return a.passesAllGates ? -1 : 1;
		return b.score - a.score;
	});

	// Assign ranks only to passing subnets
	let rank = 1;
	for (const row of rows) {
		if (row.passesAllGates) row.rank = rank++;
	}

	// -----------------------------------------------------------------------
	// Format helpers
	// -----------------------------------------------------------------------
	const n = (v: number | null, decimals = 1) =>
		v !== null
			? v.toLocaleString("en-US", {
					maximumFractionDigits: decimals,
					minimumFractionDigits: decimals,
				})
			: "—";

	const compact = (v: number | null) =>
		v !== null
			? v.toLocaleString("en-US", {
					notation: "compact",
					maximumSignificantDigits: 4,
				})
			: "—";

	const pct = (v: number | null) => (v !== null ? `${v.toFixed(2)}%` : "—");

	const gate = (passes: boolean, value: string) =>
		`${passes ? "✅" : "❌"} ${value}`;

	const registration = (immune: boolean | null, pruneRisk: boolean) => {
		if (pruneRisk) return "⚠️ prune risk";
		if (immune === true) return "🛡️ immune";
		if (immune === false) return "—";
		return "—";
	};

	// -----------------------------------------------------------------------
	// Build markdown
	// -----------------------------------------------------------------------
	const now = new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, " UTC");

	let md = `# Subnet Report\n\n`;
	md += `> Generated ${now}\n\n`;

	md += `## Gate Thresholds\n\n`;
	md += `| Gate | Threshold |\n|---|---|\n`;
	md += `| Min Score | ${GATES.minScore} |\n`;
	md += `| Min Volume | ${GATES.minVolumeTao} τ |\n`;
	md += `| Min Market Cap | ${GATES.minMcapTao} τ |\n`;
	md += `| Min Holders | ${GATES.minHolders} |\n`;
	md += `| Min Emission % | ${GATES.minEmissionPct}% |\n`;
	md += `| Vol/Mcap Bottom Percentile Cutoff | ${GATES.bottomPercentileCutoff}% |\n`;
	md += `| Min Pool Liquidity | ${GATES.minPoolTao} τ |\n`;
	md += `| Incumbency Bonus | +${INCUMBENCY_BONUS} pts |\n`;
	md += `\n`;

	md += `## All Subnets (${rows.filter((r) => r.passesAllGates).length} qualifying / ${rows.length} total)\n\n`;

	// Header
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

	for (const r of rows) {
		const rankStr = r.rank > 0 ? `**${r.rank}**` : "—";
		const nameStr = r.name.length > 18 ? `${r.name.slice(0, 18)}…` : r.name;

		const allIcon = r.passesAllGates ? "✅" : "❌";

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
			r.sellBuyRatio !== null ? n(r.sellBuyRatio, 2) : "∞",
			gate(r.passesEmissionGate, pct(r.emissionPct)),
			gate(r.passesVolMcapGate, n(r.volMcapRatio, 4)),
			registration(r.isImmune, r.isNextToPrune),
			gate(r.passesHealthGate, compact(r.taoInPool)),
			compact(r.subnetVolume),
			n(r.taoInEmission, 0),
			r.tempo !== null ? String(r.tempo) : "—",
			r.blocksSinceLastStep !== null ? String(r.blocksSinceLastStep) : "—",
		];
		md += `| ${values.join(" | ")} |\n`;
	}

	// Write report
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const outPath = `reports/subnet-report-${ts}.md`;
	await Bun.write(outPath, md);

	const qualifiedCount = rows.filter((r) => r.passesAllGates).length;
	console.log(
		`Report written to ${outPath} — ${qualifiedCount} qualifying / ${rows.length} total subnets`,
	);
} finally {
	client.destroy();
	process.exit(0);
}

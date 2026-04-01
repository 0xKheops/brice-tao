import type { Sn45Api } from "../api/generated/Sn45Api.ts";

const RAO = 1_000_000_000;

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

export interface StrategyConfig {
	/** Minimum SN45 leaderboard score to be considered */
	minScore: number;
	/** Minimum 24h volume in TAO to be considered */
	minVolumeTao: number;
	/** Minimum market cap in TAO — rejects illiquid subnets */
	minMcapTao: number;
	/** Minimum unique holder wallets — rejects concentrated/fragile subnets */
	minHolders: number;
	/** Minimum emission % from root validators */
	minEmissionPct: number;
	/** Drop subnets in the bottom N% of volume/mcap ratio */
	bottomPercentileCutoff: number;
	/** Scoring bonus added to currently-held subnets */
	incumbencyBonus: number;
}

export interface SubnetScore {
	netuid: number;
	name: string;
	score: number;
}

/** Per-subnet gate evaluation with metrics and pass/fail for each gate. */
export interface SubnetEvaluation {
	netuid: number;
	name: string;
	score: number;
	biasedScore: number;
	priceChange: number | null;
	volumeTao: number;
	mcapTao: number | null;
	emaTaoFlow: number | null;
	totalHolders: number;
	buyCount: number;
	sellCount: number;
	emissionPct: number | null;
	volMcapRatio: number | null;
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

export interface GetBestSubnetsResult {
	winners: SubnetScore[];
	evaluations: SubnetEvaluation[];
}

interface Logger {
	verbose: (msg: string) => void;
}

export async function getBestSubnets(
	sn45: Sn45Api<unknown>,
	config: StrategyConfig,
	activeNetuids?: Set<number>,
	logger?: Logger,
	subnetNames?: Map<number, string>,
	heldNetuids?: Set<number>,
): Promise<GetBestSubnetsResult> {
	const cfg = config;

	const getName = (netuid: number) => subnetNames?.get(netuid) ?? `SN${netuid}`;
	const label = (netuid: number) =>
		subnetNames?.get(netuid)
			? `SN${netuid} (${subnetNames.get(netuid)})`
			: `SN${netuid}`;

	const bias = config.incumbencyBonus;

	const res = await sn45.v1.getSubnetLeaderboard({ period: "1d" });
	const leaderboard = res.data.subnets as LeaderboardEntry[];

	// --- Phase 1: evaluate per-gate results for every subnet ---
	const evaluations: SubnetEvaluation[] = leaderboard.map((s) => {
		const isHealthy =
			activeNetuids === undefined || activeNetuids.has(s.netuid);
		const biasedScore = heldNetuids?.has(s.netuid) ? s.score + bias : s.score;

		const volumeTao = Number(s.volume) / RAO;
		const mcapTao = s.mcap !== null ? Number(s.mcap) / RAO : null;
		const emaTaoFlow =
			s.emaTaoFlow !== null ? Number(s.emaTaoFlow) / RAO : null;

		const passesPriceGate = s.netuid !== 0 && s.priceChange !== null;
		const passesHealthGate = isHealthy;
		const passesScoreGate = biasedScore >= cfg.minScore;
		const passesVolumeGate = volumeTao >= cfg.minVolumeTao;
		const passesMcapGate = mcapTao !== null && mcapTao >= cfg.minMcapTao;
		const passesHoldersGate = s.totalHolders >= cfg.minHolders;
		const passesEmissionGate =
			s.emissionPct !== null && s.emissionPct >= cfg.minEmissionPct;

		return {
			netuid: s.netuid,
			name: getName(s.netuid),
			score: s.score,
			biasedScore,
			priceChange: s.priceChange,
			volumeTao,
			mcapTao,
			emaTaoFlow,
			totalHolders: s.totalHolders,
			buyCount: s.buyCount,
			sellCount: s.sellCount,
			emissionPct: s.emissionPct,
			volMcapRatio: null,
			passesPriceGate,
			passesHealthGate,
			passesScoreGate,
			passesVolumeGate,
			passesMcapGate,
			passesHoldersGate,
			passesEmissionGate,
			passesVolMcapGate: false,
			passesAllGates: false,
		};
	});

	// --- Phase 2: vol/mcap percentile cutoff (from subnets passing all prior gates) ---
	const priorPassers = evaluations.filter(
		(e) =>
			e.passesPriceGate &&
			e.passesHealthGate &&
			e.mcapTao !== null &&
			e.emaTaoFlow !== null &&
			e.passesScoreGate &&
			e.passesVolumeGate &&
			e.passesMcapGate &&
			e.passesHoldersGate &&
			e.passesEmissionGate,
	);

	const ratioValues = priorPassers
		.map((e) =>
			e.mcapTao !== null && e.mcapTao > 0 ? e.volumeTao / e.mcapTao : 0,
		)
		.sort((a, b) => a - b);
	const cutoffIdx = Math.floor(
		(cfg.bottomPercentileCutoff / 100) * ratioValues.length,
	);
	const cutoffValue = ratioValues[cutoffIdx] ?? 0;

	for (const e of evaluations) {
		const ratio =
			e.mcapTao !== null && e.mcapTao > 0 ? e.volumeTao / e.mcapTao : null;
		e.volMcapRatio = ratio;
		e.passesVolMcapGate = ratio !== null && ratio >= cutoffValue;
		e.passesAllGates =
			e.passesPriceGate &&
			e.passesHealthGate &&
			e.mcapTao !== null &&
			e.emaTaoFlow !== null &&
			e.passesScoreGate &&
			e.passesVolumeGate &&
			e.passesMcapGate &&
			e.passesHoldersGate &&
			e.passesEmissionGate &&
			e.passesVolMcapGate;
	}

	// --- Phase 3: build winners & log ---
	const winners = evaluations
		.filter((e) => e.passesAllGates)
		.sort((a, b) => b.biasedScore - a.biasedScore);

	for (const e of evaluations) {
		if (e.passesAllGates) continue;
		if (e.netuid === 0 || !e.passesPriceGate) continue;
		if (!e.passesHealthGate || e.mcapTao === null || e.emaTaoFlow === null)
			continue;

		if (!e.passesScoreGate) {
			logger?.verbose(
				`${label(e.netuid)} excluded: score ${e.biasedScore}${heldNetuids?.has(e.netuid) ? ` (includes +${bias} bias)` : ""} < ${cfg.minScore}`,
			);
		} else if (!e.passesVolumeGate) {
			logger?.verbose(
				`${label(e.netuid)} excluded: volume ${e.volumeTao.toFixed(0)} τ < ${cfg.minVolumeTao} τ`,
			);
		} else if (!e.passesMcapGate) {
			logger?.verbose(
				`${label(e.netuid)} excluded: mcap ${(e.mcapTao ?? 0).toFixed(0)} τ < ${cfg.minMcapTao} τ`,
			);
		} else if (!e.passesHoldersGate) {
			logger?.verbose(
				`${label(e.netuid)} excluded: ${e.totalHolders} holders < ${cfg.minHolders}`,
			);
		} else if (!e.passesEmissionGate) {
			logger?.verbose(
				`${label(e.netuid)} excluded: emission ${e.emissionPct ?? 0}% < ${cfg.minEmissionPct}%`,
			);
		} else if (!e.passesVolMcapGate) {
			logger?.verbose(
				`${label(e.netuid)} excluded: vol/mcap ratio ${(e.volMcapRatio ?? 0).toFixed(4)} in bottom ${cfg.bottomPercentileCutoff}%`,
			);
		}
	}

	for (const e of winners) {
		const id = `SN${e.netuid}`.padEnd(5);
		const name = e.name.padEnd(20);
		logger?.verbose(`${id} - ${name} : ${e.biasedScore}`);
	}

	return {
		winners: winners.map((e) => ({
			netuid: e.netuid,
			name: e.name,
			score: e.biasedScore,
		})),
		evaluations,
	};
}

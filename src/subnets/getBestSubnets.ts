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

export const STRATEGY_DEFAULTS = {
	minScore: 70,
	minVolumeTao: 100,
	minMcapTao: 0,
	minHolders: 500,
	minEmissionPct: 0,
	bottomPercentileCutoff: 10,
	/** Minimum TAO locked in subnet pool to consider it healthy */
	minPoolTao: 1_000,
} as const;

export interface StrategyConfig {
	/** Minimum SN45 leaderboard score to be considered (default: 70) */
	minScore?: number;
	/** Minimum 24h volume in TAO to be considered (default: 100) */
	minVolumeTao?: number;
	/** Minimum market cap in TAO (default: 0 — no mcap floor) */
	minMcapTao?: number;
	/** Minimum unique holder wallets — rejects concentrated/fragile subnets (default: 500) */
	minHolders?: number;
	/** Minimum emission % from root validators (default: 0 — all emission levels accepted) */
	minEmissionPct?: number;
	/** Drop subnets in the bottom N% of volume/mcap ratio (default: 10) */
	bottomPercentileCutoff?: number;
	/** Minimum TAO locked in subnet pool — rejects illiquid subnets (default: 1000) */
	minPoolTao?: number;
}

export interface SubnetScore {
	netuid: number;
	name: string;
	score: number;
}

interface Logger {
	verbose: (msg: string) => void;
}

export async function getBestSubnets(
	sn45: Sn45Api<unknown>,
	config?: StrategyConfig,
	activeNetuids?: Set<number>,
	logger?: Logger,
	subnetNames?: Map<number, string>,
	heldNetuids?: Set<number>,
	immuneNetuids?: Set<number>,
	incumbencyBonus?: number,
): Promise<SubnetScore[]> {
	const cfg = {
		minScore: config?.minScore ?? STRATEGY_DEFAULTS.minScore,
		minVolumeTao: config?.minVolumeTao ?? STRATEGY_DEFAULTS.minVolumeTao,
		minMcapTao: config?.minMcapTao ?? STRATEGY_DEFAULTS.minMcapTao,
		minHolders: config?.minHolders ?? STRATEGY_DEFAULTS.minHolders,
		minEmissionPct: config?.minEmissionPct ?? STRATEGY_DEFAULTS.minEmissionPct,
		bottomPercentileCutoff:
			config?.bottomPercentileCutoff ??
			STRATEGY_DEFAULTS.bottomPercentileCutoff,
	};

	const label = (netuid: number) =>
		subnetNames?.get(netuid)
			? `SN${netuid} (${subnetNames.get(netuid)})`
			: `SN${netuid}`;

	const res = await sn45.v1.getSubnetLeaderboard({ period: "1d" });
	const leaderboard = res.data.subnets as LeaderboardEntry[];

	// Exclude SN0 (root), subnets missing essential data, and non-active subnets
	const complete = leaderboard.filter(
		(
			s,
		): s is LeaderboardEntry & {
			priceChange: number;
			mcap: string;
			emaTaoFlow: string;
		} =>
			s.netuid !== 0 &&
			s.priceChange !== null &&
			s.mcap !== null &&
			s.emaTaoFlow !== null &&
			(activeNetuids === undefined || activeNetuids.has(s.netuid)),
	);

	// Incumbency bias — boost held subnets' scores before any filtering/sorting.
	// This gives held subnets a lower effective entry threshold and higher ranking,
	// preventing churn when scores are close together.
	const bias = incumbencyBonus ?? 3;
	const biased = heldNetuids?.size
		? complete.map((s) =>
				heldNetuids.has(s.netuid) ? { ...s, score: s.score + bias } : s,
			)
		: complete;

	// Score gate — applied after bias so held subnets effectively need minScore − incumbencyBonus
	const aboveScore = biased.filter((s) => {
		if (s.score < cfg.minScore) {
			logger?.verbose(
				`${label(s.netuid)} excluded: score ${s.score}${heldNetuids?.has(s.netuid) ? ` (includes +${bias} bias)` : ""} < ${cfg.minScore}`,
			);
			return false;
		}
		return true;
	});

	// Absolute volume floor
	const minVolumeRao = cfg.minVolumeTao * RAO;
	const aboveFloor = aboveScore.filter((s) => {
		if (immuneNetuids?.has(s.netuid)) return true;
		if (Number(s.volume) < minVolumeRao) {
			logger?.verbose(
				`${label(s.netuid)} excluded: volume ${(Number(s.volume) / RAO).toFixed(0)} τ < ${cfg.minVolumeTao} τ`,
			);
			return false;
		}
		return true;
	});

	// Minimum mcap floor — reject micro-cap subnets susceptible to noise
	const minMcapRao = cfg.minMcapTao * RAO;
	const aboveMcap = aboveFloor.filter((s) => {
		if (immuneNetuids?.has(s.netuid)) return true;
		if (Number(s.mcap) < minMcapRao) {
			logger?.verbose(
				`${label(s.netuid)} excluded: mcap ${(Number(s.mcap) / RAO).toFixed(0)} τ < ${cfg.minMcapTao} τ`,
			);
			return false;
		}
		return true;
	});

	// Minimum holder count — reject concentrated/fragile subnets
	const enoughHolders = aboveMcap.filter((s) => {
		if (immuneNetuids?.has(s.netuid)) return true;
		if (s.totalHolders < cfg.minHolders) {
			logger?.verbose(
				`${label(s.netuid)} excluded: ${s.totalHolders} holders < ${cfg.minHolders}`,
			);
			return false;
		}
		return true;
	});

	// Minimum emission % — reject subnets not valued by root validators
	const enoughEmission = enoughHolders.filter((s) => {
		if (immuneNetuids?.has(s.netuid)) return true;
		if (s.emissionPct === null || s.emissionPct < cfg.minEmissionPct) {
			logger?.verbose(
				`${label(s.netuid)} excluded: emission ${s.emissionPct ?? 0}% < ${cfg.minEmissionPct}%`,
			);
			return false;
		}
		return true;
	});

	// Compute volume/mcap ratio for bottom-percentile dropout
	const withRatio = enoughEmission.map((s) => ({
		...s,
		volumeMcapRatio: Number(s.volume) / Number(s.mcap),
	}));

	if (withRatio.length === 0) return [];

	// Drop bottom percentile by volume/mcap ratio
	const ratios = withRatio.map((s) => s.volumeMcapRatio).sort((a, b) => a - b);
	const cutoffIdx = Math.floor(
		(cfg.bottomPercentileCutoff / 100) * ratios.length,
	);
	const cutoffValue = ratios[cutoffIdx] ?? 0;
	const filtered = withRatio.filter((s) => {
		if (immuneNetuids?.has(s.netuid)) return true;
		if (s.volumeMcapRatio < cutoffValue) {
			logger?.verbose(
				`${label(s.netuid)} excluded: vol/mcap ratio ${s.volumeMcapRatio.toFixed(4)} in bottom ${cfg.bottomPercentileCutoff}%`,
			);
			return false;
		}
		return true;
	});

	// Sort by SN45 leaderboard score descending
	filtered.sort((a, b) => b.score - a.score);

	for (const s of filtered) {
		const id = `SN${s.netuid}`.padEnd(5);
		const name = (subnetNames?.get(s.netuid) ?? "unknown").padEnd(20);
		logger?.verbose(`${id} - ${name} : ${s.score}`);
	}

	return filtered.map((s) => ({
		netuid: s.netuid,
		name: subnetNames?.get(s.netuid) ?? `SN${s.netuid}`,
		score: s.score,
	}));
}

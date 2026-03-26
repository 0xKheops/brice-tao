import type { Sn45Api } from "./api/generated/Sn45Api.ts";

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

const DEFAULT_CONFIG = {
	minScore: 70,
	minVolumeTao: 100,
	minMcapTao: 1_000,
	minHolders: 500,
	maxSellBuyRatio: 2,
	minEmissionPct: 0.5,
	bottomPercentileCutoff: 10,
} as const;

export interface StrategyConfig {
	/** Minimum SN45 leaderboard score to be considered (default: 70) */
	minScore?: number;
	/** Minimum 24h volume in TAO to be considered (default: 100) */
	minVolumeTao?: number;
	/** Minimum market cap in TAO — rejects micro-cap noise (default: 1000) */
	minMcapTao?: number;
	/** Minimum unique holder wallets — rejects concentrated/fragile subnets (default: 500) */
	minHolders?: number;
	/** Maximum sell/buy event ratio — rejects subnets with exodus-like selling pressure (default: 2) */
	maxSellBuyRatio?: number;
	/** Minimum emission % from root validators — rejects subnets not valued by the network (default: 0.5) */
	minEmissionPct?: number;
	/** Drop subnets in the bottom N% of volume/mcap ratio (default: 10) */
	bottomPercentileCutoff?: number;
}

export interface SubnetScore {
	netuid: number;
	name: string;
	score: number;
}

interface Logger {
	verbose: (msg: string) => void;
}

export async function pickBestSubnets(
	sn45: Sn45Api<unknown>,
	config?: StrategyConfig,
	activeNetuids?: Set<number>,
	logger?: Logger,
	subnetNames?: Map<number, string>,
): Promise<SubnetScore[]> {
	const cfg = {
		minScore: config?.minScore ?? DEFAULT_CONFIG.minScore,
		minVolumeTao: config?.minVolumeTao ?? DEFAULT_CONFIG.minVolumeTao,
		minMcapTao: config?.minMcapTao ?? DEFAULT_CONFIG.minMcapTao,
		minHolders: config?.minHolders ?? DEFAULT_CONFIG.minHolders,
		maxSellBuyRatio: config?.maxSellBuyRatio ?? DEFAULT_CONFIG.maxSellBuyRatio,
		minEmissionPct: config?.minEmissionPct ?? DEFAULT_CONFIG.minEmissionPct,
		bottomPercentileCutoff:
			config?.bottomPercentileCutoff ?? DEFAULT_CONFIG.bottomPercentileCutoff,
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

	// Score gate — first real quality filter
	const aboveScore = complete.filter((s) => {
		if (s.score < cfg.minScore) {
			logger?.verbose(
				`${label(s.netuid)} excluded: score ${s.score} < ${cfg.minScore}`,
			);
			return false;
		}
		return true;
	});

	// Absolute volume floor
	const minVolumeRao = cfg.minVolumeTao * RAO;
	const aboveFloor = aboveScore.filter((s) => {
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
		if (s.totalHolders < cfg.minHolders) {
			logger?.verbose(
				`${label(s.netuid)} excluded: ${s.totalHolders} holders < ${cfg.minHolders}`,
			);
			return false;
		}
		return true;
	});

	// Sell/buy ratio — reject subnets with exodus-like selling pressure
	const healthyFlow = enoughHolders.filter((s) => {
		if (s.buyCount === 0 && s.sellCount > 0) {
			logger?.verbose(
				`${label(s.netuid)} excluded: pure sell pressure (0 buys, ${s.sellCount} sells)`,
			);
			return false;
		}
		if (s.buyCount > 0 && s.sellCount / s.buyCount > cfg.maxSellBuyRatio) {
			logger?.verbose(
				`${label(s.netuid)} excluded: sell/buy ratio ${(s.sellCount / s.buyCount).toFixed(1)} > ${cfg.maxSellBuyRatio}`,
			);
			return false;
		}
		return true;
	});

	// Minimum emission % — reject subnets not valued by root validators
	const enoughEmission = healthyFlow.filter((s) => {
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

	return filtered.map((s) => ({
		netuid: s.netuid,
		name: subnetNames?.get(s.netuid) ?? `SN${s.netuid}`,
		score: s.score,
	}));
}

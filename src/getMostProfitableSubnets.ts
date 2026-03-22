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
}

interface QualifiedEntry extends LeaderboardEntry {
	priceChange: number;
	mcap: string;
	emaTaoFlow: string;
	volumeMcapRatio: number;
}

const DEFAULT_CONFIG = {
	minVolumeTao: 100,
	minMcapTao: 1_000,
	minHolders: 500,
	maxSellBuyRatio: 2,
	minEmissionPct: 0.5,
	bottomPercentileCutoff: 10,
	weights: { priceChange: 0.5, emaTaoFlow: 0.3, volumeMcapRatio: 0.2 },
} as const;

export interface MomentumConfig {
	/** Minimum 24h volume in TAO to be considered (default: 100) */
	minVolumeTao?: number;
	/** Minimum market cap in TAO — rejects micro-cap noise (default: 1000) */
	minMcapTao?: number;
	/** Minimum unique holder wallets — rejects concentrated/fragile subnets (default: 50) */
	minHolders?: number;
	/** Maximum sell/buy event ratio — rejects subnets with exodus-like selling pressure (default: 2) */
	maxSellBuyRatio?: number;
	/** Minimum emission % from root validators — rejects subnets not valued by the network (default: 0.5) */
	minEmissionPct?: number;
	/** Drop subnets in the bottom N% of volume/mcap ratio (default: 10) */
	bottomPercentileCutoff?: number;
	/** Signal weights (should sum to 1) */
	weights?: {
		priceChange?: number;
		emaTaoFlow?: number;
		volumeMcapRatio?: number;
	};
}

export interface SubnetMomentum {
	netuid: number;
	momentumScore: number;
	priceChange: number;
	emaTaoFlow: number;
	volumeMcapRatio: number;
	volume: number;
	mcap: number;
}

function zScores(values: number[]): number[] {
	const n = values.length;
	if (n === 0) return [];
	const mean = values.reduce((a, b) => a + b, 0) / n;
	const std = Math.sqrt(
		values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n,
	);
	if (std === 0) return values.map(() => 0);
	return values.map((v) => (v - mean) / std);
}

export async function getMostProfitableSubnets(
	sn45: Sn45Api<unknown>,
	config?: MomentumConfig,
	activeNetuids?: Set<number>,
): Promise<SubnetMomentum[]> {
	const cfg = {
		minVolumeTao: config?.minVolumeTao ?? DEFAULT_CONFIG.minVolumeTao,
		minMcapTao: config?.minMcapTao ?? DEFAULT_CONFIG.minMcapTao,
		minHolders: config?.minHolders ?? DEFAULT_CONFIG.minHolders,
		maxSellBuyRatio: config?.maxSellBuyRatio ?? DEFAULT_CONFIG.maxSellBuyRatio,
		minEmissionPct: config?.minEmissionPct ?? DEFAULT_CONFIG.minEmissionPct,
		bottomPercentileCutoff:
			config?.bottomPercentileCutoff ?? DEFAULT_CONFIG.bottomPercentileCutoff,
		weights: { ...DEFAULT_CONFIG.weights, ...config?.weights },
	};

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

	// Absolute volume floor
	const minVolumeRao = cfg.minVolumeTao * RAO;
	const aboveFloor = complete.filter((s) => Number(s.volume) >= minVolumeRao);

	// Minimum mcap floor — reject micro-cap subnets susceptible to noise
	const minMcapRao = cfg.minMcapTao * RAO;
	const aboveMcap = aboveFloor.filter((s) => Number(s.mcap) >= minMcapRao);

	// Minimum holder count — reject concentrated/fragile subnets
	const enoughHolders = aboveMcap.filter(
		(s) => s.totalHolders >= cfg.minHolders,
	);

	// Sell/buy ratio — reject subnets with exodus-like selling pressure
	const healthyFlow = enoughHolders.filter(
		(s) => s.buyCount === 0 || s.sellCount / s.buyCount <= cfg.maxSellBuyRatio,
	);

	// Minimum emission % — reject subnets not valued by root validators
	const enoughEmission = healthyFlow.filter(
		(s) => s.emissionPct !== null && s.emissionPct >= cfg.minEmissionPct,
	);

	// Compute volume/mcap ratio for each candidate
	const withRatio: QualifiedEntry[] = enoughEmission.map((s) => ({
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
	const filtered = withRatio.filter((s) => s.volumeMcapRatio >= cutoffValue);

	return scoreAndSort(filtered, cfg.weights);
}

function scoreAndSort(
	subnets: QualifiedEntry[],
	weights: { priceChange: number; emaTaoFlow: number; volumeMcapRatio: number },
): SubnetMomentum[] {
	const priceChanges = subnets.map((s) => s.priceChange);
	const emaFlows = subnets.map((s) => Number(s.emaTaoFlow));
	const vmRatios = subnets.map((s) => s.volumeMcapRatio);

	const zPrice = zScores(priceChanges);
	const zEma = zScores(emaFlows);
	const zVm = zScores(vmRatios);

	const results: SubnetMomentum[] = subnets.map((s, i) => ({
		netuid: s.netuid,
		momentumScore:
			// biome-ignore lint/style/noNonNullAssertion: checked in filter step
			weights.priceChange * zPrice[i]! +
			// biome-ignore lint/style/noNonNullAssertion: checked in filter step
			weights.emaTaoFlow * zEma[i]! +
			// biome-ignore lint/style/noNonNullAssertion: checked in filter step
			weights.volumeMcapRatio * zVm[i]!,
		priceChange: s.priceChange,
		emaTaoFlow: Number(s.emaTaoFlow),
		volumeMcapRatio: s.volumeMcapRatio,
		volume: Number(s.volume) / RAO,
		mcap: Number(s.mcap) / RAO,
	}));

	results.sort((a, b) => b.momentumScore - a.momentumScore);
	return results;
}

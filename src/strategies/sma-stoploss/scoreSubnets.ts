import { TAO } from "../../rebalance/tao.ts";
import type { SubnetOnChainData } from "./fetchSubnetData.ts";
import type {
	SmaStoplossStrategyConfig,
	StopOutRecord,
	SubnetPriceHistory,
} from "./types.ts";

/** Precision multiplier for scaled bigint math */
const PRECISION = 10n ** 18n;

/** Approximate blocks per day at 12s/block */
const BLOCKS_PER_DAY = 7200n;

/** Blocks per year at 12s/block: 365 × 7200 */
const BLOCKS_PER_YEAR = 365n * BLOCKS_PER_DAY;

export interface SubnetEvaluation {
	netuid: number;
	name: string;
	taoIn: bigint;
	/** Fast SMA value (I96F32), 0n if insufficient data */
	fastSma: bigint;
	/** Slow SMA value (I96F32), 0n if insufficient data */
	slowSma: bigint;
	/** Momentum strength: (fast - slow) / slow × PRECISION */
	momentumStrength: bigint;
	/** Annualized emission yield (scaled by PRECISION) */
	emissionYield: bigint;
	/** Blended score (momentum × weight + emission × weight) */
	score: bigint;
	passesAllGates: boolean;
	passesDepthGate: boolean;
	passesAgeGate: boolean;
	passesHealthGate: boolean;
	passesSmaDataGate: boolean;
	passesCrossoverGate: boolean;
	isCoolingDown: boolean;
}

export interface ScoreResult {
	winners: Array<{ netuid: number; name: string; score: bigint }>;
	evaluations: SubnetEvaluation[];
}

/**
 * Compute Simple Moving Average over an array of bigint prices.
 * Returns 0n if insufficient samples.
 */
function computeSMA(prices: bigint[], period: number): bigint {
	if (prices.length < period) return 0n;
	const recent = prices.slice(-period);
	let sum = 0n;
	for (const p of recent) sum += p;
	return sum / BigInt(period);
}

/**
 * Score subnets using SMA crossover momentum + emission yield.
 *
 * SMA crossover: fast SMA > slow SMA = bullish momentum.
 * Momentum strength = (fastSMA - slowSMA) / slowSMA (how far above crossover).
 * Blended score = momentum × momentumWeight + emission × emissionWeight.
 */
export function scoreSubnets(
	subnets: SubnetOnChainData[],
	config: SmaStoplossStrategyConfig,
	heldNetuids: Set<number>,
	currentBlock: bigint,
	priceHistories: Map<number, SubnetPriceHistory>,
	stoppedOut: Map<number, StopOutRecord>,
): ScoreResult {
	const minTaoInRao = BigInt(config.minTaoIn) * TAO;
	const minAgeBlocks = BigInt(config.minSubnetAgeDays) * BLOCKS_PER_DAY;
	const cooldownBlocks = BigInt(config.cooldownBlocks);

	const evaluations: SubnetEvaluation[] = [];
	const passing: Array<{
		netuid: number;
		name: string;
		momentumStrength: bigint;
		emissionYield: bigint;
	}> = [];

	for (const sn of subnets) {
		if (sn.netuid === 0) continue;

		const passesDepthGate = sn.taoIn > minTaoInRao;
		const passesHealthGate = !sn.isImmune && !sn.isPruneTarget;
		const subnetAge = currentBlock - sn.networkRegisteredAt;
		const passesAgeGate = subnetAge >= minAgeBlocks;

		// Division-by-zero guard
		const hasValidPrices = sn.alphaIn > 0n;

		// Check stop-loss cooldown
		const stopRecord = stoppedOut.get(sn.netuid);
		const isCoolingDown =
			stopRecord !== undefined &&
			currentBlock - BigInt(stopRecord.triggeredAtBlock) < cooldownBlocks;

		if (
			!passesDepthGate ||
			!passesHealthGate ||
			!passesAgeGate ||
			!hasValidPrices ||
			isCoolingDown
		) {
			evaluations.push({
				netuid: sn.netuid,
				name: sn.name,
				taoIn: sn.taoIn,
				fastSma: 0n,
				slowSma: 0n,
				momentumStrength: 0n,
				emissionYield: 0n,
				score: 0n,
				passesAllGates: false,
				passesDepthGate,
				passesAgeGate,
				passesHealthGate,
				passesSmaDataGate: false,
				passesCrossoverGate: false,
				isCoolingDown,
			});
			continue;
		}

		// Compute SMA from price history
		const history = priceHistories.get(sn.netuid);
		const prices = history ? history.samples.map((s) => s.price) : [];

		const fastSma = computeSMA(prices, config.smaFastPeriod);
		const slowSma = computeSMA(prices, config.smaSlowPeriod);

		const passesSmaDataGate = slowSma > 0n;
		const passesCrossoverGate = passesSmaDataGate && fastSma > slowSma;

		// Momentum strength: (fast - slow) / slow
		let momentumStrength = 0n;
		if (passesCrossoverGate && slowSma > 0n) {
			momentumStrength = ((fastSma - slowSma) * PRECISION) / slowSma;
		}

		// Market cap and emission yield
		const mcapRao = (sn.alphaOut * sn.taoIn) / sn.alphaIn;
		let emissionYield = 0n;
		if (mcapRao > 0n) {
			emissionYield =
				(sn.taoInEmission * BLOCKS_PER_YEAR * PRECISION) / mcapRao;
		}

		const passesAll = passesCrossoverGate;

		evaluations.push({
			netuid: sn.netuid,
			name: sn.name,
			taoIn: sn.taoIn,
			fastSma,
			slowSma,
			momentumStrength,
			emissionYield,
			score: 0n,
			passesAllGates: passesAll,
			passesDepthGate,
			passesAgeGate,
			passesHealthGate,
			passesSmaDataGate,
			passesCrossoverGate,
			isCoolingDown: false,
		});

		if (passesAll) {
			passing.push({
				netuid: sn.netuid,
				name: sn.name,
				momentumStrength,
				emissionYield,
			});
		}
	}

	if (passing.length === 0) {
		return { winners: [], evaluations };
	}

	// Normalize both metrics to [0, PRECISION] range
	let maxMomentum = 0n;
	let maxEmission = 0n;
	for (const p of passing) {
		if (p.momentumStrength > maxMomentum) maxMomentum = p.momentumStrength;
		if (p.emissionYield > maxEmission) maxEmission = p.emissionYield;
	}

	const scored: Array<{ netuid: number; name: string; score: bigint }> = [];

	for (const p of passing) {
		const normalizedMomentum =
			maxMomentum > 0n ? (p.momentumStrength * PRECISION) / maxMomentum : 0n;
		const normalizedEmission =
			maxEmission > 0n ? (p.emissionYield * PRECISION) / maxEmission : 0n;

		let score =
			(normalizedMomentum * BigInt(config.momentumWeight)) / 100n +
			(normalizedEmission * BigInt(config.emissionWeight)) / 100n;

		// Incumbency bonus for held subnets
		if (heldNetuids.has(p.netuid)) {
			score += (BigInt(config.incumbencyBonus) * PRECISION) / 100n;
		}

		// Update evaluation with final score
		const ev = evaluations.find((e) => e.netuid === p.netuid);
		if (ev) {
			ev.score = score;
		}

		scored.push({ netuid: p.netuid, name: p.name, score });
	}

	// Sort by score descending, take top maxSubnets
	scored.sort((a, b) => (b.score > a.score ? 1 : b.score < a.score ? -1 : 0));
	const winners = scored.slice(0, config.maxSubnets);

	return { winners, evaluations };
}

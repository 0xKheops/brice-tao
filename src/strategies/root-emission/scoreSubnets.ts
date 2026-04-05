import { TAO } from "../../rebalance/tao.ts";
import type { SubnetOnChainData } from "./fetchSubnetData.ts";
import type { RootEmissionStrategyConfig } from "./types.ts";

/** Precision scaling for bigint yield calculations */
const PRECISION = 10n ** 18n;

/** Blocks per day at 12s/block */
const BLOCKS_PER_DAY = 7200n;

/** Blocks per year at 12s/block: 365 × 7200 */
const BLOCKS_PER_YEAR = 365n * BLOCKS_PER_DAY;

export interface SubnetEvaluation {
	netuid: number;
	name: string;
	taoIn: bigint;
	alphaIn: bigint;
	alphaOut: bigint;
	taoInEmission: bigint;
	/** mcap = alphaOut × taoIn / alphaIn (in RAO) */
	mcapRao: bigint;
	/** Annualized emission yield (scaled bigint): taoInEmission × BLOCKS_PER_YEAR × PRECISION / mcapRao */
	emissionYield: bigint;
	/** emissionYield with incumbency bonus applied (scaled bigint) */
	biasedYield: bigint;
	/** Subnet age in days (approximate) */
	ageDays: number;
	isHeld: boolean;
	passesPoolGate: boolean;
	passesHealthGate: boolean;
	passesAgeGate: boolean;
	passesMcapGate: boolean;
	passesAllGates: boolean;
}

export interface ScoreResult {
	/** The single best emission subnet (or null if none qualify) */
	winner: SubnetEvaluation | null;
	/** All evaluated subnets for audit */
	evaluations: SubnetEvaluation[];
}

/**
 * Score all subnets by emission yield and select the best one.
 *
 * Gates applied:
 *  1. Exclude netuid 0 (root is added separately)
 *  2. tao_in > minTaoIn × TAO (liquidity gate)
 *  3. Not immune, not prune target (health gate)
 *  4. Subnet age > minSubnetAgeDays (age gate)
 *  5. mcapRao > 0 (avoids division by zero)
 *
 * Scoring: emissionYield = taoInEmission × BLOCKS_PER_YEAR × PRECISION / mcapRao
 * Incumbency bonus: additive bonus (scaled to same units) for held subnets
 */
export function scoreSubnets(
	subnets: SubnetOnChainData[],
	config: RootEmissionStrategyConfig,
	heldNetuids: Set<number>,
	currentBlockEstimate: bigint,
): ScoreResult {
	const minTaoInRao = BigInt(config.minTaoIn) * TAO;
	const minAgeBlocks = BigInt(config.minSubnetAgeDays) * BLOCKS_PER_DAY;

	const evaluations: SubnetEvaluation[] = [];

	for (const s of subnets) {
		// Skip root — it's added separately with fixed share
		if (s.netuid === 0) continue;

		const isHeld = heldNetuids.has(s.netuid);
		const passesPoolGate = s.taoIn > minTaoInRao;
		const passesHealthGate = !s.isImmune && !s.isPruneTarget;
		const subnetAge = currentBlockEstimate - s.networkRegisteredAt;
		const passesAgeGate = subnetAge >= minAgeBlocks;
		const ageDays = Number(subnetAge / BLOCKS_PER_DAY);

		// mcap = alphaOut × taoIn / alphaIn (bigint division)
		let mcapRao = 0n;
		if (s.alphaIn > 0n) {
			mcapRao = (s.alphaOut * s.taoIn) / s.alphaIn;
		}
		const passesMcapGate = mcapRao > 0n;

		// Annualized yield: tao_in_emission is per-block, scale to yearly
		let emissionYield = 0n;
		if (mcapRao > 0n) {
			emissionYield = (s.taoInEmission * BLOCKS_PER_YEAR * PRECISION) / mcapRao;
		}

		// Incumbency bonus: scale bonus to same precision units
		// bonus = incumbencyBonus × PRECISION / 100 (so bonus of 3 = 3% additive)
		const bonus = isHeld
			? (BigInt(config.incumbencyBonus) * PRECISION) / 100n
			: 0n;
		const biasedYield = emissionYield + bonus;

		const passesAllGates =
			passesPoolGate && passesHealthGate && passesAgeGate && passesMcapGate;

		evaluations.push({
			netuid: s.netuid,
			name: s.name,
			taoIn: s.taoIn,
			alphaIn: s.alphaIn,
			alphaOut: s.alphaOut,
			taoInEmission: s.taoInEmission,
			mcapRao,
			emissionYield,
			biasedYield,
			ageDays,
			isHeld,
			passesPoolGate,
			passesHealthGate,
			passesAgeGate,
			passesMcapGate,
			passesAllGates,
		});
	}

	// Sort by biasedYield descending
	const qualifying = evaluations
		.filter((e) => e.passesAllGates)
		.sort((a, b) => {
			if (b.biasedYield !== a.biasedYield)
				return b.biasedYield > a.biasedYield ? 1 : -1;
			// Tiebreaker: higher raw emission yield
			if (b.emissionYield !== a.emissionYield)
				return b.emissionYield > a.emissionYield ? 1 : -1;
			// Tiebreaker: lower netuid
			return a.netuid - b.netuid;
		});

	return {
		winner: qualifying[0] ?? null,
		evaluations,
	};
}

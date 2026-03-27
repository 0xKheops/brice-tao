/** Raw YAML config shape — human-friendly units (TAO, percentages) */
export interface RawConfig {
	rebalance: {
		maxSubnets: number;
		minPositionTao: number;
		freeReserveTao: number;
		minOperationTao: number;
		minStakeTao: number;
		minRebalanceTao: number;
		/** Slippage buffer for stake/unstake, in percent (e.g., 0.3 = 0.3%) */
		slippageBufferPercent: number;
		/** Slippage buffer for swaps, in percent (e.g., 2 = 2%) */
		swapSlippageBufferPercent: number;
		incumbencyBonus: number;
	};
	strategy: {
		minScore: number;
		minVolumeTao: number;
		minMcapTao: number;
		minHolders: number;
		minEmissionPct: number;
		/** Drop subnets in bottom N% of vol/mcap ratio (e.g., 10 = bottom 10%) */
		bottomPercentileCutoff: number;
	};
	health: {
		minPoolTao: number;
	};
}

/** Resolved config — ready for use in code (RAO bigints, decimal fractions) */
export interface AppConfig {
	rebalance: {
		maxSubnets: number;
		minPositionTao: bigint;
		freeReserveTao: bigint;
		minOperationTao: bigint;
		minStakeTao: bigint;
		minRebalanceTao: bigint;
		/** Slippage buffer as decimal fraction (e.g., 0.003 for 0.3%) */
		slippageBuffer: number;
		/** Swap slippage buffer as decimal fraction (e.g., 0.02 for 2%) */
		swapSlippageBuffer: number;
		incumbencyBonus: number;
	};
	strategy: {
		minScore: number;
		minVolumeTao: number;
		minMcapTao: number;
		minHolders: number;
		minEmissionPct: number;
		bottomPercentileCutoff: number;
	};
	health: {
		minPoolTao: number;
	};
}

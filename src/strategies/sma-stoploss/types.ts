// --- Raw YAML config shape (human-friendly units) ---

export interface RawSmaStoplossConfig {
	schedule: {
		rebalanceIntervalBlocks: number;
		staleTimeoutBlocks: number;
	};
	rebalance: {
		minPositionTao: number;
		freeReserveTao: number;
		freeReserveTaoDriftPercent: number;
		minOperationTao: number;
		minStakeTao: number;
		minRebalanceTao: number;
		slippageBufferPercent: number;
		enforceSlippage: boolean;
		allocationDriftPercent: number;
	};
	strategy: {
		maxSubnets: number;
		minTaoIn: number;
		minSubnetAgeDays: number;
		incumbencyBonus: number;
		smaFastPeriod: number;
		smaSlowPeriod: number;
		maxPriceSamples: number;
		momentumWeight: number;
		emissionWeight: number;
		stopLossPercent: number;
		cooldownBlocks: number;
	};
}

// --- Resolved strategy config (used by scoring/runner) ---

export interface SmaStoplossStrategyConfig {
	maxSubnets: number;
	minTaoIn: number;
	minSubnetAgeDays: number;
	incumbencyBonus: number;
	smaFastPeriod: number;
	smaSlowPeriod: number;
	maxPriceSamples: number;
	momentumWeight: number;
	emissionWeight: number;
	stopLossPercent: number;
	cooldownBlocks: number;
}

// --- Price history ---

export interface PriceSample {
	/** Block number at which price was sampled */
	blockNumber: number;
	/** Spot price in I96F32 scale: taoIn * 2^32 / alphaIn */
	price: bigint;
}

export interface SubnetPriceHistory {
	netuid: number;
	samples: PriceSample[];
}

// --- Stop-loss state ---

export interface StopLossEntry {
	netuid: number;
	/** High-water mark price (I96F32 scale) */
	highWaterMark: bigint;
	/** Current trailing stop price (I96F32 scale) */
	stopPrice: bigint;
}

export interface StopOutRecord {
	netuid: number;
	/** Block number when the stop was triggered */
	triggeredAtBlock: number;
	/** Price at which the stop triggered (I96F32 scale) */
	exitPrice: bigint;
}

// --- Shared state (runner → getStrategyTargets) ---

export interface SharedState {
	/** Price histories per subnet, keyed by netuid */
	priceHistories: Map<number, SubnetPriceHistory>;
	/** Currently stopped-out subnets */
	stoppedOut: Map<number, StopOutRecord>;
}

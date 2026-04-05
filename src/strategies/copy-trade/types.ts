/** Raw strategy-specific YAML config shape — human-friendly units */
export interface RawCopyTradeConfig {
	staleTimeoutMinutes: number;
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
		leaderAddress: string;
	};
}

/** Resolved strategy config */
export interface CopyTradeConfig {
	leaderAddress: string;
}

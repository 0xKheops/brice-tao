/** Raw YAML config shape — human-friendly units */
export interface RawRootEmissionConfig {
	schedule: {
		cronSchedule: string;
		staleTimeoutMinutes: number;
	};
	rebalance: {
		minPositionTao: number;
		freeReserveTao: number;
		/** Drift tolerance for reserve replenishment, in percent (e.g., 5 = 5%) */
		freeReserveTaoDriftPercent: number;
		minOperationTao: number;
		minStakeTao: number;
		minRebalanceTao: number;
		/** Slippage buffer for all operations, in percent (e.g., 3 = 3%) */
		slippageBufferPercent: number;
		/** If true, always use limit-price extrinsics. If false, use simple extrinsics when MEV shield is active. */
		enforceSlippage: boolean;
		allocationDriftPercent: number;
	};
	strategy: {
		rootSharePct: number;
		minTaoIn: number;
		minSubnetAgeDays: number;
		incumbencyBonus: number;
	};
}

/** Resolved strategy config */
export interface RootEmissionStrategyConfig {
	/** Fraction of portfolio allocated to root SN0 (e.g., 65 = 65%) */
	rootSharePct: number;
	/** Minimum TAO in AMM pool (in TAO units, converted to RAO when used) */
	minTaoIn: number;
	/** Minimum subnet age in days */
	minSubnetAgeDays: number;
	/** Additive score bonus for currently-held subnets */
	incumbencyBonus: number;
}

/** Raw YAML config shape — human-friendly units */
export interface RawCowardConfig {
	schedule: {
		cronSchedule: string;
		staleTimeoutMinutes: number;
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
}

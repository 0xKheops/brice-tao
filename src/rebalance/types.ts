export interface SwapOperation {
	kind: "swap";
	originNetuid: number;
	destinationNetuid: number;
	hotkey: string;
	/** Alpha amount to swap (raw from chain) */
	alphaAmount: bigint;
	/** Estimated TAO value of this swap */
	estimatedTaoValue: bigint;
	/** Price limit for destination alpha (with slippage buffer) */
	limitPrice: bigint;
}

export interface UnstakeOperation {
	kind: "unstake";
	netuid: number;
	hotkey: string;
	/** Alpha amount being unstaked (full position) */
	alphaAmount: bigint;
	/** Price limit for the unstake (min acceptable TAO/α price) */
	limitPrice: bigint;
	/** Estimated TAO value being unstaked */
	estimatedTaoValue: bigint;
}

export interface UnstakePartialOperation {
	kind: "unstake_partial";
	netuid: number;
	hotkey: string;
	/** Alpha amount to unstake */
	alphaAmount: bigint;
	/** Estimated TAO value being unstaked */
	estimatedTaoValue: bigint;
	/** Price limit for the unstake */
	limitPrice: bigint;
}

export interface StakeOperation {
	kind: "stake";
	netuid: number;
	hotkey: string;
	/** TAO amount to stake */
	taoAmount: bigint;
	/** Price limit for destination alpha (with slippage buffer) */
	limitPrice: bigint;
}

export type RebalanceOperation =
	| SwapOperation
	| UnstakeOperation
	| UnstakePartialOperation
	| StakeOperation;

export interface TargetSubnet {
	netuid: number;
	targetTaoValue: bigint;
}

export interface ClassifiedPosition {
	hotkey: string;
	netuid: number;
	stake: bigint;
	alphaPrice: bigint;
	taoValue: bigint;
	classification:
		| "keep" // in target set, correct hotkey
		| "exit_swap" // not in target set, correct hotkey (can swap)
		| "exit_unstake" // not in target set, wrong hotkey (must unstake)
		| "mismatch_in_target"; // in target set, wrong hotkey (unstake, restake next run)
}

export interface RebalancePlan {
	targets: TargetSubnet[];
	operations: RebalanceOperation[];
	/** Subnets not acted on because operation would be below minimum */
	skipped: Array<{ netuid: number; reason: string }>;
}

export interface OperationResult {
	/** 0-based index in the batch */
	index: number;
	success: boolean;
	/** Human-readable error description if failed */
	error?: string;
}

export type BatchResult =
	| {
			status: "completed";
			blockNumber: number;
			operationResults: OperationResult[];
	  }
	| {
			status: "partial_failure";
			blockNumber: number;
			operationResults: OperationResult[];
	  }
	| { status: "timeout" };

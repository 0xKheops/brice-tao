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

export interface MoveOperation {
	kind: "move";
	/** Subnet where the hotkey reassignment happens (origin subnet, before cross-subnet swap) */
	netuid: number;
	originHotkey: string;
	destinationHotkey: string;
	/** Alpha amount to move (use u64::MAX to sweep all) */
	alphaAmount: bigint;
}

export type RebalanceOperation =
	| SwapOperation
	| UnstakeOperation
	| UnstakePartialOperation
	| StakeOperation
	| MoveOperation;

export interface TargetSubnet {
	netuid: number;
	targetTaoValue: bigint;
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
			/** Fee paid for the MEV-shield wrapper tx (RAO) */
			wrapperFee: bigint;
			/** Fee paid for the inner batch tx (RAO) */
			innerBatchFee: bigint;
			/** Blake2-256 hash of the inner batch extrinsic */
			innerTxHash: string;
	  }
	| {
			status: "partial_failure";
			blockNumber: number;
			operationResults: OperationResult[];
			/** Fee paid for the MEV-shield wrapper tx (RAO) */
			wrapperFee: bigint;
			/** Fee paid for the inner batch tx (RAO) */
			innerBatchFee: bigint;
			/** Blake2-256 hash of the inner batch extrinsic */
			innerTxHash: string;
	  }
	| {
			status: "timeout";
			/** Fee paid for the MEV-shield wrapper tx (RAO), if known */
			wrapperFee?: bigint;
			/** Blake2-256 hash of the inner batch extrinsic */
			innerTxHash: string;
	  };

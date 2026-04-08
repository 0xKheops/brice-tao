/** Finalized block metadata from chain */
export interface BlockMeta {
	blockHash: string;
	blockNumber: number;
	/** Unix milliseconds */
	timestamp: number;
}

/** Raw on-chain snapshot for one subnet — superset of all strategy needs */
export interface SubnetSnapshot {
	netuid: number;
	name: string;
	taoIn: bigint;
	alphaIn: bigint;
	alphaOut: bigint;
	taoInEmission: bigint;
	/** Accurate spot price in I96F32 scale, from SwapRuntimeApi.current_alpha_price_all */
	spotPrice: bigint;
	/** Moving price in I96F32 scale, from dynamic_info.moving_price */
	movingPrice: bigint;
	/** Cumulative subnet volume (bigint) */
	subnetVolume: bigint;
	tempo: number;
	blocksSinceLastStep: bigint;
	networkRegisteredAt: bigint;
	/** Global NetworkImmunityPeriod at this block (same for all subnets) */
	immunityPeriod: number;
	/** Netuid marked for pruning at this block, or null (same for all subnets) */
	subnetToPrune: number | null;
}

/** Complete snapshot: block metadata + per-subnet data */
export interface HistorySnapshot {
	block: BlockMeta;
	subnets: SubnetSnapshot[];
}

// ---------------------------------------------------------------------------
// Position tracking
// ---------------------------------------------------------------------------

/** Rebalance cycle summary — one row per executeRebalanceCycle() call */
export interface CycleRecord {
	id?: number;
	strategy: string;
	gitCommit: string;
	blockNumber: number | null;
	txHash: string | null;
	/** Unix milliseconds */
	timestamp: number;
	status: "completed" | "partial_failure" | "timeout" | "no_ops" | "error";
	totalBefore: bigint;
	totalAfter: bigint;
	feeInner: bigint;
	feeWrapper: bigint;
	opsTotal: number;
	opsSucceeded: number;
	dryRun: boolean;
}

/** Per-operation trade record within a cycle */
export interface TradeRecord {
	cycleId: number;
	opIndex: number;
	opKind: string;
	netuid: number;
	originNetuid: number | null;
	hotkey: string;
	success: boolean;
	error: string | null;
	estimatedTao: bigint;
	alphaAmount: bigint | null;
	taoBefore: bigint | null;
	taoAfter: bigint | null;
	alphaBefore: bigint | null;
	alphaAfter: bigint | null;
	spotPrice: bigint | null;
}

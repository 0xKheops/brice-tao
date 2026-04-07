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

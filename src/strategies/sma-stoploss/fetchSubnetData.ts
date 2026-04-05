import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";

/** Conversion factor from ×1e9 runtime API prices to I96F32 fixed-point */
const F32 = 1n << 32n;
const PRICE_SCALE = 1_000_000_000n;

export interface SubnetOnChainData {
	netuid: number;
	name: string;
	taoIn: bigint;
	alphaIn: bigint;
	alphaOut: bigint;
	taoInEmission: bigint;
	/** Accurate spot price in I96F32 scale, from SwapRuntimeApi.current_alpha_price_all */
	spotPrice: bigint;
	blocksSinceLastStep: bigint;
	networkRegisteredAt: bigint;
	isImmune: boolean;
	isPruneTarget: boolean;
}

/**
 * Fetch on-chain dynamic info for all subnets with accurate spot prices.
 * Uses current_alpha_price_all() for prices (handles swap v3 CLMM correctly).
 */
export async function fetchAllSubnetData(
	api: TypedApi<typeof bittensor>,
): Promise<SubnetOnChainData[]> {
	const [dynamicInfos, immunityPeriod, subnetToPrune, alphaPrices] =
		await Promise.all([
			api.apis.SubnetInfoRuntimeApi.get_all_dynamic_info(),
			api.query.SubtensorModule.NetworkImmunityPeriod.getValue(),
			api.apis.SubnetInfoRuntimeApi.get_subnet_to_prune(),
			api.apis.SwapRuntimeApi.current_alpha_price_all(),
		]);

	// Build price lookup: netuid → I96F32 spot price
	const priceMap = new Map<number, bigint>();
	for (const entry of alphaPrices) {
		priceMap.set(entry.netuid, (entry.price * F32) / PRICE_SCALE);
	}

	// Current block approximation
	let currentBlock = 0n;
	for (const info of dynamicInfos) {
		if (info === undefined) continue;
		const estimate = info.network_registered_at + info.blocks_since_last_step;
		if (estimate > currentBlock) currentBlock = estimate;
	}

	const subnets: SubnetOnChainData[] = [];
	const decoder = new TextDecoder();

	for (const info of dynamicInfos) {
		if (info === undefined) continue;

		const name = decoder.decode(new Uint8Array(info.subnet_name)).trim();

		subnets.push({
			netuid: info.netuid,
			name,
			taoIn: info.tao_in,
			alphaIn: info.alpha_in,
			alphaOut: info.alpha_out,
			taoInEmission: info.tao_in_emission,
			spotPrice: priceMap.get(info.netuid) ?? 0n,
			blocksSinceLastStep: info.blocks_since_last_step,
			networkRegisteredAt: info.network_registered_at,
			isImmune: currentBlock - info.network_registered_at < immunityPeriod,
			isPruneTarget:
				subnetToPrune !== undefined && info.netuid === subnetToPrune,
		});
	}

	return subnets;
}

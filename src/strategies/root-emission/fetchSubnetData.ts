import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";

export interface SubnetOnChainData {
	netuid: number;
	name: string;
	taoIn: bigint;
	alphaIn: bigint;
	alphaOut: bigint;
	taoInEmission: bigint;
	subnetVolume: bigint;
	/** I96F32 raw value — divide by 2^32 for actual price */
	movingPrice: bigint;
	tempo: number;
	blocksSinceLastStep: bigint;
	networkRegisteredAt: bigint;
	isImmune: boolean;
	isPruneTarget: boolean;
}

/**
 * Fetch on-chain dynamic info for all subnets with fields needed for
 * emission-yield scoring: pool depths, emission, moving price, age.
 */
export async function fetchSubnetData(
	api: TypedApi<typeof bittensor>,
): Promise<SubnetOnChainData[]> {
	const [dynamicInfos, immunityPeriod, subnetToPrune] = await Promise.all([
		api.apis.SubnetInfoRuntimeApi.get_all_dynamic_info(),
		api.query.SubtensorModule.NetworkImmunityPeriod.getValue(),
		api.apis.SubnetInfoRuntimeApi.get_subnet_to_prune(),
	]);

	// Current block approximation from max(registered_at + blocks_since_last_step)
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
			subnetVolume: info.subnet_volume,
			movingPrice: info.moving_price,
			tempo: info.tempo,
			blocksSinceLastStep: info.blocks_since_last_step,
			networkRegisteredAt: info.network_registered_at,
			isImmune: currentBlock - info.network_registered_at < immunityPeriod,
			isPruneTarget:
				subnetToPrune !== undefined && info.netuid === subnetToPrune,
		});
	}

	return subnets;
}

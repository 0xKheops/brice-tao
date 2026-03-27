import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";

export interface SubnetInfo {
	netuid: number;
	name: string;
	taoInEmission: bigint;
	taoIn: bigint;
	subnetVolume: bigint;
	blocksSinceLastStep: bigint;
	tempo: number;
	/** Block at which this subnet was registered on-chain */
	networkRegisteredAt: bigint;
	/** Whether this subnet is still within its network immunity period */
	isImmune: boolean;
}

/**
 * Fetch on-chain dynamic info for all subnets, decode names, and
 * compute derived fields (immunity status, prune candidate).
 *
 * Returns the full dataset that both the rebalancer and the report
 * script consume — keeping a single source of truth for chain data.
 */
export async function fetchAllSubnets(
	api: TypedApi<typeof bittensor>,
): Promise<{
	subnets: SubnetInfo[];
	subnetNames: Map<number, string>;
	/** Netuid that would be deregistered next, if any */
	subnetToPrune: number | undefined;
}> {
	const [dynamicInfos, immunityPeriod, subnetToPrune] = await Promise.all([
		api.apis.SubnetInfoRuntimeApi.get_all_dynamic_info(),
		api.query.SubtensorModule.NetworkImmunityPeriod.getValue(),
		api.apis.SubnetInfoRuntimeApi.get_subnet_to_prune(),
	]);

	// Current block approximation: max network_registered_at + blocks_since_last_step
	// across all subnets gives us a close-enough proxy without an extra RPC call.
	let currentBlock = 0n;
	for (const info of dynamicInfos) {
		if (info === undefined) continue;
		const estimate = info.network_registered_at + info.blocks_since_last_step;
		if (estimate > currentBlock) currentBlock = estimate;
	}

	const subnets: SubnetInfo[] = [];
	const subnetNames = new Map<number, string>();
	const decoder = new TextDecoder();

	for (const info of dynamicInfos) {
		if (info === undefined) continue;

		const name = decoder.decode(new Uint8Array(info.subnet_name)).trim();
		subnetNames.set(info.netuid, name);

		subnets.push({
			netuid: info.netuid,
			name,
			taoInEmission: info.tao_in_emission,
			taoIn: info.tao_in,
			subnetVolume: info.subnet_volume,
			blocksSinceLastStep: info.blocks_since_last_step,
			tempo: info.tempo,
			networkRegisteredAt: info.network_registered_at,
			isImmune: currentBlock - info.network_registered_at < immunityPeriod,
		});
	}

	return { subnets, subnetNames, subnetToPrune };
}

import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { TAO } from "./rebalance/constants.ts";

/** Minimum TAO locked in subnet pool to consider it healthy */
const MIN_SUBNET_POOL_TAO = 1_000n * TAO;

export interface SubnetHealth {
	netuid: number;
	taoInEmission: bigint;
	taoIn: bigint;
	subnetVolume: bigint;
	blocksSinceLastStep: bigint;
	tempo: number;
}

/**
 * Fetch on-chain dynamic info for all subnets and return the set of
 * netuids that are "healthy" — receiving emission and having meaningful
 * liquidity. This filters out dead/dying subnets that may still be
 * technically registered on-chain.
 *
 * Criteria:
 *  - tao_in_emission > 0  (root validators allocate weight to this subnet)
 *  - tao_in >= MIN_SUBNET_POOL_TAO  (meaningful liquidity in the pool)
 */
export async function getHealthySubnets(
	api: TypedApi<typeof bittensor>,
	minPoolTao: bigint = MIN_SUBNET_POOL_TAO,
): Promise<{ healthyNetuids: Set<number>; allHealth: SubnetHealth[] }> {
	const dynamicInfos =
		await api.apis.SubnetInfoRuntimeApi.get_all_dynamic_info();

	const allHealth: SubnetHealth[] = [];
	const healthyNetuids = new Set<number>();

	for (const info of dynamicInfos) {
		if (info === undefined) continue;

		const health: SubnetHealth = {
			netuid: info.netuid,
			taoInEmission: info.tao_in_emission,
			taoIn: info.tao_in,
			subnetVolume: info.subnet_volume,
			blocksSinceLastStep: info.blocks_since_last_step,
			tempo: info.tempo,
		};
		allHealth.push(health);

		// Root subnet (0) is always healthy — it's our safe haven
		if (info.netuid === 0) {
			healthyNetuids.add(0);
			continue;
		}

		if (info.tao_in_emission > 0n && info.tao_in >= minPoolTao) {
			healthyNetuids.add(info.netuid);
		}
	}

	return { healthyNetuids, allHealth };
}

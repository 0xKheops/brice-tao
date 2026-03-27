import { TAO } from "../rebalance/constants.ts";
import type { SubnetInfo } from "./fetchAllSubnets.ts";
import { STRATEGY_DEFAULTS } from "./getBestSubnets.ts";

/**
 * Filter subnets down to the "healthy" set — those with meaningful
 * liquidity and not at risk of imminent deregistration.
 *
 * Criteria (bypassed for immune subnets):
 *  - tao_in >= minPoolTao  (meaningful liquidity in the pool)
 *  - not the subnet that would be pruned next
 *  - root subnet (0) is always included
 */
export function getHealthySubnets(
	subnets: SubnetInfo[],
	minPoolTao: bigint = BigInt(STRATEGY_DEFAULTS.minPoolTao) * TAO,
): Set<number> {
	const healthyNetuids = new Set<number>();

	for (const info of subnets) {
		// Root subnet (0) is always healthy — it's our safe haven
		if (info.netuid === 0) {
			healthyNetuids.add(0);
			continue;
		}

		// Immune subnets bypass all health gates
		if (info.isImmune) {
			healthyNetuids.add(info.netuid);
			continue;
		}

		// Exclude the subnet that would be deregistered next
		if (info.isPruneTarget) continue;

		if (info.taoIn >= minPoolTao) {
			healthyNetuids.add(info.netuid);
		}
	}

	return healthyNetuids;
}

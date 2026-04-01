import type { SubnetInfo } from "./fetchAllSubnets.ts";

/**
 * Filter subnets down to the "healthy" set — those not at risk of
 * imminent deregistration.
 *
 * Criteria:
 *  - not the subnet that would be pruned next
 *  - root subnet (0) is always included
 */
export function getHealthySubnets(subnets: SubnetInfo[]): Set<number> {
	const healthyNetuids = new Set<number>();

	for (const info of subnets) {
		// Root subnet (0) is always healthy — it's our safe haven
		if (info.netuid === 0) {
			healthyNetuids.add(0);
			continue;
		}

		// Exclude the subnet that would be deregistered next
		if (info.isPruneTarget) continue;

		healthyNetuids.add(info.netuid);
	}

	return healthyNetuids;
}

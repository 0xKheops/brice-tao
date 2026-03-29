import { describe, expect, it } from "bun:test";
import type { SubnetInfo } from "./fetchAllSubnets.ts";
import { getHealthySubnets } from "./getHealthySubnets.ts";

function makeSubnet(
	partial: Partial<SubnetInfo> & { netuid: number },
): SubnetInfo {
	return {
		netuid: partial.netuid,
		name: partial.name ?? `SN${partial.netuid}`,
		taoInEmission: partial.taoInEmission ?? 0n,
		taoIn: partial.taoIn ?? 0n,
		subnetVolume: partial.subnetVolume ?? 0n,
		blocksSinceLastStep: partial.blocksSinceLastStep ?? 0n,
		tempo: partial.tempo ?? 12,
		networkRegisteredAt: partial.networkRegisteredAt ?? 0n,
		isImmune: partial.isImmune ?? false,
		isPruneTarget: partial.isPruneTarget ?? false,
	};
}

describe("getHealthySubnets health filtering", () => {
	it("marks root as healthy and includes all non-prune-target subnets", () => {
		const subnets = [
			makeSubnet({ netuid: 0 }),
			makeSubnet({ netuid: 1 }),
			makeSubnet({ netuid: 2 }),
			makeSubnet({ netuid: 3 }),
		];

		const result = getHealthySubnets(subnets);

		expect([...result].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
	});

	it("excludes prune targets from healthy netuids", () => {
		const subnets = [
			makeSubnet({ netuid: 0 }),
			makeSubnet({ netuid: 10 }),
			makeSubnet({ netuid: 20, isPruneTarget: true }),
		];

		const result = getHealthySubnets(subnets);

		expect([...result].sort((a, b) => a - b)).toEqual([0, 10]);
	});

	it("returns empty set when no subnets are provided", () => {
		const result = getHealthySubnets([]);

		expect([...result]).toEqual([]);
	});

	it("excludes prune targets even when immune", () => {
		const subnets = [
			makeSubnet({
				netuid: 42,
				isPruneTarget: true,
				isImmune: true,
			}),
			makeSubnet({ netuid: 43, isPruneTarget: true }),
		];

		const result = getHealthySubnets(subnets);

		expect([...result]).toEqual([]);
	});
});

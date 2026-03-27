import { describe, expect, it } from "bun:test";
import { TAO } from "../rebalance/constants.ts";
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
	it("marks root as healthy and includes subnets with sufficient pool regardless of emission", () => {
		const subnets = [
			makeSubnet({ netuid: 0, taoIn: 1n }),
			makeSubnet({ netuid: 1, taoIn: 1_500n * TAO }),
			makeSubnet({ netuid: 2, taoIn: 10_000n * TAO }),
			makeSubnet({ netuid: 3, taoIn: 999n * TAO }),
		];

		const result = getHealthySubnets(subnets);

		expect([...result].sort((a, b) => a - b)).toEqual([0, 1, 2]);
	});

	it("respects custom minimum pool threshold for non-root subnet eligibility", () => {
		const subnets = [
			makeSubnet({ netuid: 5, taoIn: 3_000n * TAO }),
			makeSubnet({ netuid: 6, taoIn: 5_000n * TAO }),
		];

		const result = getHealthySubnets(subnets, 4_000n * TAO);

		expect([...result]).toEqual([6]);
	});

	it("excludes prune targets from healthy netuids", () => {
		const subnets = [
			makeSubnet({ netuid: 0, taoIn: 1n }),
			makeSubnet({ netuid: 10, taoIn: 5_000n * TAO }),
			makeSubnet({ netuid: 20, taoIn: 5_000n * TAO, isPruneTarget: true }),
		];

		const result = getHealthySubnets(subnets);

		expect([...result].sort((a, b) => a - b)).toEqual([0, 10]);
	});

	it("returns empty set when no subnets are provided", () => {
		const result = getHealthySubnets([]);

		expect([...result]).toEqual([]);
	});

	it("includes immune subnets regardless of pool liquidity and prune risk", () => {
		const subnets = [
			makeSubnet({
				netuid: 42,
				taoIn: 1n,
				isPruneTarget: true,
				isImmune: true,
			}),
			makeSubnet({ netuid: 43, taoIn: 1n, isPruneTarget: false }),
		];

		const result = getHealthySubnets(subnets);

		expect([...result]).toEqual([42]);
	});
});

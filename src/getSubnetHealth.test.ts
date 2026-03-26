import { describe, expect, it, vi } from "bun:test";
import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { getHealthySubnets } from "./getSubnetHealth.ts";
import { TAO } from "./rebalance/constants.ts";

interface DynamicInfoFixture {
	netuid: number;
	subnet_name: number[];
	tao_in_emission: bigint;
	tao_in: bigint;
	subnet_volume: bigint;
	blocks_since_last_step: bigint;
	tempo: number;
}

function makeDynamicInfo(
	partial: Partial<DynamicInfoFixture> & { netuid: number },
): DynamicInfoFixture {
	return {
		netuid: partial.netuid,
		subnet_name:
			partial.subnet_name ??
			Array.from(new TextEncoder().encode(`SN${partial.netuid}`)),
		tao_in_emission: partial.tao_in_emission ?? 0n,
		tao_in: partial.tao_in ?? 0n,
		subnet_volume: partial.subnet_volume ?? 0n,
		blocks_since_last_step: partial.blocks_since_last_step ?? 0n,
		tempo: partial.tempo ?? 12,
	};
}

function makeApi(dynamicInfos: Array<DynamicInfoFixture | undefined>): {
	api: TypedApi<typeof bittensor>;
	getAllDynamicInfo: ReturnType<typeof vi.fn>;
} {
	const getAllDynamicInfo = vi.fn().mockResolvedValue(dynamicInfos);
	const api = {
		apis: {
			SubnetInfoRuntimeApi: {
				get_all_dynamic_info: getAllDynamicInfo,
			},
		},
	} as unknown as TypedApi<typeof bittensor>;

	return { api, getAllDynamicInfo };
}

describe("getHealthySubnets health filtering", () => {
	it("marks root as healthy and includes only subnets with emission and sufficient pool", async () => {
		const dynamicInfos = [
			makeDynamicInfo({ netuid: 0, tao_in_emission: 0n, tao_in: 1n }),
			makeDynamicInfo({ netuid: 1, tao_in_emission: 1n, tao_in: 1_500n * TAO }),
			makeDynamicInfo({
				netuid: 2,
				tao_in_emission: 0n,
				tao_in: 10_000n * TAO,
			}),
			makeDynamicInfo({ netuid: 3, tao_in_emission: 5n, tao_in: 999n * TAO }),
		];
		const { api, getAllDynamicInfo } = makeApi(dynamicInfos);

		const result = await getHealthySubnets(api);

		expect(getAllDynamicInfo).toHaveBeenCalledTimes(1);
		expect([...result.healthyNetuids].sort((a, b) => a - b)).toEqual([0, 1]);
	});

	it("respects custom minimum pool threshold for non-root subnet eligibility", async () => {
		const dynamicInfos = [
			makeDynamicInfo({ netuid: 5, tao_in_emission: 7n, tao_in: 3_000n * TAO }),
			makeDynamicInfo({ netuid: 6, tao_in_emission: 7n, tao_in: 5_000n * TAO }),
		];
		const { api } = makeApi(dynamicInfos);

		const result = await getHealthySubnets(api, 4_000n * TAO);

		expect([...result.healthyNetuids]).toEqual([6]);
	});

	it("skips undefined runtime entries and still maps all health fields deterministically", async () => {
		const dynamicInfos = [
			undefined,
			makeDynamicInfo({
				netuid: 9,
				tao_in_emission: 11n,
				tao_in: 2_000n * TAO,
				subnet_volume: 321n,
				blocks_since_last_step: 99n,
				tempo: 42,
			}),
		];
		const { api } = makeApi(dynamicInfos);

		const result = await getHealthySubnets(api);

		expect(result.allHealth).toEqual([
			{
				netuid: 9,
				name: "SN9",
				taoInEmission: 11n,
				taoIn: 2_000n * TAO,
				subnetVolume: 321n,
				blocksSinceLastStep: 99n,
				tempo: 42,
			},
		]);
		expect([...result.healthyNetuids]).toEqual([9]);
		expect(result.subnetNames.get(9)).toBe("SN9");
	});

	it("returns empty structures when runtime API returns no dynamic info", async () => {
		const { api } = makeApi([]);

		const result = await getHealthySubnets(api);

		expect(result.allHealth).toEqual([]);
		expect([...result.healthyNetuids]).toEqual([]);
		expect(result.subnetNames.size).toBe(0);
	});
});

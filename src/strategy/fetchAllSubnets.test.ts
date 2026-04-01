import { describe, expect, it, vi } from "bun:test";
import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { TAO } from "../rebalance/constants.ts";
import { fetchAllSubnets } from "./fetchAllSubnets.ts";

interface DynamicInfoFixture {
	netuid: number;
	subnet_name: number[];
	tao_in_emission: bigint;
	tao_in: bigint;
	subnet_volume: bigint;
	blocks_since_last_step: bigint;
	tempo: number;
	network_registered_at: bigint;
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
		network_registered_at: partial.network_registered_at ?? 0n,
	};
}

function makeApi(
	dynamicInfos: Array<DynamicInfoFixture | undefined>,
	opts?: { immunityPeriod?: bigint; subnetToPrune?: number },
): TypedApi<typeof bittensor> {
	return {
		apis: {
			SubnetInfoRuntimeApi: {
				get_all_dynamic_info: vi.fn().mockResolvedValue(dynamicInfos),
				get_subnet_to_prune: vi.fn().mockResolvedValue(opts?.subnetToPrune),
			},
		},
		query: {
			SubtensorModule: {
				NetworkImmunityPeriod: {
					getValue: vi.fn().mockResolvedValue(opts?.immunityPeriod ?? 100_000n),
				},
			},
		},
	} as unknown as TypedApi<typeof bittensor>;
}

describe("fetchAllSubnets data fetching", () => {
	it("skips undefined runtime entries and maps all fields deterministically", async () => {
		const api = makeApi([
			undefined,
			makeDynamicInfo({
				netuid: 9,
				tao_in_emission: 11n,
				subnet_volume: 321n,
				blocks_since_last_step: 99n,
				tempo: 42,
				network_registered_at: 500n,
			}),
		]);

		const result = await fetchAllSubnets(api);

		expect(result).toEqual([
			{
				netuid: 9,
				name: "SN9",
				taoInEmission: 11n,
				subnetVolume: 321n,
				blocksSinceLastStep: 99n,
				tempo: 42,
				networkRegisteredAt: 500n,
				isImmune: true,
				isPruneTarget: false,
			},
		]);
	});

	it("returns empty array when runtime API returns no dynamic info", async () => {
		const api = makeApi([]);

		const result = await fetchAllSubnets(api);

		expect(result).toEqual([]);
	});

	it("computes immunity status based on registration age vs immunity period", async () => {
		const api = makeApi(
			[
				makeDynamicInfo({
					netuid: 1,
					tao_in: 2_000n * TAO,
					network_registered_at: 900n,
					blocks_since_last_step: 100n,
				}),
				makeDynamicInfo({
					netuid: 2,
					tao_in: 2_000n * TAO,
					network_registered_at: 100n,
					blocks_since_last_step: 100n,
				}),
			],
			{ immunityPeriod: 500n },
		);
		// currentBlock ≈ max(900+100, 100+100) = 1000
		// SN1 age = 1000 - 900 = 100, immunity = 500 → immune
		// SN2 age = 1000 - 100 = 900, immunity = 500 → not immune

		const result = await fetchAllSubnets(api);

		const sn1 = result.find((s) => s.netuid === 1);
		const sn2 = result.find((s) => s.netuid === 2);
		expect(sn1?.isImmune).toBe(true);
		expect(sn2?.isImmune).toBe(false);
	});

	it("marks the subnet-to-prune as isPruneTarget", async () => {
		const api = makeApi(
			[
				makeDynamicInfo({ netuid: 10, tao_in: 5_000n * TAO }),
				makeDynamicInfo({ netuid: 20, tao_in: 5_000n * TAO }),
			],
			{ subnetToPrune: 10 },
		);

		const result = await fetchAllSubnets(api);

		expect(result.find((s) => s.netuid === 10)?.isPruneTarget).toBe(true);
		expect(result.find((s) => s.netuid === 20)?.isPruneTarget).toBe(false);
	});
});

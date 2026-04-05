import { describe, expect, it, mock } from "bun:test";
import { TAO } from "../../rebalance/tao.ts";

mock.module("../../rebalance/logger.ts", () => ({
	log: { info: () => {}, warn: () => {}, error: () => {}, verbose: () => {} },
}));

import type { SubnetOnChainData } from "./fetchSubnetData.ts";
import { scoreSubnets } from "./scoreSubnets.ts";
import type { RootEmissionStrategyConfig } from "./types.ts";

const PRECISION = 10n ** 18n;
const BLOCKS_PER_DAY = 7200n;
const BLOCKS_PER_YEAR = 365n * BLOCKS_PER_DAY;

const defaultConfig: RootEmissionStrategyConfig = {
	rootSharePct: 65,
	minTaoIn: 100,
	minSubnetAgeDays: 7,
	incumbencyBonus: 3,
};

const CURRENT_BLOCK = 1_000_000n;

function makeSubnet(
	overrides: Partial<SubnetOnChainData> = {},
): SubnetOnChainData {
	return {
		netuid: 1,
		name: "test-subnet",
		taoIn: 200n * TAO,
		alphaIn: 500n * TAO,
		alphaOut: 1000n * TAO,
		taoInEmission: 1_000_000n,
		subnetVolume: 0n,
		movingPrice: 0n,
		tempo: 360,
		blocksSinceLastStep: 0n,
		networkRegisteredAt: CURRENT_BLOCK - 30n * BLOCKS_PER_DAY,
		isImmune: false,
		isPruneTarget: false,
		...overrides,
	};
}

describe("scoreSubnets", () => {
	describe("empty / root-only input", () => {
		it("returns null winner for empty array", () => {
			const result = scoreSubnets([], defaultConfig, new Set(), CURRENT_BLOCK);
			expect(result.winner).toBeNull();
			expect(result.evaluations).toHaveLength(0);
		});

		it("returns null winner when only root subnet is present", () => {
			const root = makeSubnet({ netuid: 0, name: "root" });
			const result = scoreSubnets(
				[root],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.winner).toBeNull();
			expect(result.evaluations).toHaveLength(0);
		});
	});

	describe("skips root subnet (netuid 0)", () => {
		it("never includes netuid 0 in evaluations", () => {
			const subnets = [
				makeSubnet({ netuid: 0, name: "root" }),
				makeSubnet({ netuid: 1, name: "alpha" }),
			];
			const result = scoreSubnets(
				subnets,
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations.every((e) => e.netuid !== 0)).toBe(true);
			expect(result.evaluations).toHaveLength(1);
		});
	});

	describe("pool gate", () => {
		it("fails when taoIn is below minTaoIn * TAO", () => {
			const subnet = makeSubnet({ taoIn: 99n * TAO });
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations[0]?.passesPoolGate).toBe(false);
			expect(result.evaluations[0]?.passesAllGates).toBe(false);
			expect(result.winner).toBeNull();
		});

		it("fails when taoIn equals minTaoIn * TAO (strictly greater required)", () => {
			const subnet = makeSubnet({ taoIn: 100n * TAO });
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations[0]?.passesPoolGate).toBe(false);
		});

		it("passes when taoIn is above minTaoIn * TAO", () => {
			const subnet = makeSubnet({ taoIn: 101n * TAO });
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations[0]?.passesPoolGate).toBe(true);
		});
	});

	describe("health gate", () => {
		it("fails when subnet is immune", () => {
			const subnet = makeSubnet({ isImmune: true });
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations[0]?.passesHealthGate).toBe(false);
			expect(result.evaluations[0]?.passesAllGates).toBe(false);
		});

		it("fails when subnet is a prune target", () => {
			const subnet = makeSubnet({ isPruneTarget: true });
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations[0]?.passesHealthGate).toBe(false);
			expect(result.evaluations[0]?.passesAllGates).toBe(false);
		});

		it("passes when subnet is neither immune nor prune target", () => {
			const subnet = makeSubnet({ isImmune: false, isPruneTarget: false });
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations[0]?.passesHealthGate).toBe(true);
		});
	});

	describe("age gate", () => {
		it("fails when subnet is too young", () => {
			const youngRegistration =
				CURRENT_BLOCK -
				BigInt(defaultConfig.minSubnetAgeDays) * BLOCKS_PER_DAY +
				1n;
			const subnet = makeSubnet({ networkRegisteredAt: youngRegistration });
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations[0]?.passesAgeGate).toBe(false);
			expect(result.evaluations[0]?.passesAllGates).toBe(false);
		});

		it("passes when subnet age exactly equals minSubnetAgeDays", () => {
			const exactRegistration =
				CURRENT_BLOCK - BigInt(defaultConfig.minSubnetAgeDays) * BLOCKS_PER_DAY;
			const subnet = makeSubnet({ networkRegisteredAt: exactRegistration });
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations[0]?.passesAgeGate).toBe(true);
		});

		it("passes when subnet is older than minSubnetAgeDays", () => {
			const subnet = makeSubnet({
				networkRegisteredAt: CURRENT_BLOCK - 60n * BLOCKS_PER_DAY,
			});
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations[0]?.passesAgeGate).toBe(true);
			expect(result.evaluations[0]?.ageDays).toBe(60);
		});
	});

	describe("mcap gate", () => {
		it("fails when alphaIn is 0 (division by zero guard)", () => {
			const subnet = makeSubnet({ alphaIn: 0n });
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations[0]?.mcapRao).toBe(0n);
			expect(result.evaluations[0]?.passesMcapGate).toBe(false);
			expect(result.evaluations[0]?.emissionYield).toBe(0n);
			expect(result.evaluations[0]?.passesAllGates).toBe(false);
		});

		it("fails when mcap computes to zero (taoIn or alphaOut is 0)", () => {
			const subnet = makeSubnet({ taoIn: 200n * TAO, alphaOut: 0n });
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations[0]?.mcapRao).toBe(0n);
			expect(result.evaluations[0]?.passesMcapGate).toBe(false);
		});

		it("passes when mcap is positive", () => {
			const subnet = makeSubnet();
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			const expected = (subnet.alphaOut * subnet.taoIn) / subnet.alphaIn;
			expect(result.evaluations[0]?.mcapRao).toBe(expected);
			expect(result.evaluations[0]?.passesMcapGate).toBe(true);
		});
	});

	describe("winner selection", () => {
		it("selects the subnet with highest biasedYield", () => {
			const low = makeSubnet({ netuid: 1, taoInEmission: 500_000n });
			const high = makeSubnet({ netuid: 2, taoInEmission: 2_000_000n });
			const result = scoreSubnets(
				[low, high],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.winner).not.toBeNull();
			expect(result.winner?.netuid).toBe(2);
		});

		it("returns null when all subnets fail at least one gate", () => {
			const immune = makeSubnet({ netuid: 1, isImmune: true });
			const young = makeSubnet({
				netuid: 2,
				networkRegisteredAt: CURRENT_BLOCK - 1n * BLOCKS_PER_DAY,
			});
			const result = scoreSubnets(
				[immune, young],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.winner).toBeNull();
			expect(result.evaluations).toHaveLength(2);
		});
	});

	describe("incumbency bonus", () => {
		it("applies additive bonus to held subnets", () => {
			const subnet = makeSubnet({ netuid: 5 });
			const notHeld = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			const held = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set([5]),
				CURRENT_BLOCK,
			);

			const expectedBonus =
				(BigInt(defaultConfig.incumbencyBonus) * PRECISION) / 100n;
			// biome-ignore lint/style/noNonNullAssertion: test assertion
			expect(held.evaluations[0]!.isHeld).toBe(true);
			// biome-ignore lint/style/noNonNullAssertion: test assertion
			expect(notHeld.evaluations[0]!.isHeld).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: test assertion
			expect(held.evaluations[0]!.biasedYield).toBe(
				// biome-ignore lint/style/noNonNullAssertion: test assertion
				notHeld.evaluations[0]!.biasedYield + expectedBonus,
			);
			// biome-ignore lint/style/noNonNullAssertion: test assertion
			expect(held.evaluations[0]!.emissionYield).toBe(
				// biome-ignore lint/style/noNonNullAssertion: test assertion
				notHeld.evaluations[0]!.emissionYield,
			);
		});

		it("bonus can change the winner", () => {
			const higherEmission = makeSubnet({
				netuid: 1,
				taoInEmission: 2_000_000n,
			});
			const lowerEmission = makeSubnet({
				netuid: 2,
				taoInEmission: 1_900_000n,
			});

			const withoutBonus = scoreSubnets(
				[higherEmission, lowerEmission],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(withoutBonus.winner?.netuid).toBe(1);

			// Give netuid 2 a large incumbency bonus
			const bigBonus: RootEmissionStrategyConfig = {
				...defaultConfig,
				incumbencyBonus: 100,
			};
			const withBonus = scoreSubnets(
				[higherEmission, lowerEmission],
				bigBonus,
				new Set([2]),
				CURRENT_BLOCK,
			);
			expect(withBonus.winner?.netuid).toBe(2);
		});
	});

	describe("tiebreaker", () => {
		it("same biasedYield → higher raw emissionYield wins", () => {
			// mcap = BLOCKS_PER_YEAR so yield = emission * PRECISION exactly.
			// bonus of 100 (= 1 * PRECISION) equalizes emission diff of 1.
			const tieConfig: RootEmissionStrategyConfig = {
				...defaultConfig,
				minTaoIn: 0,
				incumbencyBonus: 100,
			};
			const a = makeSubnet({
				netuid: 1,
				taoInEmission: 2n,
				taoIn: BLOCKS_PER_YEAR,
				alphaIn: TAO,
				alphaOut: TAO,
			});
			const b = makeSubnet({
				netuid: 2,
				taoInEmission: 1n,
				taoIn: BLOCKS_PER_YEAR,
				alphaIn: TAO,
				alphaOut: TAO,
			});

			const result = scoreSubnets(
				[a, b],
				tieConfig,
				new Set([2]),
				CURRENT_BLOCK,
			);

			// biome-ignore lint/style/noNonNullAssertion: test assertion
			const evalA = result.evaluations.find((e) => e.netuid === 1)!;
			// biome-ignore lint/style/noNonNullAssertion: test assertion
			const evalB = result.evaluations.find((e) => e.netuid === 2)!;
			expect(evalA.biasedYield).toBe(evalB.biasedYield);
			expect(evalA.emissionYield).toBeGreaterThan(evalB.emissionYield);

			// Higher raw emissionYield (subnet A) should win
			expect(result.winner?.netuid).toBe(1);
		});

		it("same biasedYield and emissionYield → lower netuid wins", () => {
			// Identical subnets, different netuids
			const a = makeSubnet({ netuid: 5 });
			const b = makeSubnet({ netuid: 3 });
			const result = scoreSubnets(
				[a, b],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			expect(result.evaluations.find((e) => e.netuid === 5)?.biasedYield).toBe(
				result.evaluations.find((e) => e.netuid === 3)?.biasedYield,
			);
			expect(result.winner?.netuid).toBe(3);
		});
	});

	describe("multiple subnets — mixed gates", () => {
		it("correctly identifies winner among passing and failing subnets", () => {
			const passing1 = makeSubnet({ netuid: 1, taoInEmission: 1_000_000n });
			const immune = makeSubnet({
				netuid: 2,
				isImmune: true,
				taoInEmission: 5_000_000n,
			});
			const lowPool = makeSubnet({ netuid: 3, taoIn: 10n * TAO });
			const passing2 = makeSubnet({ netuid: 4, taoInEmission: 3_000_000n });
			const young = makeSubnet({
				netuid: 5,
				networkRegisteredAt: CURRENT_BLOCK - 1n * BLOCKS_PER_DAY,
				taoInEmission: 10_000_000n,
			});
			const zeroAlpha = makeSubnet({ netuid: 6, alphaIn: 0n });

			const subnets = [passing1, immune, lowPool, passing2, young, zeroAlpha];
			const result = scoreSubnets(
				subnets,
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);

			expect(result.evaluations).toHaveLength(6);

			// Only netuid 1 and 4 should pass all gates
			const passing = result.evaluations.filter((e) => e.passesAllGates);
			expect(passing.map((e) => e.netuid).sort()).toEqual([1, 4]);

			// Netuid 4 has higher emission → should win
			expect(result.winner?.netuid).toBe(4);

			// Verify individual gate failures
			// biome-ignore lint/style/noNonNullAssertion: test assertion
			const evalImmune = result.evaluations.find((e) => e.netuid === 2)!;
			expect(evalImmune.passesHealthGate).toBe(false);

			// biome-ignore lint/style/noNonNullAssertion: test assertion
			const evalLowPool = result.evaluations.find((e) => e.netuid === 3)!;
			expect(evalLowPool.passesPoolGate).toBe(false);

			// biome-ignore lint/style/noNonNullAssertion: test assertion
			const evalYoung = result.evaluations.find((e) => e.netuid === 5)!;
			expect(evalYoung.passesAgeGate).toBe(false);

			// biome-ignore lint/style/noNonNullAssertion: test assertion
			const evalZero = result.evaluations.find((e) => e.netuid === 6)!;
			expect(evalZero.passesMcapGate).toBe(false);
		});
	});

	describe("emission yield calculation", () => {
		it("computes expected mcapRao and emissionYield", () => {
			const subnet = makeSubnet({
				taoIn: 200n * TAO,
				alphaIn: 500n * TAO,
				alphaOut: 1000n * TAO,
				taoInEmission: 1_000_000n,
			});
			const result = scoreSubnets(
				[subnet],
				defaultConfig,
				new Set(),
				CURRENT_BLOCK,
			);
			// biome-ignore lint/style/noNonNullAssertion: test assertion
			const e = result.evaluations[0]!;

			const expectedMcap = (1000n * TAO * 200n * TAO) / (500n * TAO);
			expect(e.mcapRao).toBe(expectedMcap);

			const expectedYield =
				(1_000_000n * BLOCKS_PER_YEAR * PRECISION) / expectedMcap;
			expect(e.emissionYield).toBe(expectedYield);
			expect(e.biasedYield).toBe(expectedYield);
		});
	});
});

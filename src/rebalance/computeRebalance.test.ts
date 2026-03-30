import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Balances, StakeEntry } from "../balances/getBalances.ts";
import type { AppConfig } from "../config/types.ts";
import type { SubnetScore } from "../subnets/getBestSubnets.ts";
import { computeRebalance } from "./computeRebalance.ts";
import * as pickValidatorModule from "./pickBestValidator.ts";
import { parseTao, TAO } from "./tao.ts";

const TEST_CONFIG: AppConfig["rebalance"] = {
	maxSubnets: 10,
	minPositionTao: parseTao(0.5),
	freeReserveTao: parseTao(0.05),
	minOperationTao: parseTao(0.01),
	minStakeTao: parseTao(0.01),
	minRebalanceTao: parseTao(0.25),
	slippageBuffer: 0.003,
	swapSlippageBuffer: 0.02,
	incumbencyBonus: 3,
};

const {
	freeReserveTao: FREE_RESERVE_TAO,
	maxSubnets: MAX_SUBNETS,
	minOperationTao: MIN_OPERATION_TAO,
	minPositionTao: MIN_POSITION_TAO,
	minRebalanceTao: MIN_REBALANCE_TAO,
	minStakeTao: MIN_STAKE_TAO,
} = TEST_CONFIG;

function hotkey(id: string): string {
	return `5${id.padEnd(47, "a")}`;
}

function makeStake(
	partial: Partial<StakeEntry> & Pick<StakeEntry, "netuid">,
): StakeEntry {
	const taoValue = partial.taoValue ?? TAO;
	return {
		netuid: partial.netuid,
		hotkey: partial.hotkey ?? hotkey(String(partial.netuid)),
		stake: partial.stake ?? TAO,
		alphaPrice: partial.alphaPrice ?? TAO,
		taoValue,
	};
}

function makeBalances(partial?: Partial<Balances>): Balances {
	return {
		free: partial?.free ?? 0n,
		reserved: partial?.reserved ?? 0n,
		stakes: partial?.stakes ?? [],
		totalTaoValue: partial?.totalTaoValue ?? partial?.free ?? 0n,
	};
}

function eligible(...netuids: number[]): SubnetScore[] {
	return netuids.map((netuid, i) => ({
		netuid,
		name: `SN${netuid}`,
		score: 100 - i,
	}));
}

const fakeApi = {} as Parameters<typeof computeRebalance>[0];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("computeRebalance target choice and weird cases", () => {
	it("returns an empty plan when total value is not above free reserve", async () => {
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO,
			free: FREE_RESERVE_TAO,
		});
		const pickSpy = vi.spyOn(pickValidatorModule, "pickBestValidatorByYield");

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(1, 2, 3),
			TEST_CONFIG,
		);

		expect(plan.targets).toEqual([]);
		expect(plan.operations).toEqual([]);
		expect(plan.skipped).toEqual([]);
		expect(pickSpy).not.toHaveBeenCalled();
	});

	it("uses exactly one target when available TAO is only enough for one minimum position", async () => {
		const fallback = hotkey("fallback");
		const pickSpy = vi
			.spyOn(pickValidatorModule, "pickBestValidatorByYield")
			.mockRejectedValue(new Error("no yield candidate"));
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + MIN_POSITION_TAO + 1n,
			free: FREE_RESERVE_TAO + MIN_POSITION_TAO + 1n,
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(11, 22, 33),
			TEST_CONFIG,
			fallback,
		);

		expect(plan.targets).toHaveLength(1);
		expect(plan.targets[0]).toMatchObject({ netuid: 11 });
		expect(plan.targets[0]?.targetTaoValue).toBe(MIN_POSITION_TAO + 1n);
		expect(pickSpy).toHaveBeenCalledWith(fakeApi, 11);
	});

	it("caps target count at MAX_SUBNETS when many eligible subnets exist", async () => {
		const pickSpy = vi
			.spyOn(pickValidatorModule, "pickBestValidatorByYield")
			.mockResolvedValue({
				hotkey: hotkey("picked"),
				candidate: {
					uid: 1,
					hotkey: hotkey("picked"),
					alphaStake: TAO,
					alphaDividends: 1n,
					yieldPerAlpha: 1,
				},
			});
		const balances = makeBalances({
			totalTaoValue:
				FREE_RESERVE_TAO + BigInt(MAX_SUBNETS + 5) * MIN_POSITION_TAO,
			free: FREE_RESERVE_TAO + BigInt(MAX_SUBNETS + 5) * MIN_POSITION_TAO,
		});
		const many = eligible(
			...Array.from({ length: MAX_SUBNETS + 8 }, (_, i) => i + 1),
		);

		const plan = await computeRebalance(fakeApi, balances, many, TEST_CONFIG);

		expect(plan.targets).toHaveLength(MAX_SUBNETS);
		expect(plan.targets.map((t) => t.netuid)).toEqual(
			Array.from({ length: MAX_SUBNETS }, (_, i) => i + 1),
		);
		expect(pickSpy).toHaveBeenCalledTimes(MAX_SUBNETS);
	});

	it("pads to subnet 0 when no eligible subnet is available", async () => {
		const fallback = hotkey("fallback");
		const pickSpy = vi
			.spyOn(pickValidatorModule, "pickBestValidatorByYield")
			.mockRejectedValue(new Error("no yield candidate"));
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + 3n * MIN_POSITION_TAO,
			free: FREE_RESERVE_TAO + 3n * MIN_POSITION_TAO,
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			[],
			TEST_CONFIG,
			fallback,
		);

		expect(plan.targets).toEqual([
			{
				netuid: 0,
				targetTaoValue: 3n * MIN_POSITION_TAO,
			},
		]);
		expect(pickSpy).toHaveBeenCalledWith(fakeApi, 0);
	});

	it("splits target allocation evenly with bigint truncation remainder", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockResolvedValue(
			{
				hotkey: hotkey("picked"),
				candidate: {
					uid: 7,
					hotkey: hotkey("picked"),
					alphaStake: TAO,
					alphaDividends: 1n,
					yieldPerAlpha: 1,
				},
			},
		);
		const available = 5n * TAO + 2n;
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + available,
			free: FREE_RESERVE_TAO + available,
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(2, 4),
			TEST_CONFIG,
		);

		expect(plan.targets).toEqual([
			{ netuid: 2, targetTaoValue: 2500000001n },
			{ netuid: 4, targetTaoValue: 2500000001n },
		]);
	});

	it("reuses largest existing position hotkey on target subnet before yield lookup", async () => {
		const pickSpy = vi.spyOn(pickValidatorModule, "pickBestValidatorByYield");
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + 2n * MIN_POSITION_TAO,
			free: FREE_RESERVE_TAO + 2n * MIN_POSITION_TAO,
			stakes: [
				makeStake({ netuid: 7, hotkey: hotkey("small"), taoValue: TAO }),
				makeStake({ netuid: 7, hotkey: hotkey("large"), taoValue: 2n * TAO }),
			],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(7),
			TEST_CONFIG,
		);

		expect(pickSpy).not.toHaveBeenCalled();
		expect(plan.operations).toContainEqual({
			kind: "unstake_partial",
			netuid: 7,
			hotkey: hotkey("large"),
			alphaAmount: TAO,
			limitPrice: 0n,
			estimatedTaoValue: TAO,
		});
	});

	it("breaks existing hotkey ties alphabetically and uses that hotkey for target stake", async () => {
		vi.spyOn(
			pickValidatorModule,
			"pickBestValidatorByYield",
		).mockImplementation(async (_api, netuid) => ({
			hotkey: hotkey(`picked-${netuid}`),
			candidate: {
				uid: netuid,
				hotkey: hotkey(`picked-${netuid}`),
				alphaStake: TAO,
				alphaDividends: 1n,
				yieldPerAlpha: 1,
			},
		}));
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + 2n * MIN_POSITION_TAO,
			free: FREE_RESERVE_TAO + parseTao(0.5),
			stakes: [
				makeStake({
					netuid: 9,
					hotkey: "5beta".padEnd(48, "b"),
					taoValue: parseTao(0.05),
					stake: parseTao(0.05),
				}),
				makeStake({
					netuid: 9,
					hotkey: "5alpha".padEnd(48, "a"),
					taoValue: parseTao(0.05),
					stake: parseTao(0.05),
				}),
				makeStake({
					netuid: 50,
					hotkey: "5alpha".padEnd(48, "a"),
					taoValue: parseTao(0.5),
					stake: parseTao(0.5),
				}),
			],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(9, 10),
			TEST_CONFIG,
		);

		// SN50 exit is swapped to SN10 (sufficient deficit), with move since hotkeys differ
		expect(plan.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "swap",
					originNetuid: 50,
					destinationNetuid: 10,
				}),
			]),
		);
		// SN9 stake uses the alphabetically-first existing hotkey (alpha < beta)
		expect(plan.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "stake",
					netuid: 9,
					hotkey: "5alpha".padEnd(48, "a"),
				}),
			]),
		);
	});

	it("records a skip when validator resolution fails and no fallback hotkey is provided", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockRejectedValue(
			new Error("Subnet 33 not found"),
		);
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + MIN_POSITION_TAO,
			free: FREE_RESERVE_TAO + MIN_POSITION_TAO,
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(33),
			TEST_CONFIG,
		);

		expect(plan.skipped).toContainEqual({
			netuid: 33,
			reason: "No validator selected for SN33: Subnet 33 not found",
		});
	});

	it("prefers swap without move when target shares the same hotkey", async () => {
		vi.spyOn(
			pickValidatorModule,
			"pickBestValidatorByYield",
		).mockImplementation(async (_api, netuid) => ({
			hotkey: netuid === 10 ? hotkey("src") : hotkey("other"),
			candidate: {
				uid: netuid,
				hotkey: netuid === 10 ? hotkey("src") : hotkey("other"),
				alphaStake: TAO,
				alphaDividends: 1n,
				yieldPerAlpha: 1,
			},
		}));
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + 3n * TAO,
			free: FREE_RESERVE_TAO,
			stakes: [
				makeStake({
					netuid: 99,
					hotkey: hotkey("src"),
					stake: TAO,
					taoValue: TAO,
				}),
			],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(10, 11),
			TEST_CONFIG,
		);

		expect(plan.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "swap",
					originNetuid: 99,
					destinationNetuid: 10,
					hotkey: hotkey("src"),
				}),
			]),
		);
		expect(
			plan.operations.find(
				(op) =>
					op.kind === "unstake" &&
					op.netuid === 99 &&
					op.hotkey === hotkey("src"),
			),
		).toBeUndefined();
	});

	it("swaps full exits with move when target has different hotkey", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockResolvedValue(
			{
				hotkey: hotkey("different"),
				candidate: {
					uid: 1,
					hotkey: hotkey("different"),
					alphaStake: TAO,
					alphaDividends: 1n,
					yieldPerAlpha: 1,
				},
			},
		);
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + 2n * TAO,
			free: FREE_RESERVE_TAO,
			stakes: [
				makeStake({ netuid: 77, hotkey: hotkey("source"), taoValue: TAO }),
			],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(5),
			TEST_CONFIG,
		);

		expect(plan.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "swap",
					originNetuid: 77,
					destinationNetuid: 5,
					hotkey: hotkey("source"),
				}),
				expect.objectContaining({
					kind: "move",
					netuid: 5,
					originHotkey: hotkey("source"),
					destinationHotkey: hotkey("different"),
				}),
			]),
		);
		expect(
			plan.operations.find((op) => op.kind === "unstake" && op.netuid === 77),
		).toBeUndefined();
	});

	it("skips dust exits below minimum operation threshold", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockResolvedValue(
			{
				hotkey: hotkey("picked"),
				candidate: {
					uid: 1,
					hotkey: hotkey("picked"),
					alphaStake: TAO,
					alphaDividends: 1n,
					yieldPerAlpha: 1,
				},
			},
		);
		const dust = MIN_OPERATION_TAO - 1n;
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + TAO,
			free: FREE_RESERVE_TAO,
			stakes: [
				makeStake({
					netuid: 44,
					hotkey: hotkey("dust"),
					taoValue: dust,
					stake: dust,
					alphaPrice: TAO,
				}),
			],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(2),
			TEST_CONFIG,
		);

		expect(
			plan.operations.find((op) => "netuid" in op && op.netuid === 44),
		).toBeUndefined();
		expect(plan.skipped).toContainEqual({
			netuid: 44,
			reason: "Position too small to exit (0.009 τ)",
		});
	});

	it("does not reduce a below-target keep position and reports remaining funding deficit", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockResolvedValue(
			{
				hotkey: hotkey("picked"),
				candidate: {
					uid: 8,
					hotkey: hotkey("picked"),
					alphaStake: TAO,
					alphaDividends: 1n,
					yieldPerAlpha: 1,
				},
			},
		);
		const positionValue = MIN_STAKE_TAO + 5n;
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + TAO,
			free: FREE_RESERVE_TAO,
			stakes: [
				makeStake({
					netuid: 8,
					hotkey: hotkey("picked"),
					taoValue: positionValue,
					stake: positionValue,
				}),
			],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(8, 9),
			TEST_CONFIG,
		);

		expect(
			plan.operations.find(
				(op) => op.kind === "unstake_partial" && op.netuid === 8,
			),
		).toBeUndefined();
		expect(
			plan.skipped.some(
				(s) =>
					s.netuid === 8 &&
					s.reason.startsWith("Insufficient free balance for target"),
			),
		).toBe(true);
	});

	it("adds stake operations from free balance after counting unstake proceeds", async () => {
		vi.spyOn(
			pickValidatorModule,
			"pickBestValidatorByYield",
		).mockImplementation(async (_api, netuid) => ({
			hotkey: hotkey(String(netuid)),
			candidate: {
				uid: netuid,
				hotkey: hotkey(String(netuid)),
				alphaStake: TAO,
				alphaDividends: 1n,
				yieldPerAlpha: 1,
			},
		}));
		// Exit position (1 TAO) exceeds per-target deficit (~0.66 TAO) so it must unstake
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + 2n * TAO,
			free: FREE_RESERVE_TAO,
			stakes: [makeStake({ netuid: 70, hotkey: hotkey("70"), taoValue: TAO })],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(1, 2, 3),
			TEST_CONFIG,
		);

		expect(
			plan.operations.some((op) => op.kind === "unstake" && op.netuid === 70),
		).toBe(true);
		expect(plan.operations.some((op) => op.kind === "stake")).toBe(true);
	});

	it("reserves FREE_RESERVE_TAO from unstake proceeds when free balance is zero", async () => {
		vi.spyOn(
			pickValidatorModule,
			"pickBestValidatorByYield",
		).mockImplementation(async (_api, netuid) => ({
			hotkey: hotkey(String(netuid)),
			candidate: {
				uid: netuid,
				hotkey: hotkey(String(netuid)),
				alphaStake: TAO,
				alphaDividends: 1n,
				yieldPerAlpha: 1,
			},
		}));
		// Exit position (2 TAO) exceeds per-target deficit (1 TAO each) so it must unstake
		const unstakeValue = 2n * TAO;
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + unstakeValue,
			free: 0n,
			stakes: [
				makeStake({
					netuid: 70,
					hotkey: hotkey("70"),
					taoValue: unstakeValue,
					stake: unstakeValue,
				}),
			],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(1, 2),
			TEST_CONFIG,
		);

		const unstake = plan.operations.find(
			(op) => op.kind === "unstake" && op.netuid === 70,
		);
		expect(unstake).toBeDefined();

		// Total staked should equal unstake proceeds minus reserve
		const stakes = plan.operations.filter((op) => op.kind === "stake");
		const totalStaked = stakes.reduce(
			(sum, op) => sum + (op.kind === "stake" ? op.taoAmount : 0n),
			0n,
		);
		expect(totalStaked).toBe(unstakeValue - FREE_RESERVE_TAO);
	});

	it("reports insufficient free balance per target when deficits cannot be funded", async () => {
		vi.spyOn(
			pickValidatorModule,
			"pickBestValidatorByYield",
		).mockImplementation(async (_api, netuid) => ({
			hotkey: hotkey(String(netuid)),
			candidate: {
				uid: netuid,
				hotkey: hotkey(String(netuid)),
				alphaStake: TAO,
				alphaDividends: 1n,
				yieldPerAlpha: 1,
			},
		}));
		const available = 3n * MIN_POSITION_TAO;
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + available,
			free: FREE_RESERVE_TAO + MIN_REBALANCE_TAO,
			stakes: [],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(1, 2, 3),
			TEST_CONFIG,
		);
		const insufficient = plan.skipped.filter((s) =>
			s.reason.startsWith("Insufficient free balance for target"),
		);

		expect(insufficient.length).toBeGreaterThan(0);
	});

	it("skips overweight reduction below MIN_REBALANCE_TAO", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockResolvedValue(
			{
				hotkey: hotkey("picked"),
				candidate: {
					uid: 1,
					hotkey: hotkey("picked"),
					alphaStake: TAO,
					alphaDividends: 1n,
					yieldPerAlpha: 1,
				},
			},
		);
		const targetPerSubnet = 2n * TAO;
		const smallExcess = MIN_REBALANCE_TAO - 1n;
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + targetPerSubnet,
			free: FREE_RESERVE_TAO,
			stakes: [
				makeStake({
					netuid: 5,
					hotkey: hotkey("picked"),
					taoValue: targetPerSubnet + smallExcess,
					stake: targetPerSubnet + smallExcess,
				}),
			],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(5),
			TEST_CONFIG,
		);

		expect(
			plan.operations.find(
				(op) =>
					(op.kind === "unstake_partial" && op.netuid === 5) ||
					(op.kind === "swap" && op.originNetuid === 5),
			),
		).toBeUndefined();
	});

	it("skips stake when deficit is below MIN_REBALANCE_TAO", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockResolvedValue(
			{
				hotkey: hotkey("picked"),
				candidate: {
					uid: 1,
					hotkey: hotkey("picked"),
					alphaStake: TAO,
					alphaDividends: 1n,
					yieldPerAlpha: 1,
				},
			},
		);
		const targetPerSubnet = 2n * TAO;
		const smallDeficit = MIN_REBALANCE_TAO - 1n;
		const positionValue = targetPerSubnet - smallDeficit;
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + targetPerSubnet,
			free: FREE_RESERVE_TAO + TAO,
			stakes: [
				makeStake({
					netuid: 5,
					hotkey: hotkey("picked"),
					taoValue: positionValue,
					stake: positionValue,
				}),
			],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(5),
			TEST_CONFIG,
		);

		expect(
			plan.operations.find((op) => op.kind === "stake" && op.netuid === 5),
		).toBeUndefined();
	});

	it("still exits small non-target positions above MIN_OPERATION_TAO", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockResolvedValue(
			{
				hotkey: hotkey("picked"),
				candidate: {
					uid: 1,
					hotkey: hotkey("picked"),
					alphaStake: TAO,
					alphaDividends: 1n,
					yieldPerAlpha: 1,
				},
			},
		);
		const smallPosition = MIN_OPERATION_TAO * 10n; // 0.1 TAO — above MIN_OPERATION_TAO but below MIN_REBALANCE_TAO
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + TAO,
			free: FREE_RESERVE_TAO,
			stakes: [
				makeStake({
					netuid: 44,
					hotkey: hotkey("exit"),
					taoValue: smallPosition,
					stake: smallPosition,
				}),
			],
		});

		const plan = await computeRebalance(
			fakeApi,
			balances,
			eligible(2),
			TEST_CONFIG,
		);

		expect(
			plan.operations.find(
				(op) =>
					(op.kind === "swap" && op.originNetuid === 44) ||
					(op.kind === "unstake" && op.netuid === 44),
			),
		).toBeDefined();
	});
});

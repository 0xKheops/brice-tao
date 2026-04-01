import { describe, expect, it } from "bun:test";
import type { Balances, StakeEntry } from "../balances/getBalances.ts";
import type { AppConfig } from "../config/types.ts";
import { computeRebalance } from "./computeRebalance.ts";
import { parseTao, TAO } from "./tao.ts";
import type { StrategyTarget } from "./types.ts";

const TEST_CONFIG: AppConfig["rebalance"] = {
	minPositionTao: parseTao(0.5),
	freeReserveTao: parseTao(0.05),
	freeReserveTaoDriftPercent: 0.05,
	minOperationTao: parseTao(0.01),
	minStakeTao: parseTao(0.01),
	minRebalanceTao: parseTao(0.25),
	slippageBuffer: 0.003,
	swapSlippageBuffer: 0.02,
};

const {
	freeReserveTao: FREE_RESERVE_TAO,
	minOperationTao: MIN_OPERATION_TAO,
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

/** Create equal-weight strategy targets */
function targets(
	...entries: Array<{ netuid: number; hotkey?: string }>
): StrategyTarget[] {
	const share = 1 / entries.length;
	return entries.map((e) => ({
		netuid: e.netuid,
		hotkey: e.hotkey ?? hotkey(String(e.netuid)),
		share,
	}));
}

describe("computeRebalance", () => {
	it("returns an empty plan when targets are empty", () => {
		const balances = makeBalances({ free: TAO, totalTaoValue: TAO });

		const plan = computeRebalance(balances, [], TEST_CONFIG);

		expect(plan.targets).toEqual([]);
		expect(plan.operations).toEqual([]);
	});

	it("prefers swap without move when target shares the same hotkey", () => {
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

		const plan = computeRebalance(
			balances,
			targets(
				{ netuid: 10, hotkey: hotkey("src") },
				{ netuid: 11, hotkey: hotkey("other") },
			),
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

	it("moves hotkey on origin subnet then swaps when target has different hotkey", () => {
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + 2n * TAO,
			free: FREE_RESERVE_TAO,
			stakes: [
				makeStake({ netuid: 77, hotkey: hotkey("source"), taoValue: TAO }),
			],
		});

		const plan = computeRebalance(
			balances,
			targets({ netuid: 5, hotkey: hotkey("different") }),
			TEST_CONFIG,
		);

		const moveIdx = plan.operations.findIndex(
			(op) => op.kind === "move" && op.netuid === 77,
		);
		const swapIdx = plan.operations.findIndex(
			(op) => op.kind === "swap" && op.originNetuid === 77,
		);
		expect(moveIdx).toBeGreaterThanOrEqual(0);
		expect(swapIdx).toBeGreaterThanOrEqual(0);
		expect(moveIdx).toBeLessThan(swapIdx);

		expect(plan.operations[moveIdx]).toEqual(
			expect.objectContaining({
				kind: "move",
				netuid: 77,
				originHotkey: hotkey("source"),
				destinationHotkey: hotkey("different"),
			}),
		);
		expect(plan.operations[swapIdx]).toEqual(
			expect.objectContaining({
				kind: "swap",
				originNetuid: 77,
				destinationNetuid: 5,
				hotkey: hotkey("different"),
			}),
		);
	});

	it("skips dust exits below minimum operation threshold", () => {
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

		const plan = computeRebalance(
			balances,
			targets({ netuid: 2 }),
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

	it("does not reduce a below-target keep position and reports remaining funding deficit", () => {
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

		const plan = computeRebalance(
			balances,
			targets({ netuid: 8, hotkey: hotkey("picked") }, { netuid: 9 }),
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

	it("adds stake operations from free balance after counting unstake proceeds", () => {
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + 2n * TAO,
			free: FREE_RESERVE_TAO,
			stakes: [makeStake({ netuid: 70, hotkey: hotkey("70"), taoValue: TAO })],
		});

		const plan = computeRebalance(
			balances,
			targets({ netuid: 1 }, { netuid: 2 }, { netuid: 3 }),
			TEST_CONFIG,
		);

		expect(
			plan.operations.some(
				(op) => op.kind === "swap" && op.originNetuid === 70,
			),
		).toBe(true);
		expect(
			plan.operations.some((op) => op.kind === "unstake" && op.netuid === 70),
		).toBe(false);
	});

	it("reserves FREE_RESERVE_TAO from unstake proceeds when free balance is zero", () => {
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

		const plan = computeRebalance(
			balances,
			targets({ netuid: 1 }, { netuid: 2 }, { netuid: 3 }),
			TEST_CONFIG,
		);

		const unstake = plan.operations.find(
			(op) => op.kind === "unstake" && op.netuid === 70,
		);
		expect(unstake).toBeDefined();

		const stakes = plan.operations.filter((op) => op.kind === "stake");
		const totalStaked = stakes.reduce(
			(sum, op) => sum + (op.kind === "stake" ? op.taoAmount : 0n),
			0n,
		);
		expect(totalStaked).toBe(unstakeValue - FREE_RESERVE_TAO);
	});

	it("reports insufficient free balance per target when deficits cannot be funded", () => {
		const available = 3n * parseTao(0.5);
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + available,
			free: FREE_RESERVE_TAO + MIN_REBALANCE_TAO,
			stakes: [],
		});

		const plan = computeRebalance(
			balances,
			targets({ netuid: 1 }, { netuid: 2 }, { netuid: 3 }),
			TEST_CONFIG,
		);
		const insufficient = plan.skipped.filter((s) =>
			s.reason.startsWith("Insufficient free balance for target"),
		);

		expect(insufficient.length).toBeGreaterThan(0);
	});

	it("skips overweight reduction below MIN_REBALANCE_TAO", () => {
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

		const plan = computeRebalance(
			balances,
			targets({ netuid: 5, hotkey: hotkey("picked") }),
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

	it("skips stake when deficit is below MIN_REBALANCE_TAO", () => {
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

		const plan = computeRebalance(
			balances,
			targets({ netuid: 5, hotkey: hotkey("picked") }),
			TEST_CONFIG,
		);

		expect(
			plan.operations.find((op) => op.kind === "stake" && op.netuid === 5),
		).toBeUndefined();
	});

	it("still exits small non-target positions above MIN_OPERATION_TAO", () => {
		const smallPosition = MIN_OPERATION_TAO * 10n;
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

		const plan = computeRebalance(
			balances,
			targets({ netuid: 2 }),
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

	it("swaps exit position that slightly exceeds target (overfill within 2× cap)", () => {
		const totalTao = parseTao(2.157);
		const balances = makeBalances({
			totalTaoValue: totalTao,
			free: parseTao(0.087),
			stakes: [
				makeStake({ netuid: 24, taoValue: parseTao(0.529) }),
				makeStake({ netuid: 54, taoValue: parseTao(0.501) }),
				makeStake({ netuid: 58, taoValue: parseTao(0.564) }),
				makeStake({ netuid: 84, taoValue: parseTao(0.419) }),
			],
		});

		const plan = computeRebalance(
			balances,
			targets(
				{ netuid: 24, hotkey: hotkey("validator") },
				{ netuid: 54, hotkey: hotkey("validator") },
				{ netuid: 84, hotkey: hotkey("validator") },
				{ netuid: 112, hotkey: hotkey("validator") },
			),
			TEST_CONFIG,
		);

		expect(plan.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "swap",
					originNetuid: 58,
					destinationNetuid: 112,
				}),
			]),
		);
		expect(
			plan.operations.find((op) => op.kind === "unstake" && op.netuid === 58),
		).toBeUndefined();
		expect(
			plan.operations.find((op) => op.kind === "stake" && op.netuid === 112),
		).toBeUndefined();
	});

	it("unstakes when exit position exceeds 2× target allocation", () => {
		const balances = makeBalances({
			totalTaoValue: parseTao(3.6),
			free: parseTao(0.1),
			stakes: [
				makeStake({
					netuid: 50,
					taoValue: parseTao(0.5),
					stake: parseTao(0.5),
				}),
				makeStake({
					netuid: 99,
					taoValue: parseTao(3.0),
					stake: parseTao(3.0),
				}),
			],
		});

		const plan = computeRebalance(
			balances,
			targets(
				{ netuid: 50, hotkey: hotkey("validator") },
				{ netuid: 10, hotkey: hotkey("validator") },
				{ netuid: 20, hotkey: hotkey("validator") },
			),
			TEST_CONFIG,
		);

		expect(
			plan.operations.find((op) => op.kind === "unstake" && op.netuid === 99),
		).toBeDefined();
		expect(
			plan.operations.find(
				(op) => op.kind === "swap" && op.originNetuid === 99,
			),
		).toBeUndefined();
	});

	it("swaps overweight reduction that slightly overfills destination", () => {
		const balances = makeBalances({
			totalTaoValue: parseTao(2.0),
			free: parseTao(0.05) + FREE_RESERVE_TAO,
			stakes: [
				makeStake({
					netuid: 10,
					taoValue: parseTao(1.3),
					stake: parseTao(1.3),
				}),
				makeStake({
					netuid: 20,
					taoValue: parseTao(0.6),
					stake: parseTao(0.6),
				}),
			],
		});

		const plan = computeRebalance(
			balances,
			targets(
				{ netuid: 10, hotkey: hotkey("validator") },
				{ netuid: 20, hotkey: hotkey("validator") },
			),
			TEST_CONFIG,
		);

		expect(plan.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "swap",
					originNetuid: 10,
					destinationNetuid: 20,
				}),
			]),
		);
		expect(
			plan.operations.find(
				(op) => op.kind === "unstake_partial" && op.netuid === 10,
			),
		).toBeUndefined();
	});

	describe("reserve replenishment", () => {
		it("unstakes from biggest exit position when free < reserve", () => {
			const freeBalance = parseTao(0.01);
			const deficit = FREE_RESERVE_TAO - freeBalance;
			const hk = hotkey("shared");
			const balances = makeBalances({
				totalTaoValue: parseTao(3.06),
				free: freeBalance,
				stakes: [
					makeStake({
						netuid: 99,
						hotkey: hk,
						taoValue: 2n * TAO,
						stake: 2n * TAO,
					}),
					makeStake({
						netuid: 10,
						hotkey: hk,
						taoValue: TAO,
						stake: TAO,
					}),
				],
			});

			const plan = computeRebalance(
				balances,
				targets({ netuid: 10, hotkey: hk }),
				TEST_CONFIG,
			);

			expect(plan.operations[0]).toEqual(
				expect.objectContaining({
					kind: "unstake_partial",
					netuid: 99,
					estimatedTaoValue: deficit,
				}),
			);
		});

		it("prefers exit over keep for replenishment even if keep is bigger", () => {
			const freeBalance = parseTao(0.01);
			const deficit = FREE_RESERVE_TAO - freeBalance;
			const hk = hotkey("shared");
			const balances = makeBalances({
				totalTaoValue: parseTao(5.01),
				free: freeBalance,
				stakes: [
					makeStake({
						netuid: 10,
						hotkey: hk,
						taoValue: 3n * TAO,
						stake: 3n * TAO,
					}),
					makeStake({
						netuid: 99,
						hotkey: hk,
						taoValue: 2n * TAO,
						stake: 2n * TAO,
					}),
				],
			});

			const plan = computeRebalance(
				balances,
				targets({ netuid: 10, hotkey: hk }),
				TEST_CONFIG,
			);

			expect(plan.operations[0]).toEqual(
				expect.objectContaining({
					kind: "unstake_partial",
					netuid: 99,
					estimatedTaoValue: deficit,
				}),
			);
		});

		it("falls back to biggest keep position when no exits exist", () => {
			const freeBalance = parseTao(0.01);
			const deficit = FREE_RESERVE_TAO - freeBalance;
			const hk = hotkey("shared");
			const balances = makeBalances({
				totalTaoValue: parseTao(3.01),
				free: freeBalance,
				stakes: [
					makeStake({
						netuid: 10,
						hotkey: hk,
						taoValue: 2n * TAO,
						stake: 2n * TAO,
					}),
					makeStake({
						netuid: 20,
						hotkey: hk,
						taoValue: TAO,
						stake: TAO,
					}),
				],
			});

			const plan = computeRebalance(
				balances,
				targets({ netuid: 10, hotkey: hk }, { netuid: 20, hotkey: hk }),
				TEST_CONFIG,
			);

			expect(plan.operations[0]).toEqual(
				expect.objectContaining({
					kind: "unstake_partial",
					netuid: 10,
					estimatedTaoValue: deficit,
				}),
			);
		});

		it("skips replenishment when deficit is below minOperationTao", () => {
			const freeBalance = FREE_RESERVE_TAO - MIN_OPERATION_TAO + 1n;
			const balances = makeBalances({
				totalTaoValue: freeBalance + 2n * TAO,
				free: freeBalance,
				stakes: [
					makeStake({ netuid: 99, taoValue: 2n * TAO, stake: 2n * TAO }),
				],
			});

			const plan = computeRebalance(
				balances,
				targets({ netuid: 10 }),
				TEST_CONFIG,
			);

			expect(
				plan.operations.find(
					(op) =>
						op.kind === "unstake_partial" &&
						op.estimatedTaoValue < MIN_OPERATION_TAO,
				),
			).toBeUndefined();
		});

		it("skips replenishment when biggest position cannot cover deficit", () => {
			const freeBalance = parseTao(0.01);
			const deficit = FREE_RESERVE_TAO - freeBalance;
			const smallPosition = deficit + MIN_STAKE_TAO - 1n;
			const balances = makeBalances({
				totalTaoValue: freeBalance + smallPosition,
				free: freeBalance,
				stakes: [
					makeStake({
						netuid: 99,
						taoValue: smallPosition,
						stake: smallPosition,
					}),
				],
			});

			const plan = computeRebalance(
				balances,
				targets({ netuid: 10 }),
				TEST_CONFIG,
			);

			const replenish = plan.operations.find(
				(op) => op.kind === "unstake_partial" && op.netuid === 99,
			);
			expect(replenish).toBeUndefined();
		});

		it("does not replenish when free balance equals reserve", () => {
			const balances = makeBalances({
				totalTaoValue: FREE_RESERVE_TAO + 2n * TAO,
				free: FREE_RESERVE_TAO,
				stakes: [makeStake({ netuid: 10, taoValue: 2n * TAO })],
			});

			const plan = computeRebalance(
				balances,
				targets({ netuid: 10, hotkey: hotkey("10") }),
				TEST_CONFIG,
			);

			const replenish = plan.operations.find(
				(op) =>
					op.kind === "unstake_partial" &&
					op.estimatedTaoValue <= FREE_RESERVE_TAO,
			);
			expect(replenish).toBeUndefined();
		});
	});
});

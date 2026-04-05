import { describe, expect, it } from "bun:test";
import type { Balances, StakeEntry } from "../balances/getBalances.ts";
import { computeRebalance } from "./computeRebalance.ts";
import { parseTao, TAO } from "./tao.ts";
import type { RebalanceConfig, StrategyTarget } from "./types.ts";

const TEST_CONFIG: RebalanceConfig = {
	minPositionTao: parseTao(0.5),
	freeReserveTao: parseTao(0.05),
	freeReserveTaoDriftPercent: 0.05,
	minOperationTao: parseTao(0.01),
	minStakeTao: parseTao(0.01),
	minRebalanceTao: parseTao(0.25),
	slippageBuffer: 0.02,
	enforceSlippage: false,
	allocationDriftPercent: 0.25,
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
			reason: "Position too small to exit (0.0099 τ)",
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

		// Reserve replenishment: unstake_partial to cover the free reserve
		const replenish = plan.operations.find(
			(op) => op.kind === "unstake_partial" && op.netuid === 70,
		);
		expect(replenish).toBeDefined();
		expect(replenish).toEqual(
			expect.objectContaining({ estimatedTaoValue: FREE_RESERVE_TAO }),
		);

		// Exit position should be split-swapped to targets (not unstaked then re-staked)
		const swaps = plan.operations.filter(
			(op) => op.kind === "swap" && op.originNetuid === 70,
		);
		expect(swaps.length).toBe(3);

		const totalSwapped = swaps.reduce(
			(sum, op) => sum + (op.kind === "swap" ? op.estimatedTaoValue : 0n),
			0n,
		);
		expect(totalSwapped).toBe(unstakeValue - FREE_RESERVE_TAO);
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

	it("splits exit position across multiple underweight targets proportionally", () => {
		// Reproduces the production bug: SN0 (1.758 τ) should split to SN10 + SN56
		const posValue = parseTao(1.758);
		const hk = hotkey("validator");
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + posValue,
			free: FREE_RESERVE_TAO,
			stakes: [
				makeStake({
					netuid: 0,
					hotkey: hk,
					taoValue: posValue,
					stake: posValue,
				}),
			],
		});

		const plan = computeRebalance(
			balances,
			targets({ netuid: 10, hotkey: hk }, { netuid: 56, hotkey: hk }),
			TEST_CONFIG,
		);

		// Should produce TWO swap operations, not one
		const swaps = plan.operations.filter(
			(op) => op.kind === "swap" && op.originNetuid === 0,
		);
		expect(swaps.length).toBe(2);

		const sn10Swap = swaps.find(
			(op) => op.kind === "swap" && op.destinationNetuid === 10,
		);
		const sn56Swap = swaps.find(
			(op) => op.kind === "swap" && op.destinationNetuid === 56,
		);
		expect(sn10Swap).toBeDefined();
		expect(sn56Swap).toBeDefined();

		// Both targets have equal deficit → roughly equal allocation
		if (sn10Swap?.kind === "swap" && sn56Swap?.kind === "swap") {
			const total = sn10Swap.estimatedTaoValue + sn56Swap.estimatedTaoValue;
			expect(total).toBe(posValue);
			// Each should be roughly half (allow rounding dust)
			const halfValue = posValue / 2n;
			expect(sn10Swap.estimatedTaoValue).toBeGreaterThanOrEqual(halfValue - 1n);
			expect(sn56Swap.estimatedTaoValue).toBeGreaterThanOrEqual(halfValue - 1n);
		}

		// SN56 should NOT be skipped
		expect(plan.skipped.find((s) => s.netuid === 56)).toBeUndefined();
	});

	it("splits exit with different hotkeys generates move ops when useLimits=true", () => {
		const posValue = parseTao(2.0);
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + posValue,
			free: FREE_RESERVE_TAO,
			stakes: [
				makeStake({
					netuid: 0,
					hotkey: hotkey("source"),
					taoValue: posValue,
					stake: posValue,
				}),
			],
		});

		const plan = computeRebalance(
			balances,
			targets(
				{ netuid: 10, hotkey: hotkey("valA") },
				{ netuid: 20, hotkey: hotkey("valB") },
			),
			TEST_CONFIG,
			{ useLimits: true },
		);

		// Should have move ops before each swap
		const moves = plan.operations.filter((op) => op.kind === "move");
		const swaps = plan.operations.filter(
			(op) => op.kind === "swap" && op.originNetuid === 0,
		);
		expect(moves.length).toBe(2);
		expect(swaps.length).toBe(2);
	});

	it("sends full position to single target when position fits within its deficit", () => {
		const posValue = parseTao(0.5);
		const hk = hotkey("validator");
		const balances = makeBalances({
			totalTaoValue: FREE_RESERVE_TAO + 3n * TAO,
			free: FREE_RESERVE_TAO,
			stakes: [
				makeStake({
					netuid: 99,
					hotkey: hk,
					taoValue: posValue,
					stake: posValue,
				}),
			],
		});

		const plan = computeRebalance(
			balances,
			targets({ netuid: 10, hotkey: hk }, { netuid: 20, hotkey: hk }),
			TEST_CONFIG,
		);

		// Position (0.5 τ) fits within one target's deficit (~1.475 τ) → single swap
		const swaps = plan.operations.filter(
			(op) => op.kind === "swap" && op.originNetuid === 99,
		);
		expect(swaps.length).toBe(1);
		// Should swap full position amount
		expect(swaps[0]).toEqual(
			expect.objectContaining({ alphaAmount: posValue }),
		);
	});

	it("splits large exit position across multiple targets instead of unstaking", () => {
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

		// SN99 (3.0 τ) should be split-swapped across underweight targets,
		// not unstaked — swapping directly is cheaper and avoids slippage.
		const swaps = plan.operations.filter(
			(op) => op.kind === "swap" && op.originNetuid === 99,
		);
		expect(swaps.length).toBeGreaterThanOrEqual(2);
		expect(
			plan.operations.find((op) => op.kind === "unstake" && op.netuid === 99),
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

	it("emits single swap with originHotkey when useLimits=false and hotkey differs", () => {
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
			{ useLimits: false },
		);

		// Should NOT have a move operation
		expect(plan.operations.find((op) => op.kind === "move")).toBeUndefined();

		// Should have a single swap with originHotkey set
		const swap = plan.operations.find(
			(op) => op.kind === "swap" && op.originNetuid === 77,
		);
		expect(swap).toBeDefined();
		expect(swap).toEqual(
			expect.objectContaining({
				kind: "swap",
				originNetuid: 77,
				destinationNetuid: 5,
				hotkey: hotkey("different"),
				originHotkey: hotkey("source"),
			}),
		);
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

	describe("allocation drift tolerance", () => {
		it("routes exit position to single target when within drift tolerance", () => {
			// 0.6 τ position going to 4 targets of ~0.5 τ each.
			// Overshoot: 0.6 / 0.5 - 1 = 20%, within 25% drift → single swap.
			const hk = hotkey("validator");
			const posValue = parseTao(0.6);
			const balances = makeBalances({
				totalTaoValue: FREE_RESERVE_TAO + 2n * TAO,
				free: FREE_RESERVE_TAO,
				stakes: [
					makeStake({
						netuid: 99,
						hotkey: hk,
						taoValue: posValue,
						stake: posValue,
					}),
				],
			});

			const plan = computeRebalance(
				balances,
				targets(
					{ netuid: 10, hotkey: hk },
					{ netuid: 20, hotkey: hk },
					{ netuid: 30, hotkey: hk },
					{ netuid: 40, hotkey: hk },
				),
				TEST_CONFIG,
			);

			const swaps = plan.operations.filter(
				(op) => op.kind === "swap" && op.originNetuid === 99,
			);
			expect(swaps.length).toBe(1);
			expect(swaps[0]).toEqual(
				expect.objectContaining({ alphaAmount: posValue }),
			);
		});

		it("still splits when overshoot exceeds drift tolerance", () => {
			// 1.758 τ position going to 2 targets of ~0.879 τ each.
			// Overshoot: 1.758 / 0.879 - 1 = 100%, far beyond 25% → must split.
			const hk = hotkey("validator");
			const posValue = parseTao(1.758);
			const balances = makeBalances({
				totalTaoValue: FREE_RESERVE_TAO + posValue,
				free: FREE_RESERVE_TAO,
				stakes: [
					makeStake({
						netuid: 0,
						hotkey: hk,
						taoValue: posValue,
						stake: posValue,
					}),
				],
			});

			const plan = computeRebalance(
				balances,
				targets({ netuid: 10, hotkey: hk }, { netuid: 56, hotkey: hk }),
				TEST_CONFIG,
			);

			const swaps = plan.operations.filter(
				(op) => op.kind === "swap" && op.originNetuid === 0,
			);
			expect(swaps.length).toBe(2);
		});

		it("skips overweight reduction within drift tolerance", () => {
			// SN10 has 1.1 τ vs target of 0.975 τ → excess 0.125 τ (12.8%).
			// Drift band: 0.975 × 0.25 = 0.244 τ → 0.125 < 0.244 → skip.
			const hk = hotkey("validator");
			const balances = makeBalances({
				totalTaoValue: parseTao(2.0),
				free: FREE_RESERVE_TAO,
				stakes: [
					makeStake({
						netuid: 10,
						hotkey: hk,
						taoValue: parseTao(1.1),
						stake: parseTao(1.1),
					}),
					makeStake({
						netuid: 20,
						hotkey: hk,
						taoValue: parseTao(0.85),
						stake: parseTao(0.85),
					}),
				],
			});

			const plan = computeRebalance(
				balances,
				targets({ netuid: 10, hotkey: hk }, { netuid: 20, hotkey: hk }),
				TEST_CONFIG,
			);

			// Should NOT generate any overweight reduction swap from SN10
			const overweightOps = plan.operations.filter(
				(op) =>
					(op.kind === "swap" && op.originNetuid === 10) ||
					(op.kind === "unstake_partial" && op.netuid === 10),
			);
			expect(overweightOps.length).toBe(0);
		});

		it("skips free-balance staking for deficit within drift tolerance", () => {
			// SN10 fulfilled at 0.9 τ vs target ~0.975 τ → deficit 0.075 τ (7.7%).
			// Drift band: 0.975 × 0.25 = 0.244 τ → 0.075 < 0.244 → skip.
			const hk = hotkey("validator");
			const balances = makeBalances({
				totalTaoValue: parseTao(2.0),
				free: FREE_RESERVE_TAO + parseTao(0.2),
				stakes: [
					makeStake({
						netuid: 10,
						hotkey: hk,
						taoValue: parseTao(0.9),
						stake: parseTao(0.9),
					}),
					makeStake({
						netuid: 20,
						hotkey: hk,
						taoValue: parseTao(0.85),
						stake: parseTao(0.85),
					}),
				],
			});

			const plan = computeRebalance(
				balances,
				targets({ netuid: 10, hotkey: hk }, { netuid: 20, hotkey: hk }),
				TEST_CONFIG,
			);

			// Should NOT stake into SN10 or SN20 since both are within drift
			const stakeOps = plan.operations.filter((op) => op.kind === "stake");
			expect(stakeOps.length).toBe(0);
		});

		it("prefers target with smallest overshoot when multiple within drift", () => {
			// Two equal-weight targets (0.5 each), SN10 partially filled (0.05 τ).
			// available = 1.0 τ → each target = 0.5 τ, maxAllowed = 0.625 τ.
			// Exit SN99 (0.55 τ): exceeds topTarget deficit (0.5) → findBestSingleTarget.
			// SN10: afterFulfilled = 0.05+0.55 = 0.60 ≤ 0.625 ✓ overshoot = 0.10
			// SN20: afterFulfilled = 0+0.55 = 0.55 ≤ 0.625 ✓ overshoot = 0.05
			// SN20 has smaller overshoot → should be chosen.
			const hk = hotkey("validator");
			const posValue = parseTao(0.55);
			const balances = makeBalances({
				totalTaoValue: FREE_RESERVE_TAO + TAO,
				free: FREE_RESERVE_TAO + parseTao(0.4),
				stakes: [
					makeStake({
						netuid: 99,
						hotkey: hk,
						taoValue: posValue,
						stake: posValue,
					}),
					makeStake({
						netuid: 10,
						hotkey: hk,
						taoValue: parseTao(0.05),
						stake: parseTao(0.05),
					}),
				],
			});

			const tgts: StrategyTarget[] = [
				{ netuid: 10, hotkey: hk, share: 0.5 },
				{ netuid: 20, hotkey: hk, share: 0.5 },
			];

			const plan = computeRebalance(balances, tgts, TEST_CONFIG);

			const swaps = plan.operations.filter(
				(op) => op.kind === "swap" && op.originNetuid === 99,
			);
			expect(swaps.length).toBe(1);
			// SN20 has smaller overshoot → should be chosen
			expect(swaps[0]).toEqual(
				expect.objectContaining({ destinationNetuid: 20 }),
			);
		});

		it("falls back to split when no single target is within drift tolerance", () => {
			// 3.0 τ position vs 3 targets of ~1.17 τ each.
			// 3.0 / 1.17 - 1 = 156% → way beyond 25% drift for any single target.
			const hk = hotkey("validator");
			const posValue = parseTao(3.0);
			const balances = makeBalances({
				totalTaoValue: FREE_RESERVE_TAO + posValue,
				free: FREE_RESERVE_TAO,
				stakes: [
					makeStake({
						netuid: 99,
						hotkey: hk,
						taoValue: posValue,
						stake: posValue,
					}),
				],
			});

			const plan = computeRebalance(
				balances,
				targets(
					{ netuid: 10, hotkey: hk },
					{ netuid: 20, hotkey: hk },
					{ netuid: 30, hotkey: hk },
				),
				TEST_CONFIG,
			);

			const swaps = plan.operations.filter(
				(op) => op.kind === "swap" && op.originNetuid === 99,
			);
			expect(swaps.length).toBeGreaterThanOrEqual(2);
		});

		it("with zero drift behaves like original (always splits)", () => {
			const noDriftConfig = { ...TEST_CONFIG, allocationDriftPercent: 0 };
			const hk = hotkey("validator");
			const posValue = parseTao(0.6);
			const balances = makeBalances({
				totalTaoValue: FREE_RESERVE_TAO + 2n * TAO,
				free: FREE_RESERVE_TAO,
				stakes: [
					makeStake({
						netuid: 99,
						hotkey: hk,
						taoValue: posValue,
						stake: posValue,
					}),
				],
			});

			const plan = computeRebalance(
				balances,
				targets(
					{ netuid: 10, hotkey: hk },
					{ netuid: 20, hotkey: hk },
					{ netuid: 30, hotkey: hk },
					{ netuid: 40, hotkey: hk },
				),
				noDriftConfig,
			);

			const swaps = plan.operations.filter(
				(op) => op.kind === "swap" && op.originNetuid === 99,
			);
			// With 0% drift, 0.6 τ > 0.5 τ target → must split
			expect(swaps.length).toBeGreaterThanOrEqual(2);
		});

		it("still reduces overweight when a destination target is beyond its drift band", () => {
			// Uses lower minRebalanceTao so drift logic is the deciding factor.
			// SN10 holds 1.2 τ (target ~1.0 τ, excess 0.2 τ within its drift band 0.25 τ).
			// SN20 holds 0.2 τ (target ~0.4 τ, deficit 0.2 τ > drift band 0.1 τ).
			// Free balance = reserve only → no free to fund SN20.
			// Without the stranding fix, drift would skip the SN10 trim and SN20 stays underweight.
			// With the fix, SN10 is reduced and swapped to SN20.
			const lowerMinConfig = {
				...TEST_CONFIG,
				minRebalanceTao: parseTao(0.1),
			};
			const hk = hotkey("validator");
			const balances = makeBalances({
				totalTaoValue: FREE_RESERVE_TAO + parseTao(1.4),
				free: FREE_RESERVE_TAO,
				stakes: [
					makeStake({
						netuid: 10,
						hotkey: hk,
						taoValue: parseTao(1.2),
						stake: parseTao(1.2),
					}),
					makeStake({
						netuid: 20,
						hotkey: hk,
						taoValue: parseTao(0.2),
						stake: parseTao(0.2),
					}),
				],
			});

			// 5/7 and 2/7 shares → target SN10 = 1.0 τ, target SN20 = 0.4 τ
			const tgts: StrategyTarget[] = [
				{ netuid: 10, hotkey: hk, share: 5 / 7 },
				{ netuid: 20, hotkey: hk, share: 2 / 7 },
			];

			const plan = computeRebalance(balances, tgts, lowerMinConfig);

			// Should produce a swap from SN10 → SN20
			const swapOps = plan.operations.filter(
				(op) => op.kind === "swap" && op.originNetuid === 10,
			);
			expect(swapOps.length).toBe(1);
			expect(swapOps[0]).toEqual(
				expect.objectContaining({ destinationNetuid: 20 }),
			);
		});

		it("skips overweight reduction within drift when all targets are within drift", () => {
			// Both targets within drift band → no operations needed.
			// SN10: 1.1 τ vs target 1.0 τ → excess 0.1 τ, drift band 0.25 τ → within
			// SN20: 0.35 τ vs target 0.4 τ → deficit 0.05 τ, drift band 0.1 τ → within
			const hk = hotkey("validator");
			const balances = makeBalances({
				totalTaoValue: FREE_RESERVE_TAO + parseTao(1.45),
				free: FREE_RESERVE_TAO,
				stakes: [
					makeStake({
						netuid: 10,
						hotkey: hk,
						taoValue: parseTao(1.1),
						stake: parseTao(1.1),
					}),
					makeStake({
						netuid: 20,
						hotkey: hk,
						taoValue: parseTao(0.35),
						stake: parseTao(0.35),
					}),
				],
			});

			const tgts: StrategyTarget[] = [
				{ netuid: 10, hotkey: hk, share: 5 / 7 },
				{ netuid: 20, hotkey: hk, share: 2 / 7 },
			];

			const plan = computeRebalance(balances, tgts, TEST_CONFIG);

			const rebalanceOps = plan.operations.filter(
				(op) => op.kind === "swap" || op.kind === "unstake_partial",
			);
			expect(rebalanceOps.length).toBe(0);
		});

		it("routes exit to single target at exact drift boundary", () => {
			// Position exactly at drift limit: 0.625 τ = 0.5 × 1.25.
			// afterFulfilled (0.625) <= maxAllowed (0.625) → should route to single target.
			const hk = hotkey("validator");
			const posValue = parseTao(0.625);
			const balances = makeBalances({
				totalTaoValue: FREE_RESERVE_TAO + 2n * TAO,
				free: FREE_RESERVE_TAO,
				stakes: [
					makeStake({
						netuid: 99,
						hotkey: hk,
						taoValue: posValue,
						stake: posValue,
					}),
				],
			});

			const plan = computeRebalance(
				balances,
				targets(
					{ netuid: 10, hotkey: hk },
					{ netuid: 20, hotkey: hk },
					{ netuid: 30, hotkey: hk },
					{ netuid: 40, hotkey: hk },
				),
				TEST_CONFIG,
			);

			const swaps = plan.operations.filter(
				(op) => op.kind === "swap" && op.originNetuid === 99,
			);
			// Exactly at boundary (<=) → single swap
			expect(swaps.length).toBe(1);
		});

		it("stops overweight reduction once all destinations are within drift", () => {
			// 3 equal targets. SN10 and SN20 both overweight within drift.
			// SN30 is underweight beyond drift. After one swap fills SN30,
			// the second overweight source should be skipped (all now within drift).
			const lowerMinConfig = {
				...TEST_CONFIG,
				minRebalanceTao: parseTao(0.1),
			};
			const hk = hotkey("validator");
			const balances = makeBalances({
				totalTaoValue: FREE_RESERVE_TAO + parseTao(2.9),
				free: FREE_RESERVE_TAO,
				stakes: [
					makeStake({
						netuid: 10,
						hotkey: hk,
						taoValue: parseTao(1.2),
						stake: parseTao(1.2),
					}),
					makeStake({
						netuid: 20,
						hotkey: hk,
						taoValue: parseTao(1.2),
						stake: parseTao(1.2),
					}),
					makeStake({
						netuid: 30,
						hotkey: hk,
						taoValue: parseTao(0.5),
						stake: parseTao(0.5),
					}),
				],
			});

			// Equal shares → each target ≈ 0.9667 τ, drift band ≈ 0.2417 τ
			const tgts: StrategyTarget[] = [
				{ netuid: 10, hotkey: hk, share: 1 / 3 },
				{ netuid: 20, hotkey: hk, share: 1 / 3 },
				{ netuid: 30, hotkey: hk, share: 1 / 3 },
			];

			const plan = computeRebalance(balances, tgts, lowerMinConfig);

			// Only one swap should fire (first overweight fills SN30),
			// second overweight should be skipped since all targets are now within drift.
			const swapOps = plan.operations.filter((op) => op.kind === "swap");
			expect(swapOps.length).toBe(1);
			expect(swapOps[0]).toEqual(
				expect.objectContaining({ destinationNetuid: 30 }),
			);
		});
	});
});

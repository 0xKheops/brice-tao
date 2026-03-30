import { describe, expect, it, vi } from "bun:test";
import { TAO } from "./constants.ts";
import { simulateAllOperations } from "./simulateSlippage.ts";
import type { RebalanceOperation } from "./types.ts";

const TEST_SLIPPAGE = {
	slippageBuffer: 0.003,
	swapSlippageBuffer: 0.02,
} as const;

function makeApi() {
	return {
		apis: {
			SwapRuntimeApi: {
				sim_swap_tao_for_alpha: vi.fn(),
				sim_swap_alpha_for_tao: vi.fn(),
			},
		},
	};
}

describe("simulateAllOperations", () => {
	it("applies slippage buffers to stake, unstake, unstake_partial and swap", async () => {
		const api = makeApi();
		// stake calls sim_swap_tao_for_alpha (1st), swap's stake leg calls it (2nd)
		api.apis.SwapRuntimeApi.sim_swap_tao_for_alpha
			.mockResolvedValueOnce({ tao_amount: 2n * TAO, alpha_amount: TAO })
			.mockResolvedValueOnce({
				tao_amount: 2n * TAO,
				alpha_amount: 2n * TAO,
			});
		// unstake (1st), unstake_partial (2nd), swap's unstake leg (3rd)
		api.apis.SwapRuntimeApi.sim_swap_alpha_for_tao
			.mockResolvedValueOnce({ tao_amount: 3n * TAO, alpha_amount: TAO })
			.mockResolvedValueOnce({ tao_amount: 5n * TAO, alpha_amount: 2n * TAO })
			.mockResolvedValueOnce({ tao_amount: 2n * TAO, alpha_amount: TAO });

		const operations: RebalanceOperation[] = [
			{
				kind: "stake",
				netuid: 1,
				hotkey: "hk",
				taoAmount: TAO,
				limitPrice: 0n,
			},
			{
				kind: "unstake",
				netuid: 2,
				hotkey: "hk",
				alphaAmount: TAO,
				estimatedTaoValue: TAO,
				limitPrice: 0n,
			},
			{
				kind: "unstake_partial",
				netuid: 3,
				hotkey: "hk",
				alphaAmount: 2n * TAO,
				estimatedTaoValue: TAO,
				limitPrice: 0n,
			},
			{
				kind: "swap",
				originNetuid: 4,
				destinationNetuid: 5,
				hotkey: "hk",
				alphaAmount: TAO,
				estimatedTaoValue: TAO,
				limitPrice: 0n,
			},
		];

		const simulated = await simulateAllOperations(
			api as never,
			operations,
			TEST_SLIPPAGE,
		);

		expect(simulated).toEqual([
			{
				kind: "stake",
				netuid: 1,
				hotkey: "hk",
				taoAmount: TAO,
				limitPrice: 2006000000n,
			},
			{
				kind: "unstake",
				netuid: 2,
				hotkey: "hk",
				alphaAmount: TAO,
				estimatedTaoValue: TAO,
				limitPrice: 2991000000n,
			},
			{
				kind: "unstake_partial",
				netuid: 3,
				hotkey: "hk",
				alphaAmount: 2n * TAO,
				estimatedTaoValue: TAO,
				limitPrice: 2492500000n,
			},
			{
				kind: "swap",
				originNetuid: 4,
				destinationNetuid: 5,
				hotkey: "hk",
				alphaAmount: TAO,
				estimatedTaoValue: TAO,
				limitPrice: 1960000000n,
			},
		]);
	});

	it("keeps original stake/unstake/swap operation when simulation returns zero output", async () => {
		const api = makeApi();
		api.apis.SwapRuntimeApi.sim_swap_tao_for_alpha.mockResolvedValue({
			tao_amount: TAO,
			alpha_amount: 0n,
		});
		api.apis.SwapRuntimeApi.sim_swap_alpha_for_tao.mockResolvedValue({
			tao_amount: 0n,
			alpha_amount: TAO,
		});

		const operations: RebalanceOperation[] = [
			{
				kind: "stake",
				netuid: 10,
				hotkey: "hk",
				taoAmount: TAO,
				limitPrice: 11n,
			},
			{
				kind: "unstake",
				netuid: 11,
				hotkey: "hk",
				alphaAmount: TAO,
				estimatedTaoValue: TAO,
				limitPrice: 22n,
			},
			{
				kind: "unstake_partial",
				netuid: 12,
				hotkey: "hk",
				alphaAmount: TAO,
				estimatedTaoValue: TAO,
				limitPrice: 33n,
			},
			{
				kind: "swap",
				originNetuid: 13,
				destinationNetuid: 14,
				hotkey: "hk",
				alphaAmount: TAO,
				estimatedTaoValue: TAO,
				limitPrice: 44n,
			},
		];

		const simulated = await simulateAllOperations(
			api as never,
			operations,
			TEST_SLIPPAGE,
		);
		expect(simulated).toEqual(operations);
	});
});

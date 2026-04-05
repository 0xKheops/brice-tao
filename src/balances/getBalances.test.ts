import { afterEach, describe, expect, it, vi } from "bun:test";
import { TAO } from "../rebalance/tao.ts";
import { getBalances } from "./getBalances.ts";

function mockApi(opts: {
	free?: bigint;
	reserved?: bigint;
	stakeInfos?: Array<{ hotkey: string; netuid: number; stake: bigint }>;
	prices?: Map<number, bigint>;
}) {
	const {
		free = 0n,
		reserved = 0n,
		stakeInfos = [],
		prices = new Map(),
	} = opts;
	return {
		query: {
			System: {
				Account: {
					getValue: vi.fn().mockResolvedValue({
						data: { free, reserved },
					}),
				},
			},
		},
		apis: {
			StakeInfoRuntimeApi: {
				get_stake_info_for_coldkey: vi.fn().mockResolvedValue(stakeInfos),
			},
			SwapRuntimeApi: {
				current_alpha_price_all: vi.fn().mockResolvedValue(
					[...prices.entries()].map(([netuid, price]) => ({
						netuid,
						price,
					})),
				),
			},
		},
	} as unknown as Parameters<typeof getBalances>[0];
}

const ADDR = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("getBalances", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fetches balance with one stake entry", async () => {
		const stake = 100n * TAO;
		const alphaPrice = 2n * TAO;
		const api = mockApi({
			free: 10n * TAO,
			reserved: 1n * TAO,
			stakeInfos: [{ hotkey: "0xabc", netuid: 1, stake }],
			prices: new Map([[1, alphaPrice]]),
		});

		const result = await getBalances(api, ADDR);

		expect(result.free).toBe(10n * TAO);
		expect(result.reserved).toBe(1n * TAO);
		expect(result.stakes).toHaveLength(1);
		expect(result.stakes[0]?.hotkey).toBe("0xabc");
		expect(result.stakes[0]?.netuid).toBe(1);
		expect(result.stakes[0]?.stake).toBe(stake);
		expect(result.stakes[0]?.alphaPrice).toBe(alphaPrice);
		expect(result.stakes[0]?.taoValue).toBe((stake * alphaPrice) / TAO);
		expect(result.totalTaoValue).toBe(
			10n * TAO + 1n * TAO + (stake * alphaPrice) / TAO,
		);
	});

	it("fetches correct alpha price per subnet for multiple stakes", async () => {
		const prices = new Map([
			[1, 2n * TAO],
			[5, 3n * TAO],
		]);
		const api = mockApi({
			free: 0n,
			reserved: 0n,
			stakeInfos: [
				{ hotkey: "0xa", netuid: 1, stake: 10n * TAO },
				{ hotkey: "0xb", netuid: 5, stake: 20n * TAO },
			],
			prices,
		});

		const result = await getBalances(api, ADDR);

		expect(result.stakes).toHaveLength(2);
		expect(result.stakes[0]?.alphaPrice).toBe(2n * TAO);
		expect(result.stakes[0]?.taoValue).toBe(20n * TAO);
		expect(result.stakes[1]?.alphaPrice).toBe(3n * TAO);
		expect(result.stakes[1]?.taoValue).toBe(60n * TAO);
		expect(result.totalTaoValue).toBe(80n * TAO);
	});

	it("uses a single bulk price call for stakes on the same subnet", async () => {
		const api = mockApi({
			stakeInfos: [
				{ hotkey: "0xa", netuid: 3, stake: 5n * TAO },
				{ hotkey: "0xb", netuid: 3, stake: 7n * TAO },
			],
			prices: new Map([[3, TAO]]),
		});

		await getBalances(api, ADDR);

		expect(
			api.apis.SwapRuntimeApi.current_alpha_price_all,
		).toHaveBeenCalledTimes(1);
	});

	it("returns empty stakes and free+reserved total when no stakes exist", async () => {
		const api = mockApi({
			free: 50n * TAO,
			reserved: 5n * TAO,
		});

		const result = await getBalances(api, ADDR);

		expect(result.stakes).toHaveLength(0);
		expect(result.totalTaoValue).toBe(55n * TAO);
		expect(
			api.apis.SwapRuntimeApi.current_alpha_price_all,
		).toHaveBeenCalledTimes(1);
	});

	it("computes taoValue as 0 when alpha price is zero", async () => {
		const api = mockApi({
			free: TAO,
			stakeInfos: [{ hotkey: "0xa", netuid: 99, stake: 100n * TAO }],
			prices: new Map([[99, 0n]]),
		});

		const result = await getBalances(api, ADDR);

		expect(result.stakes[0]?.taoValue).toBe(0n);
		expect(result.totalTaoValue).toBe(TAO);
	});

	it("handles large bigint values without overflow", async () => {
		const largeStake = 500n * TAO;
		const highPrice = 1_000n * TAO;
		const api = mockApi({
			free: 10_000n * TAO,
			reserved: 500n * TAO,
			stakeInfos: [{ hotkey: "0xa", netuid: 1, stake: largeStake }],
			prices: new Map([[1, highPrice]]),
		});

		const result = await getBalances(api, ADDR);

		const expectedTaoValue = (largeStake * highPrice) / TAO;
		expect(expectedTaoValue).toBe(500_000n * TAO);
		expect(result.stakes[0]?.taoValue).toBe(expectedTaoValue);
		expect(result.totalTaoValue).toBe(
			10_000n * TAO + 500n * TAO + expectedTaoValue,
		);
	});
});

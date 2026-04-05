import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Api } from "../../api/createClient.ts";
import type { Balances } from "../../balances/getBalances.ts";
import { TAO } from "../../rebalance/tao.ts";

const mockGetBalances = mock(() => Promise.resolve({} as Balances));
mock.module("../../balances/getBalances.ts", () => ({
	getBalances: mockGetBalances,
}));
mock.module("../../rebalance/logger.ts", () => ({
	log: { info: () => {}, warn: () => {}, error: () => {}, verbose: () => {} },
}));

const { getLeaderShares } = await import("./getLeaderShares.ts");

function makeBalances(
	stakes: Array<{ netuid: number; hotkey: string; taoValue: bigint }>,
): Balances {
	return {
		free: 10n * TAO,
		reserved: 0n,
		stakes: stakes.map((s) => ({
			...s,
			stake: s.taoValue,
			alphaPrice: TAO,
		})),
		totalTaoValue: stakes.reduce((sum, s) => sum + s.taoValue, 0n) + 10n * TAO,
	};
}

const api = null as unknown as Api;

describe("getLeaderShares", () => {
	beforeEach(() => {
		mockGetBalances.mockReset();
	});

	it("computes basic proportional shares", async () => {
		mockGetBalances.mockResolvedValueOnce(
			makeBalances([
				{ netuid: 46, hotkey: "hk1", taoValue: 40n * TAO },
				{ netuid: 45, hotkey: "hk2", taoValue: 40n * TAO },
				{ netuid: 0, hotkey: "hk3", taoValue: 20n * TAO },
			]),
		);

		const result = await getLeaderShares(api, "leader", 100n * TAO, 0n);

		expect(result.shares).toHaveLength(3);
		expect(result.shares[0]).toEqual({ netuid: 0, share: 0.2 });
		expect(result.shares[1]).toEqual({ netuid: 45, share: 0.4 });
		expect(result.shares[2]).toEqual({ netuid: 46, share: 0.4 });
		expect(result.filtered).toHaveLength(0);
	});

	it("aggregates multiple validators on the same subnet", async () => {
		mockGetBalances.mockResolvedValueOnce(
			makeBalances([
				{ netuid: 45, hotkey: "hkA", taoValue: 20n * TAO },
				{ netuid: 45, hotkey: "hkB", taoValue: 20n * TAO },
				{ netuid: 46, hotkey: "hkC", taoValue: 60n * TAO },
			]),
		);

		const result = await getLeaderShares(api, "leader", 100n * TAO, 0n);

		expect(result.shares).toHaveLength(2);
		expect(result.shares[0]).toEqual({ netuid: 45, share: 0.4 });
		expect(result.shares[1]).toEqual({ netuid: 46, share: 0.6 });
	});

	it("falls back to 100% SN0 when leader has no staked positions", async () => {
		mockGetBalances.mockResolvedValueOnce(makeBalances([]));

		const result = await getLeaderShares(api, "leader", 100n * TAO, 0n);

		expect(result.shares).toEqual([{ netuid: 0, share: 1.0 }]);
		expect(result.filtered).toHaveLength(0);
	});

	it("filters dust positions below minPositionTao", async () => {
		// Leader: 95% SN45, 5% SN10
		mockGetBalances.mockResolvedValueOnce(
			makeBalances([
				{ netuid: 45, hotkey: "hk1", taoValue: 95n * TAO },
				{ netuid: 10, hotkey: "hk2", taoValue: 5n * TAO },
			]),
		);

		// Follower has 5 TAO, minPosition = 0.5 TAO
		// SN10 share = 5% → 0.25 TAO < 0.5 TAO → filtered
		const minPos = TAO / 2n; // 0.5 TAO
		const result = await getLeaderShares(api, "leader", 5n * TAO, minPos);

		expect(result.shares).toHaveLength(1);
		expect(result.shares[0]?.netuid).toBe(45);
		expect(result.shares[0]?.share).toBeCloseTo(1.0, 6);
		expect(result.filtered).toHaveLength(1);
		expect(result.filtered[0]?.netuid).toBe(10);
	});

	it("returns empty shares when all positions are filtered", async () => {
		// Many tiny positions, follower too small for any
		mockGetBalances.mockResolvedValueOnce(
			makeBalances([
				{ netuid: 10, hotkey: "hk1", taoValue: 1n * TAO },
				{ netuid: 11, hotkey: "hk2", taoValue: 1n * TAO },
				{ netuid: 12, hotkey: "hk3", taoValue: 1n * TAO },
			]),
		);

		// Follower has 1 TAO, each subnet gets ~0.33 TAO, minPosition = 0.5 TAO
		const minPos = TAO / 2n;
		const result = await getLeaderShares(api, "leader", 1n * TAO, minPos);

		expect(result.shares).toHaveLength(0);
		expect(result.filtered).toHaveLength(3);
	});

	it("re-normalizes filtered shares to sum to ~1.0", async () => {
		// 50% SN45, 30% SN46, 20% SN10 (will be filtered)
		mockGetBalances.mockResolvedValueOnce(
			makeBalances([
				{ netuid: 45, hotkey: "hk1", taoValue: 50n * TAO },
				{ netuid: 46, hotkey: "hk2", taoValue: 30n * TAO },
				{ netuid: 10, hotkey: "hk3", taoValue: 20n * TAO },
			]),
		);

		// Follower has 2 TAO, minPosition = 0.5 TAO
		// SN10 share = 20% → 0.4 TAO < 0.5 TAO → filtered
		const minPos = TAO / 2n;
		const result = await getLeaderShares(api, "leader", 2n * TAO, minPos);

		const sum = result.shares.reduce((s, e) => s + e.share, 0);
		expect(sum).toBeCloseTo(1.0, 6);
		expect(result.shares).toHaveLength(2);
		// After renorm: SN45 = 50/80 = 0.625, SN46 = 30/80 = 0.375
		expect(result.shares[0]?.netuid).toBe(45);
		expect(result.shares[0]?.share).toBeCloseTo(0.625, 6);
		expect(result.shares[1]?.netuid).toBe(46);
		expect(result.shares[1]?.share).toBeCloseTo(0.375, 6);
	});
});

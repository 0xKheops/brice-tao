import { describe, expect, it, vi } from "bun:test";
import type { Sn45Api } from "./api/generated/Sn45Api.ts";
import {
	getMostProfitableSubnets,
	type MomentumConfig,
} from "./getMostProfitableSubnets.ts";

interface LeaderboardEntryFixture {
	netuid: number;
	priceChange?: number | null;
	mcap?: string | null;
	emaTaoFlow?: string | null;
	volume?: string;
	totalHolders?: number;
	buyCount?: number;
	sellCount?: number;
	emissionPct?: number | null;
}

function makeEntry(partial: LeaderboardEntryFixture): LeaderboardEntryFixture {
	return {
		netuid: partial.netuid,
		priceChange: partial.priceChange === undefined ? 10 : partial.priceChange,
		mcap: partial.mcap === undefined ? "3000000000000" : partial.mcap,
		emaTaoFlow:
			partial.emaTaoFlow === undefined ? "500000000000" : partial.emaTaoFlow,
		volume: partial.volume === undefined ? "1500000000000" : partial.volume,
		totalHolders:
			partial.totalHolders === undefined ? 600 : partial.totalHolders,
		buyCount: partial.buyCount === undefined ? 100 : partial.buyCount,
		sellCount: partial.sellCount === undefined ? 100 : partial.sellCount,
		emissionPct: partial.emissionPct === undefined ? 0.9 : partial.emissionPct,
	};
}

function makeSn45(entries: LeaderboardEntryFixture[]): {
	sn45: Sn45Api<unknown>;
	getSubnetLeaderboard: ReturnType<typeof vi.fn>;
} {
	const getSubnetLeaderboard = vi.fn().mockResolvedValue({
		data: { subnets: entries },
	});
	const sn45 = {
		v1: {
			getSubnetLeaderboard,
		},
	} as unknown as Sn45Api<unknown>;

	return { sn45, getSubnetLeaderboard };
}

describe("getMostProfitableSubnets filtering and ranking", () => {
	it("keeps only entries that pass all quality gates and respects active subnet filtering", async () => {
		const entries = [
			makeEntry({ netuid: 0 }),
			makeEntry({ netuid: 1, priceChange: null }),
			makeEntry({ netuid: 2, mcap: null }),
			makeEntry({ netuid: 3, emaTaoFlow: null }),
			makeEntry({ netuid: 4, volume: "99999999999" }),
			makeEntry({ netuid: 5, mcap: "999999999999" }),
			makeEntry({ netuid: 6, totalHolders: 499 }),
			makeEntry({ netuid: 7, buyCount: 10, sellCount: 21 }),
			makeEntry({ netuid: 8, emissionPct: 0.49 }),
			makeEntry({ netuid: 9, buyCount: 0, sellCount: 9999 }),
			makeEntry({ netuid: 10 }),
		];
		const { sn45, getSubnetLeaderboard } = makeSn45(entries);

		const result = await getMostProfitableSubnets(
			sn45,
			undefined,
			new Set([9]),
		);

		expect(getSubnetLeaderboard).toHaveBeenCalledWith({ period: "1d" });
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ netuid: 9, volume: 1500, mcap: 3000 });
	});

	it("returns empty list when no subnet survives required data and quality gates", async () => {
		const entries = [
			makeEntry({ netuid: 1, priceChange: null }),
			makeEntry({ netuid: 2, mcap: null }),
			makeEntry({ netuid: 3, emaTaoFlow: null }),
			makeEntry({ netuid: 4, volume: "1" }),
		];
		const { sn45 } = makeSn45(entries);

		const result = await getMostProfitableSubnets(sn45);

		expect(result).toEqual([]);
	});

	it("drops the bottom percentile by volume to market-cap ratio before ranking", async () => {
		const entries = [
			makeEntry({
				netuid: 1,
				volume: "100000000000",
				mcap: "1000000000000",
				priceChange: 100,
				emaTaoFlow: "1000000000000",
			}),
			makeEntry({
				netuid: 2,
				volume: "500000000000",
				mcap: "1000000000000",
				priceChange: 10,
				emaTaoFlow: "500000000000",
			}),
			makeEntry({
				netuid: 3,
				volume: "900000000000",
				mcap: "1000000000000",
				priceChange: 20,
				emaTaoFlow: "600000000000",
			}),
			makeEntry({
				netuid: 4,
				volume: "1200000000000",
				mcap: "1000000000000",
				priceChange: 30,
				emaTaoFlow: "700000000000",
			}),
		];
		const config: MomentumConfig = {
			bottomPercentileCutoff: 25,
		};
		const { sn45 } = makeSn45(entries);

		const result = await getMostProfitableSubnets(sn45, config);

		expect(result.map((s) => s.netuid)).not.toContain(1);
		expect(result.map((s) => s.netuid).sort((a, b) => a - b)).toEqual([
			2, 3, 4,
		]);
	});

	it("ranks by weighted z-score and honors custom weights that emphasize a single signal", async () => {
		const entries = [
			makeEntry({
				netuid: 11,
				priceChange: 5,
				emaTaoFlow: "900000000000",
				volume: "1100000000000",
				mcap: "1000000000000",
			}),
			makeEntry({
				netuid: 12,
				priceChange: 80,
				emaTaoFlow: "100000000000",
				volume: "100000000000",
				mcap: "1000000000000",
			}),
			makeEntry({
				netuid: 13,
				priceChange: 30,
				emaTaoFlow: "500000000000",
				volume: "500000000000",
				mcap: "1000000000000",
			}),
		];
		const { sn45 } = makeSn45(entries);

		const result = await getMostProfitableSubnets(sn45, {
			weights: {
				priceChange: 1,
				emaTaoFlow: 0,
				volumeMcapRatio: 0,
			},
			bottomPercentileCutoff: 0,
		});

		expect(result.map((s) => s.netuid)).toEqual([12, 13, 11]);
		expect(result[0]?.momentumScore).toBeGreaterThan(
			result[1]?.momentumScore ?? 0,
		);
		expect(result[1]?.momentumScore).toBeGreaterThan(
			result[2]?.momentumScore ?? 0,
		);
	});

	it("returns zero momentum scores when every surviving subnet has identical signals", async () => {
		const entries = [
			makeEntry({
				netuid: 21,
				priceChange: 12,
				emaTaoFlow: "300",
				volume: "900",
				mcap: "3000",
			}),
			makeEntry({
				netuid: 22,
				priceChange: 12,
				emaTaoFlow: "300",
				volume: "900",
				mcap: "3000",
			}),
			makeEntry({
				netuid: 23,
				priceChange: 12,
				emaTaoFlow: "300",
				volume: "900",
				mcap: "3000",
			}),
		];
		const config: MomentumConfig = {
			minVolumeTao: 0,
			minMcapTao: 0,
			minHolders: 0,
			minEmissionPct: 0,
			bottomPercentileCutoff: 0,
		};
		const { sn45 } = makeSn45(entries);

		const result = await getMostProfitableSubnets(sn45, config);

		expect(result).toHaveLength(3);
		expect(result.every((s) => s.momentumScore === 0)).toBe(true);
	});
});

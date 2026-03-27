import { describe, expect, it, vi } from "bun:test";
import type { Sn45Api } from "../api/generated/Sn45Api.ts";
import { getBestSubnets, type StrategyConfig } from "./getBestSubnets.ts";

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
	score?: number;
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
		score: partial.score === undefined ? 80 : partial.score,
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

describe("getBestSubnets filtering and ranking", () => {
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
			makeEntry({ netuid: 8, emissionPct: null }),
			makeEntry({ netuid: 9, buyCount: 0, sellCount: 9999 }),
			makeEntry({ netuid: 10, score: 90 }),
		];
		const { sn45, getSubnetLeaderboard } = makeSn45(entries);

		const result = await getBestSubnets(sn45, undefined, new Set([10]));

		expect(getSubnetLeaderboard).toHaveBeenCalledWith({ period: "1d" });
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ netuid: 10, score: 90 });
	});

	it("returns empty list when no subnet survives required data and quality gates", async () => {
		const entries = [
			makeEntry({ netuid: 1, priceChange: null }),
			makeEntry({ netuid: 2, mcap: null }),
			makeEntry({ netuid: 3, emaTaoFlow: null }),
			makeEntry({ netuid: 4, volume: "1" }),
		];
		const { sn45 } = makeSn45(entries);

		const result = await getBestSubnets(sn45);

		expect(result).toEqual([]);
	});

	it("drops the bottom percentile by volume to market-cap ratio before ranking", async () => {
		const entries = [
			makeEntry({
				netuid: 1,
				volume: "100000000000",
				mcap: "1000000000000",
				score: 95,
			}),
			makeEntry({
				netuid: 2,
				volume: "500000000000",
				mcap: "1000000000000",
				score: 85,
			}),
			makeEntry({
				netuid: 3,
				volume: "900000000000",
				mcap: "1000000000000",
				score: 90,
			}),
			makeEntry({
				netuid: 4,
				volume: "1200000000000",
				mcap: "1000000000000",
				score: 80,
			}),
		];
		const config: StrategyConfig = {
			bottomPercentileCutoff: 25,
		};
		const { sn45 } = makeSn45(entries);

		const result = await getBestSubnets(sn45, config);

		expect(result.map((s) => s.netuid)).not.toContain(1);
		expect(result.map((s) => s.netuid).sort((a, b) => a - b)).toEqual([
			2, 3, 4,
		]);
	});

	it("sorts subnets by SN45 leaderboard score descending", async () => {
		const entries = [
			makeEntry({ netuid: 11, score: 72 }),
			makeEntry({ netuid: 12, score: 95 }),
			makeEntry({ netuid: 13, score: 88 }),
		];
		const { sn45 } = makeSn45(entries);

		const result = await getBestSubnets(sn45, {
			bottomPercentileCutoff: 0,
		});

		expect(result.map((s) => s.netuid)).toEqual([12, 13, 11]);
		expect(result[0]?.score).toBeGreaterThan(result[1]?.score ?? 0);
		expect(result[1]?.score).toBeGreaterThan(result[2]?.score ?? 0);
	});

	it("excludes subnets below minScore threshold", async () => {
		const entries = [
			makeEntry({ netuid: 21, score: 80 }),
			makeEntry({ netuid: 22, score: 60 }),
			makeEntry({ netuid: 23, score: 90 }),
		];
		const config: StrategyConfig = {
			minScore: 70,
			minVolumeTao: 0,
			minMcapTao: 0,
			minHolders: 0,
			bottomPercentileCutoff: 0,
		};
		const { sn45 } = makeSn45(entries);

		const result = await getBestSubnets(sn45, config);

		expect(result).toHaveLength(2);
		expect(result.map((s) => s.netuid)).toEqual([23, 21]);
		expect(result.find((s) => s.netuid === 22)).toBeUndefined();
	});

	it("logs exclusion reasons for each quality gate", async () => {
		const entries = [
			makeEntry({ netuid: 1, score: 50 }),
			makeEntry({ netuid: 2, volume: "1" }),
			makeEntry({ netuid: 4, totalHolders: 1 }),
			makeEntry({ netuid: 6, emissionPct: null }),
		];
		const logger = { verbose: vi.fn() };
		const { sn45 } = makeSn45(entries);

		await getBestSubnets(sn45, undefined, undefined, logger);

		const calls = logger.verbose.mock.calls.map(
			(c: unknown[]) => c[0] as string,
		);
		expect(calls.some((m) => m.includes("SN1") && m.includes("score"))).toBe(
			true,
		);
		expect(calls.some((m) => m.includes("SN2") && m.includes("volume"))).toBe(
			true,
		);
		expect(calls.some((m) => m.includes("SN4") && m.includes("holders"))).toBe(
			true,
		);
		expect(calls.some((m) => m.includes("SN6") && m.includes("emission"))).toBe(
			true,
		);
	});

	it("includes subnet names in output when subnetNames map is provided", async () => {
		const entries = [makeEntry({ netuid: 7, score: 85 })];
		const { sn45 } = makeSn45(entries);
		const names = new Map([[7, "Apex"]]);

		const result = await getBestSubnets(
			sn45,
			{ bottomPercentileCutoff: 0 },
			undefined,
			undefined,
			names,
		);

		expect(result[0]).toMatchObject({ netuid: 7, name: "Apex", score: 85 });
	});

	it("immune subnets bypass all quality gates except score", async () => {
		const entries = [
			makeEntry({
				netuid: 50,
				volume: "1",
				mcap: "1",
				totalHolders: 0,
				emissionPct: null,
				score: 85,
			}),
			makeEntry({
				netuid: 51,
				volume: "1",
				mcap: "1",
				totalHolders: 0,
				emissionPct: null,
				score: 85,
			}),
			makeEntry({
				netuid: 52,
				volume: "1",
				mcap: "1",
				totalHolders: 0,
				emissionPct: null,
				score: 40,
			}),
		];
		const { sn45 } = makeSn45(entries);
		const immuneNetuids = new Set([50, 52]);

		const result = await getBestSubnets(
			sn45,
			{ bottomPercentileCutoff: 0 },
			undefined,
			undefined,
			undefined,
			undefined,
			immuneNetuids,
		);

		// SN50 passes (immune, score above default minScore)
		expect(result.map((s) => s.netuid)).toContain(50);
		// SN51 fails (not immune, all gates fail)
		expect(result.map((s) => s.netuid)).not.toContain(51);
		// SN52 fails (immune but score too low)
		expect(result.map((s) => s.netuid)).not.toContain(52);
	});
});

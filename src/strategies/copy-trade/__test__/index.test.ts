import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { PolkadotClient } from "polkadot-api";
import type { Balances } from "../../../balances/getBalances.ts";
import { ConfigError } from "../../../errors.ts";
import { TAO } from "../../../rebalance/tao.ts";

// ---------------------------------------------------------------------------
// Mocks (must be set up before importing the module under test)
// ---------------------------------------------------------------------------

mock.module("../../../rebalance/logger.ts", () => ({
	log: { info: () => {}, warn: () => {}, error: () => {}, verbose: () => {} },
}));

const mockLoadConfig = mock(() => ({
	staleTimeoutMinutes: 30,
	strategy: { leaderAddress: "5FakeLeader" },
	rebalance: {
		minPositionTao: TAO / 2n,
		freeReserveTao: TAO / 10n,
		freeReserveTaoDriftPercent: 0.05,
		minOperationTao: TAO / 100n,
		minStakeTao: TAO / 100n,
		minRebalanceTao: TAO / 10n,
		slippageBuffer: 0.03,
		enforceSlippage: false,
		allocationDriftPercent: 0.25,
	},
}));
mock.module("../config.ts", () => ({
	loadCopyTradeConfig: mockLoadConfig,
}));

const mockGetLeaderShares = mock(() =>
	Promise.resolve({
		shares: [] as Array<{ netuid: number; share: number }>,
		leaderBalances: {
			free: 0n,
			reserved: 0n,
			stakes: [],
			totalTaoValue: 0n,
		} as Balances,
		filtered: [] as Array<{ netuid: number; reason: string }>,
	}),
);
mock.module("../getLeaderShares.ts", () => ({
	getLeaderShares: mockGetLeaderShares,
}));

const mockResolveValidators = mock(() =>
	Promise.resolve({
		hotkeysByTarget: new Map<number, string>(),
		skipped: [] as Array<{ netuid: number; reason: string }>,
	}),
);
mock.module("../../../validators/index.ts", () => ({
	resolveValidators: mockResolveValidators,
}));

const { getStrategyTargets } = await import("../index.ts");

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const client = {
	getTypedApi: () => ({}),
} as unknown as PolkadotClient;

const env = {
	wsEndpoints: ["wss://test"],
	archiveWsEndpoints: [],
	coldkey: "5FColdkey",
	proxyMnemonic: "test mnemonic",
	validatorHotkey: undefined,
	discordWebhookUrl: "https://discord.example/webhook",
	strategy: "copy-trade",
	leaderAddress: "5FakeLeader",
};

const balances: Balances = {
	free: 10n * TAO,
	reserved: 0n,
	stakes: [],
	totalTaoValue: 10n * TAO,
};

const strategyContext = {
	client,
	env,
	balances,
	historyDb: {} as never,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getStrategyTargets (copy-trade)", () => {
	beforeEach(() => {
		mockLoadConfig.mockClear();
		mockGetLeaderShares.mockClear();
		mockResolveValidators.mockClear();
	});

	it("falls back to 100% SN0 when all leader positions are dust-filtered", async () => {
		mockGetLeaderShares.mockResolvedValueOnce({
			shares: [],
			leaderBalances: {
				free: 1n * TAO,
				reserved: 0n,
				stakes: [
					{
						netuid: 5,
						hotkey: "5Hk1",
						stake: TAO / 10n,
						taoValue: TAO / 10n,
						alphaPrice: TAO,
					},
				],
				totalTaoValue: 1n * TAO,
			},
			filtered: [{ netuid: 5, reason: "dust: below min position" }],
		});

		mockResolveValidators.mockResolvedValueOnce({
			hotkeysByTarget: new Map([[0, "5HotkeySN0"]]),
			skipped: [],
		});

		const result = await getStrategyTargets(strategyContext);

		expect(result.targets).toHaveLength(1);
		expect(result.targets[0]?.netuid).toBe(0);
		expect(result.targets[0]?.hotkey).toBe("5HotkeySN0");
		expect(result.targets[0]?.share).toBeCloseTo(1.0);
	});

	it("drops targets whose validator cannot be resolved and re-normalizes shares", async () => {
		mockGetLeaderShares.mockResolvedValueOnce({
			shares: [
				{ netuid: 1, share: 0.6 },
				{ netuid: 2, share: 0.4 },
			],
			leaderBalances: {
				free: 0n,
				reserved: 0n,
				stakes: [],
				totalTaoValue: 100n * TAO,
			},
			filtered: [],
		});

		// Only SN1 has a resolved validator — SN2 is skipped
		mockResolveValidators.mockResolvedValueOnce({
			hotkeysByTarget: new Map([[1, "5HotkeySN1"]]),
			skipped: [{ netuid: 2, reason: "no validator found" }],
		});

		const result = await getStrategyTargets(strategyContext);

		expect(result.targets).toHaveLength(1);
		expect(result.targets[0]?.netuid).toBe(1);
		expect(result.targets[0]?.share).toBeCloseTo(1.0);

		const skipNetuids = result.skipped.map((s) => s.netuid);
		expect(skipNetuids).toContain(2);
	});

	it("returns empty targets when leader has no positions and nothing was filtered", async () => {
		mockGetLeaderShares.mockResolvedValueOnce({
			shares: [],
			leaderBalances: {
				free: 5n * TAO,
				reserved: 0n,
				stakes: [],
				totalTaoValue: 5n * TAO,
			},
			filtered: [],
		});

		const result = await getStrategyTargets(strategyContext);

		expect(result.targets).toEqual([]);
		expect(result.rebalanceConfig).toBeDefined();
		// resolveValidators should never be called for empty shares
		expect(mockResolveValidators).not.toHaveBeenCalled();
	});

	it("throws ConfigError when leaderAddress is missing", async () => {
		mockLoadConfig.mockReturnValueOnce({
			staleTimeoutMinutes: 30,
			strategy: { leaderAddress: "" },
			rebalance: {
				minPositionTao: TAO / 2n,
				freeReserveTao: TAO / 10n,
				freeReserveTaoDriftPercent: 0.05,
				minOperationTao: TAO / 100n,
				minStakeTao: TAO / 100n,
				minRebalanceTao: TAO / 10n,
				slippageBuffer: 0.03,
				enforceSlippage: false,
				allocationDriftPercent: 0.25,
			},
		});

		expect(getStrategyTargets(strategyContext)).rejects.toThrow(ConfigError);
	});

	it("preserves original shares when all validators resolve successfully", async () => {
		mockGetLeaderShares.mockResolvedValueOnce({
			shares: [
				{ netuid: 3, share: 0.7 },
				{ netuid: 8, share: 0.3 },
			],
			leaderBalances: {
				free: 0n,
				reserved: 0n,
				stakes: [],
				totalTaoValue: 50n * TAO,
			},
			filtered: [],
		});

		mockResolveValidators.mockResolvedValueOnce({
			hotkeysByTarget: new Map([
				[3, "5HotkeySN3"],
				[8, "5HotkeySN8"],
			]),
			skipped: [],
		});

		const result = await getStrategyTargets(strategyContext);

		expect(result.targets).toHaveLength(2);
		expect(result.targets[0]?.share).toBeCloseTo(0.7);
		expect(result.targets[1]?.share).toBeCloseTo(0.3);
	});
});

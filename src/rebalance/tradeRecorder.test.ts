import { describe, expect, test } from "bun:test";
import type { Balances } from "../balances/getBalances.ts";
import { buildTradeRecords } from "./tradeRecorder.ts";
import type {
	BatchResult,
	RebalancePlan,
	StakeOperation,
	SwapOperation,
	UnstakeOperation,
} from "./types.ts";

function makeBalances(
	stakes: Array<{
		netuid: number;
		hotkey: string;
		stake: bigint;
		alphaPrice: bigint;
		taoValue: bigint;
	}>,
): Balances {
	return {
		free: 100_000_000n,
		reserved: 0n,
		stakes: stakes.map((s) => ({ ...s })),
		totalTaoValue: stakes.reduce((sum, s) => sum + s.taoValue, 100_000_000n),
	};
}

describe("buildTradeRecords", () => {
	test("maps a simple swap operation correctly", () => {
		const swap: SwapOperation = {
			kind: "swap",
			originNetuid: 0,
			destinationNetuid: 88,
			hotkey: "5Hotkey...",
			alphaAmount: 1_000_000_000n,
			estimatedTaoValue: 2_700_000_000n,
			limitPrice: 0n,
		};

		const plan: RebalancePlan = {
			targets: [{ netuid: 88, hotkey: "5Hotkey...", share: 0.2 }],
			operations: [swap],
			skipped: [],
		};

		const before = makeBalances([
			{
				netuid: 0,
				hotkey: "5Hotkey...",
				stake: 10_000_000_000n,
				alphaPrice: 1_000_000_000n,
				taoValue: 10_000_000_000n,
			},
		]);

		const after = makeBalances([
			{
				netuid: 0,
				hotkey: "5Hotkey...",
				stake: 7_300_000_000n,
				alphaPrice: 1_000_000_000n,
				taoValue: 7_300_000_000n,
			},
			{
				netuid: 88,
				hotkey: "5Hotkey...",
				stake: 500_000_000n,
				alphaPrice: 5_400_000_000n,
				taoValue: 2_700_000_000n,
			},
		]);

		const batch: BatchResult = {
			status: "completed",
			blockNumber: 7909654,
			operationResults: [{ index: 0, success: true }],
			wrapperFee: 1_000_000n,
			innerBatchFee: 5_000_000n,
			innerTxHash: "0xabc123",
		};

		const records = buildTradeRecords(1, plan, before, after, batch);

		expect(records).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: test assertion
		const r = records[0]!;
		expect(r.cycleId).toBe(1);
		expect(r.opIndex).toBe(0);
		expect(r.opKind).toBe("swap");
		expect(r.netuid).toBe(88);
		expect(r.originNetuid).toBe(0);
		expect(r.hotkey).toBe("5Hotkey...");
		expect(r.success).toBe(true);
		expect(r.error).toBeNull();
		expect(r.estimatedTao).toBe(2_700_000_000n);
		// After snapshot has position on SN88
		expect(r.taoAfter).toBe(2_700_000_000n);
		expect(r.alphaAfter).toBe(500_000_000n);
		// Before snapshot has no SN88 position
		expect(r.taoBefore).toBeNull();
		expect(r.alphaBefore).toBeNull();
	});

	test("maps a failed operation", () => {
		const stake: StakeOperation = {
			kind: "stake",
			netuid: 42,
			hotkey: "5Hot...",
			taoAmount: 1_000_000_000n,
			limitPrice: 0n,
		};

		const plan: RebalancePlan = {
			targets: [{ netuid: 42, hotkey: "5Hot...", share: 0.2 }],
			operations: [stake],
			skipped: [],
		};

		const before = makeBalances([]);
		const after = makeBalances([]);

		const batch: BatchResult = {
			status: "partial_failure",
			blockNumber: 100,
			operationResults: [
				{ index: 0, success: false, error: "CannotStakeOnRoot" },
			],
			wrapperFee: 0n,
			innerBatchFee: 3_000_000n,
			innerTxHash: "0xdef456",
		};

		const records = buildTradeRecords(2, plan, before, after, batch);

		expect(records).toHaveLength(1);
		expect(records[0]?.success).toBe(false);
		expect(records[0]?.error).toBe("CannotStakeOnRoot");
		expect(records[0]?.estimatedTao).toBe(1_000_000_000n);
	});

	test("handles timeout batch result (no per-op results)", () => {
		const unstake: UnstakeOperation = {
			kind: "unstake",
			netuid: 5,
			hotkey: "5H...",
			alphaAmount: 500_000_000n,
			estimatedTaoValue: 500_000_000n,
			limitPrice: 0n,
		};

		const plan: RebalancePlan = {
			targets: [],
			operations: [unstake],
			skipped: [],
		};

		const before = makeBalances([
			{
				netuid: 5,
				hotkey: "5H...",
				stake: 500_000_000n,
				alphaPrice: 1_000_000_000n,
				taoValue: 500_000_000n,
			},
		]);
		const after = makeBalances([]);

		const batch: BatchResult = {
			status: "timeout",
			innerTxHash: "0xtimeout",
		};

		const records = buildTradeRecords(3, plan, before, after, batch);

		expect(records).toHaveLength(1);
		expect(records[0]?.success).toBe(false);
		expect(records[0]?.error).toBeNull();
		expect(records[0]?.taoBefore).toBe(500_000_000n);
	});

	test("handles multiple operations in a batch", () => {
		const ops: RebalancePlan["operations"] = [
			{
				kind: "swap",
				originNetuid: 0,
				destinationNetuid: 10,
				hotkey: "5H...",
				alphaAmount: 100n,
				estimatedTaoValue: 100n,
				limitPrice: 0n,
			},
			{
				kind: "swap",
				originNetuid: 0,
				destinationNetuid: 20,
				hotkey: "5H...",
				alphaAmount: 200n,
				estimatedTaoValue: 200n,
				limitPrice: 0n,
			},
		];

		const plan: RebalancePlan = {
			targets: [
				{ netuid: 10, hotkey: "5H...", share: 0.5 },
				{ netuid: 20, hotkey: "5H...", share: 0.5 },
			],
			operations: ops,
			skipped: [],
		};

		const before = makeBalances([
			{
				netuid: 0,
				hotkey: "5H...",
				stake: 1000n,
				alphaPrice: 1000n,
				taoValue: 1000n,
			},
		]);
		const after = makeBalances([
			{
				netuid: 10,
				hotkey: "5H...",
				stake: 50n,
				alphaPrice: 2000n,
				taoValue: 100n,
			},
			{
				netuid: 20,
				hotkey: "5H...",
				stake: 100n,
				alphaPrice: 2000n,
				taoValue: 200n,
			},
		]);

		const batch: BatchResult = {
			status: "completed",
			blockNumber: 500,
			operationResults: [
				{ index: 0, success: true },
				{ index: 1, success: true },
			],
			wrapperFee: 0n,
			innerBatchFee: 1000n,
			innerTxHash: "0xmulti",
		};

		const records = buildTradeRecords(5, plan, before, after, batch);

		expect(records).toHaveLength(2);
		expect(records[0]?.netuid).toBe(10);
		expect(records[0]?.originNetuid).toBe(0);
		expect(records[1]?.netuid).toBe(20);
		expect(records[1]?.originNetuid).toBe(0);
	});

	test("maps a move operation with correct before/after hotkey lookup", () => {
		const plan: RebalancePlan = {
			targets: [{ netuid: 7, hotkey: "5Dest...", share: 1 }],
			operations: [
				{
					kind: "move",
					netuid: 7,
					originHotkey: "5Origin...",
					destinationHotkey: "5Dest...",
					alphaAmount: 800_000_000n,
				},
			],
			skipped: [],
		};

		const before = makeBalances([
			{
				netuid: 7,
				hotkey: "5Origin...",
				stake: 800_000_000n,
				alphaPrice: 2_000_000_000n,
				taoValue: 1_600_000_000n,
			},
		]);

		const after = makeBalances([
			{
				netuid: 7,
				hotkey: "5Dest...",
				stake: 800_000_000n,
				alphaPrice: 2_000_000_000n,
				taoValue: 1_600_000_000n,
			},
		]);

		const batch: BatchResult = {
			status: "completed",
			blockNumber: 8000,
			operationResults: [{ index: 0, success: true }],
			wrapperFee: 0n,
			innerBatchFee: 1_000_000n,
			innerTxHash: "0xmove",
		};

		const records = buildTradeRecords(20, plan, before, after, batch);

		expect(records).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: test assertion
		const r = records[0]!;
		expect(r.opKind).toBe("move");
		expect(r.netuid).toBe(7);
		expect(r.hotkey).toBe("5Dest...");
		expect(r.success).toBe(true);
		// Before snapshot looked up under originHotkey
		expect(r.alphaBefore).toBe(800_000_000n);
		expect(r.taoBefore).toBe(1_600_000_000n);
		expect(r.spotPrice).toBe(2_000_000_000n);
		// After snapshot looked up under destinationHotkey
		expect(r.alphaAfter).toBe(800_000_000n);
		expect(r.taoAfter).toBe(1_600_000_000n);
	});

	test("handles null batchResult", () => {
		const plan: RebalancePlan = {
			targets: [{ netuid: 1, hotkey: "5H...", share: 1 }],
			operations: [
				{
					kind: "stake",
					netuid: 1,
					hotkey: "5H...",
					taoAmount: 100n,
					limitPrice: 0n,
				},
			],
			skipped: [],
		};

		const before = makeBalances([]);
		const after = makeBalances([]);

		const records = buildTradeRecords(10, plan, before, after, null);

		expect(records).toHaveLength(1);
		expect(records[0]?.success).toBe(false);
	});
});

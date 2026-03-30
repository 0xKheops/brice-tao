import { describe, expect, it } from "bun:test";
import type { BatchResult, RebalanceOperation } from "./types.ts";

describe("rebalance type contracts (runtime-safe assertions)", () => {
	it("supports discriminated operation handling by kind", () => {
		const operations: RebalanceOperation[] = [
			{
				kind: "stake",
				netuid: 1,
				hotkey: "5stake",
				taoAmount: 10n,
				limitPrice: 1n,
			},
			{
				kind: "unstake_partial",
				netuid: 2,
				hotkey: "5partial",
				alphaAmount: 7n,
				estimatedTaoValue: 8n,
				limitPrice: 2n,
			},
			{
				kind: "swap",
				originNetuid: 3,
				destinationNetuid: 4,
				hotkey: "5swap",
				alphaAmount: 9n,
				estimatedTaoValue: 10n,
				limitPrice: 3n,
			},
			{
				kind: "move",
				netuid: 4,
				originHotkey: "5swap",
				destinationHotkey: "5dest",
				alphaAmount: 18_446_744_073_709_551_615n,
			},
		];

		const totalInput = operations.reduce((acc, op) => {
			switch (op.kind) {
				case "stake":
					return acc + op.taoAmount;
				case "unstake":
				case "unstake_partial":
					return acc + op.alphaAmount;
				case "swap":
					return acc + op.alphaAmount;
				case "move":
					return acc;
			}
			return acc;
		}, 0n);

		expect(totalInput).toBe(26n);
	});

	it("supports timeout and settled batch result variants", () => {
		const timeout: BatchResult = {
			status: "timeout",
			innerTxHash: "0xdef",
		};
		const partialFailure: BatchResult = {
			status: "partial_failure",
			blockNumber: 10,
			operationResults: [{ index: 0, success: false, error: "boom" }],
			wrapperFee: 1n,
			innerBatchFee: 2n,
			innerTxHash: "0xabc",
		};

		expect(timeout.status).toBe("timeout");
		expect(partialFailure.status).toBe("partial_failure");
		if ("operationResults" in partialFailure) {
			expect(partialFailure.operationResults[0]?.error).toBe("boom");
			expect(partialFailure.wrapperFee + partialFailure.innerBatchFee).toBe(3n);
		}
	});
});

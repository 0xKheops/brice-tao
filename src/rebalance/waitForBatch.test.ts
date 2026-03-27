import { describe, expect, it, vi } from "bun:test";
import { Subject } from "rxjs";
import { waitForInnerBatch } from "./waitForBatch.ts";

function eventRecord(
	extrinsicIndex: number,
	event: { type: string; value: unknown },
) {
	return {
		phase: { type: "ApplyExtrinsic", value: extrinsicIndex },
		event,
	};
}

describe("waitForInnerBatch", () => {
	it("returns completed result when inner batch is found and all operations succeed", async () => {
		const finalizedBlock$ = new Subject<{ hash: string; number: number }>();
		const innerSignedBytes = new Uint8Array([1, 2, 3]);
		const getBlockBody = vi
			.fn()
			.mockResolvedValue([new Uint8Array([9, 9]), innerSignedBytes]);
		const getEvents = vi.fn().mockResolvedValue([
			eventRecord(1, {
				type: "TransactionPayment",
				value: {
					type: "TransactionFeePaid",
					value: { actual_fee: 12n },
				},
			}),
			eventRecord(1, {
				type: "Proxy",
				value: { type: "ProxyExecuted", value: { result: { success: true } } },
			}),
			eventRecord(1, { type: "Utility", value: { type: "ItemCompleted" } }),
			eventRecord(1, {
				type: "Proxy",
				value: { type: "ProxyExecuted", value: { result: { success: true } } },
			}),
			eventRecord(1, { type: "Utility", value: { type: "ItemCompleted" } }),
		]);

		const client = {
			finalizedBlock$,
			getBlockBody,
		};
		const api = {
			query: {
				System: {
					Events: {
						getValue: getEvents,
					},
				},
			},
		};

		const resultPromise = waitForInnerBatch(
			client as never,
			api as never,
			innerSignedBytes,
			2,
			5n,
		);
		finalizedBlock$.next({ hash: "0xabc", number: 42 });

		const result = await resultPromise;
		expect(result).toEqual({
			status: "completed",
			blockNumber: 42,
			operationResults: [
				{ index: 0, success: true },
				{ index: 1, success: true },
			],
			wrapperFee: 5n,
			innerBatchFee: 12n,
			innerTxHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
		});
	});

	it("returns partial_failure with formatted dispatch errors", async () => {
		const finalizedBlock$ = new Subject<{ hash: string; number: number }>();
		const innerSignedBytes = new Uint8Array([7, 7, 7]);
		const getBlockBody = vi.fn().mockResolvedValue([innerSignedBytes]);
		const getEvents = vi.fn().mockResolvedValue([
			eventRecord(0, {
				type: "TransactionPayment",
				value: {
					type: "TransactionFeePaid",
					value: { actual_fee: 3n },
				},
			}),
			eventRecord(0, {
				type: "Proxy",
				value: {
					type: "ProxyExecuted",
					value: {
						result: {
							success: false,
							value: {
								type: "Module",
								value: {
									type: "SubtensorModule",
									value: { type: "SlippageTooHigh" },
								},
							},
						},
					},
				},
			}),
			eventRecord(0, { type: "Utility", value: { type: "ItemCompleted" } }),
			eventRecord(0, {
				type: "Utility",
				value: {
					type: "ItemFailed",
					value: {
						error: { type: "Token", value: { type: "FundsUnavailable" } },
					},
				},
			}),
		]);

		const resultPromise = waitForInnerBatch(
			{ finalizedBlock$, getBlockBody } as never,
			{
				query: { System: { Events: { getValue: getEvents } } },
			} as never,
			innerSignedBytes,
			2,
			1n,
		);
		finalizedBlock$.next({ hash: "0xdef", number: 77 });

		const result = await resultPromise;
		expect(result).toEqual({
			status: "partial_failure",
			blockNumber: 77,
			operationResults: [
				{
					index: 0,
					success: false,
					error: "SubtensorModule::SlippageTooHigh",
				},
				{ index: 1, success: false, error: "Token::FundsUnavailable" },
			],
			wrapperFee: 1n,
			innerBatchFee: 3n,
			innerTxHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
		});
	});

	it("returns timeout result when no matching tx is found before timeout", async () => {
		const finalizedBlock$ = new Subject<{ hash: string; number: number }>();
		const result = await waitForInnerBatch(
			{
				finalizedBlock$,
				getBlockBody: vi.fn().mockResolvedValue([]),
			} as never,
			{
				query: { System: { Events: { getValue: vi.fn() } } },
			} as never,
			new Uint8Array([8, 8]),
			1,
			9n,
			10,
		);

		expect(result).toEqual({
			status: "timeout",
			wrapperFee: 9n,
			innerTxHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
		});
	});

	it("throws when block body retrieval fails", async () => {
		const finalizedBlock$ = new Subject<{ hash: string; number: number }>();
		const resultPromise = waitForInnerBatch(
			{
				finalizedBlock$,
				getBlockBody: vi.fn().mockRejectedValue(new Error("rpc failed")),
			} as never,
			{
				query: { System: { Events: { getValue: vi.fn() } } },
			} as never,
			new Uint8Array([4]),
			1,
			0n,
		);

		finalizedBlock$.next({ hash: "0xerr", number: 11 });
		await expect(resultPromise).rejects.toThrow("rpc failed");
	});
});

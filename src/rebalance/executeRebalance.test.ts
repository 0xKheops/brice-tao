import { beforeEach, describe, expect, it, vi } from "bun:test";

vi.mock("@polkadot-labs/hdkd-helpers", () => ({
	ss58Address: vi.fn(() => "proxy-address"),
}));

vi.mock("./mevShield.ts", () => ({
	submitShieldedTx: vi.fn(),
}));

import { ReplaySubject } from "rxjs";
import { TAO } from "./constants.ts";
import { executeRebalance } from "./executeRebalance.ts";
import { submitShieldedTx } from "./mevShield.ts";
import type { RebalancePlan } from "./types.ts";

function makeApi(nonce = 7) {
	const proxy = vi.fn((params: unknown) => ({
		decodedCall: { proxy: params },
		sign: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
	}));
	const forceBatchSign = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
	const force_batch = vi.fn((params: { calls: unknown[] }) => ({
		decodedCall: { utility: params.calls },
		sign: forceBatchSign,
	}));
	const accountGetValue = vi.fn().mockResolvedValue({ nonce });

	return {
		api: {
			tx: {
				Proxy: { proxy },
				Utility: { force_batch },
				SubtensorModule: {
					add_stake_limit: vi.fn((params: unknown) => ({
						decodedCall: { stake: params },
					})),
					add_stake: vi.fn((params: unknown) => ({
						decodedCall: { stake_simple: params },
					})),
					remove_stake_full_limit: vi.fn((params: unknown) => ({
						decodedCall: { unstake: params },
					})),
					remove_stake_limit: vi.fn(),
					remove_stake: vi.fn((params: unknown) => ({
						decodedCall: { unstake_simple: params },
					})),
					swap_stake_limit: vi.fn(),
					move_stake: vi.fn((params: unknown) => ({
						decodedCall: { move: params },
					})),
				},
			},
			query: {
				System: {
					Account: {
						getValue: accountGetValue,
					},
					Events: {
						getValue: vi.fn().mockResolvedValue([]),
					},
				},
			},
		},
		proxy,
		force_batch,
		forceBatchSign,
		accountGetValue,
	};
}

function makePlan(): RebalancePlan {
	return {
		targets: [],
		operations: [
			{
				kind: "stake",
				netuid: 18,
				hotkey: "5stake-hotkey",
				taoAmount: 2n * TAO,
				limitPrice: 123n,
			},
		],
		skipped: [],
	};
}

function makeMultiOpPlan(): RebalancePlan {
	return {
		targets: [],
		operations: [
			{
				kind: "stake",
				netuid: 18,
				hotkey: "5stake-hotkey",
				taoAmount: 2n * TAO,
				limitPrice: 123n,
			},
			{
				kind: "unstake",
				netuid: 7,
				hotkey: "5unstake-hotkey",
				alphaAmount: 1n * TAO,
				limitPrice: 456n,
				estimatedTaoValue: 1n * TAO,
			},
		],
		skipped: [],
	};
}

describe("executeRebalance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns null when there are no operations", async () => {
		const { api } = makeApi();
		const result = await executeRebalance(
			{} as never,
			api as never,
			{ publicKey: new Uint8Array([1]) } as never,
			"5cold",
			{ targets: [], operations: [], skipped: [] },
		);

		expect(result).toBeNull();
	});

	it("does not wrap in force_batch for a single operation (dry run)", async () => {
		const { api, force_batch } = makeApi();
		await executeRebalance(
			{} as never,
			api as never,
			{ publicKey: new Uint8Array([4]) } as never,
			"5cold",
			makePlan(),
			{ dryRun: true },
		);

		expect(force_batch).not.toHaveBeenCalled();
	});

	it("wraps in force_batch for multiple operations (dry run)", async () => {
		const { api, force_batch } = makeApi();
		await executeRebalance(
			{} as never,
			api as never,
			{ publicKey: new Uint8Array([4]) } as never,
			"5cold",
			makeMultiOpPlan(),
			{ dryRun: true },
		);

		expect(force_batch).toHaveBeenCalledTimes(1);
	});

	it("returns null in dry run mode without touching network submission path", async () => {
		const { api, accountGetValue, forceBatchSign } = makeApi();
		const result = await executeRebalance(
			{} as never,
			api as never,
			{ publicKey: new Uint8Array([4]) } as never,
			"5cold",
			makePlan(),
			{ dryRun: true },
		);

		expect(result).toBeNull();
		expect(accountGetValue).not.toHaveBeenCalled();
		expect(forceBatchSign).not.toHaveBeenCalled();
		expect(submitShieldedTx).not.toHaveBeenCalled();
	});

	it("submits directly when no MEV shield key is available", async () => {
		const { api } = makeApi();

		const signAndSubmit = vi.fn().mockResolvedValue({
			block: { number: 42, hash: "0xdirect" },
			txHash: "0xdeadbeef",
			events: [
				{
					type: "TransactionPayment",
					value: {
						type: "TransactionFeePaid",
						value: { actual_fee: 5n },
					},
				},
				{
					type: "Proxy",
					value: {
						type: "ProxyExecuted",
						value: { result: { success: true } },
					},
				},
			],
		});

		// Mock the proxy call to return a tx with signAndSubmit
		api.tx.Proxy.proxy = vi.fn(() => ({
			decodedCall: { proxy: "mocked" },
			sign: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
			signAndSubmit,
		}));

		const result = await executeRebalance(
			{} as never,
			api as never,
			{ publicKey: new Uint8Array([2]) } as never,
			"5cold",
			makePlan(),
		);

		expect(result).toBeDefined();
		expect(result?.status).toBe("completed");
		expect(result?.wrapperFee).toBe(0n);
		expect(submitShieldedTx).not.toHaveBeenCalled();
	});

	it("signs, submits and waits for inner tx with expected nonce flow (single op)", async () => {
		const { api, proxy, force_batch } = makeApi(14);
		const mevKey = new Uint8Array([9, 9]);
		(submitShieldedTx as ReturnType<typeof vi.fn>).mockResolvedValue({
			block: { number: 99 },
			events: [
				{
					type: "TransactionPayment",
					value: {
						type: "TransactionFeePaid",
						value: { actual_fee: 7n },
					},
				},
			],
		} as never);
		const finalizedBlock$ = new ReplaySubject<{ hash: string; number: number }>(
			1,
		);
		const getBlockBody = vi.fn().mockResolvedValue([new Uint8Array([1, 2, 3])]);
		// Single op: only Proxy.ProxyExecuted, no Utility events
		api.query.System.Events.getValue.mockResolvedValue([
			{
				phase: { type: "ApplyExtrinsic", value: 0 },
				event: {
					type: "TransactionPayment",
					value: {
						type: "TransactionFeePaid",
						value: { actual_fee: 2n },
					},
				},
			},
			{
				phase: { type: "ApplyExtrinsic", value: 0 },
				event: {
					type: "Proxy",
					value: {
						type: "ProxyExecuted",
						value: { result: { success: true } },
					},
				},
			},
		]);

		const signer = { publicKey: new Uint8Array([5, 6, 7]) };
		finalizedBlock$.next({ hash: "0xinner", number: 100 });
		const resultPromise = executeRebalance(
			{ finalizedBlock$, getBlockBody } as never,
			api as never,
			signer as never,
			"5cold",
			makePlan(),
			{ mevKey },
		);
		const result = await resultPromise;

		// Single op: proxy call signed directly, no force_batch
		expect(force_batch).not.toHaveBeenCalled();
		const proxySign = (
			proxy.mock.results[0]?.value as { sign: ReturnType<typeof vi.fn> }
		).sign;
		expect(proxySign).toHaveBeenCalledWith(signer, { nonce: 15 });
		expect(submitShieldedTx).toHaveBeenCalledWith(
			api,
			signer,
			new Uint8Array([1, 2, 3]),
			mevKey,
			14,
		);
		expect(getBlockBody).toHaveBeenCalledWith("0xinner");
		expect(result).toEqual({
			status: "completed",
			blockNumber: 100,
			operationResults: [{ index: 0, success: true }],
			wrapperFee: 7n,
			innerBatchFee: 2n,
			innerTxHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
		});
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	sendErrorNotification,
	sendNoRebalanceNotification,
	sendRebalanceNotification,
} from "./discord.ts";
import type { Balances } from "./getBalances.ts";
import { parseTao, TAO } from "./rebalance/tao.ts";
import type { BatchResult, RebalancePlan } from "./rebalance/types.ts";

const webhookUrl = "https://discord.example/webhook";
const originalFetch = globalThis.fetch;

function makeBalances(overrides?: Partial<Balances>): Balances {
	return {
		free: 0n,
		reserved: 0n,
		stakes: [],
		totalTaoValue: parseTao(5),
		...overrides,
	};
}

function parsePostedBody(fetchMock: ReturnType<typeof vi.fn>) {
	const call = fetchMock.mock.calls[0];
	const init = call?.[1] as { body: string };
	return JSON.parse(init.body) as {
		embeds: Array<{
			title: string;
			fields: Array<{ name: string; value: string }>;
		}>;
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	Object.defineProperty(globalThis, "fetch", {
		value: originalFetch,
		writable: true,
		configurable: true,
	});
});

describe("discord notifications", () => {
	it("sends partial failure embed with per-operation status and total fees", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		Object.defineProperty(globalThis, "fetch", {
			value: fetchMock,
			writable: true,
			configurable: true,
		});

		const plan: RebalancePlan = {
			targets: [],
			operations: [
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
			],
			skipped: [],
		};
		const batchResult: BatchResult = {
			status: "partial_failure",
			blockNumber: 55,
			operationResults: [
				{ index: 0, success: true },
				{ index: 1, success: false, error: "Token::FundsUnavailable" },
			],
			wrapperFee: 1_500_000n,
			innerBatchFee: 500_000n,
		};

		await sendRebalanceNotification(webhookUrl, {
			plan,
			balancesBefore: makeBalances(),
			balancesAfter: makeBalances(),
			proxyFreeBalance: 20_000_000n,
			batchResult,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = parsePostedBody(fetchMock);
		expect(body.embeds[0]?.title).toBe("⚠️ Rebalance Partial Failure");
		const batchField = body.embeds[0]?.fields.find((f) =>
			f.name.includes("Batch Partial Failure"),
		);
		expect(batchField?.value).toContain("1/2 succeeded, 1 failed");
		const feesField = body.embeds[0]?.fields.find((f) =>
			f.name.includes("Fees"),
		);
		expect(feesField?.value).toContain("0.002 τ");
		const operationsField = body.embeds[0]?.fields.find((f) =>
			f.name.includes("Operations"),
		);
		expect(operationsField?.value).toContain("✅ 📥 STAKE SN1");
		expect(operationsField?.value).toContain("❌ 📤 UNSTAKE SN2");
		expect(operationsField?.value).toContain("Token::FundsUnavailable");
	});

	it("sends timeout outcome and wrapper-only fee in timeout mode", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		Object.defineProperty(globalThis, "fetch", {
			value: fetchMock,
			writable: true,
			configurable: true,
		});

		await sendRebalanceNotification(webhookUrl, {
			plan: { targets: [], operations: [], skipped: [] },
			balancesBefore: makeBalances(),
			balancesAfter: makeBalances(),
			proxyFreeBalance: 5_000_000n,
			batchResult: { status: "timeout", wrapperFee: 4_000_000n },
		});

		const body = parsePostedBody(fetchMock);
		expect(body.embeds[0]?.title).toBe("❓ Rebalance Outcome Unknown");
		const batchField = body.embeds[0]?.fields.find((f) =>
			f.name.includes("Batch Execution Unknown"),
		);
		expect(batchField?.value).toContain("Timed out waiting for inner batch");
		const feesField = body.embeds[0]?.fields.find((f) =>
			f.name.includes("Fees"),
		);
		expect(feesField?.value).toContain("Wrapper: 0.004 τ");
	});

	it("sends error notification with message and stack", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		Object.defineProperty(globalThis, "fetch", {
			value: fetchMock,
			writable: true,
			configurable: true,
		});
		const error = new Error("rebalance exploded");
		error.stack = "Error: rebalance exploded\n  at line 1";

		await sendErrorNotification(webhookUrl, error);

		const body = parsePostedBody(fetchMock);
		expect(body.embeds[0]?.title).toBe("❌ Rebalance Failed");
		const fields = body.embeds[0]?.fields ?? [];
		expect(fields[0]?.value).toBe("rebalance exploded");
		expect(fields[1]?.value).toContain("Error: rebalance exploded");
	});

	it("logs webhook errors when discord responds with non-OK status", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text: vi.fn().mockResolvedValue("internal error"),
		});
		Object.defineProperty(globalThis, "fetch", {
			value: fetchMock,
			writable: true,
			configurable: true,
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await sendNoRebalanceNotification(webhookUrl, makeBalances(), 100_000_000n);

		expect(errorSpy).toHaveBeenCalledWith(
			"Discord webhook failed: 500 internal error",
		);
	});
});

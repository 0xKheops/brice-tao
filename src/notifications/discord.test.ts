import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Balances } from "../balances/getBalances.ts";
import { parseTao, TAO } from "../rebalance/tao.ts";
import type { BatchResult, RebalancePlan } from "../rebalance/types.ts";
import { sendErrorNotification, sendRebalanceNotification } from "./discord.ts";

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
			innerTxHash: "0xdeadbeef",
		};

		await sendRebalanceNotification(webhookUrl, {
			plan,
			balancesBefore: makeBalances(),
			balancesAfter: makeBalances(),
			proxyFreeBalanceBefore: 20_000_000n,
			proxyFreeBalanceAfter: 20_000_000n,
			batchResult,
			durationMs: 12_500,
			coldkeyAddress: "5FakeAddress",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = parsePostedBody(fetchMock);
		expect(body.embeds[0]?.title).toBe("⚠️ Rebalance Partial Failure");
		// Merged transaction field includes batch status, fees, and link
		const txField = body.embeds[0]?.fields.find((f) =>
			f.name.includes("Transaction"),
		);
		expect(txField?.name).toContain("Partial Failure");
		expect(txField?.value).toContain("1/2 succeeded, 1 failed");
		expect(txField?.value).toContain("View transaction on explorer");
		expect(txField?.value).toContain("0.002000 τ");
		const operationsField = body.embeds[0]?.fields.find((f) =>
			f.name.includes("Operations"),
		);
		expect(operationsField?.value).toContain("✅ 📥 STAKE SN1");
		expect(operationsField?.value).toContain("❌ 📤 UNSTAKE SN2");
		expect(operationsField?.value).toContain("Token::FundsUnavailable");
		// Balances section includes proxy and explorer link, field name has portfolio total
		const balancesField = body.embeds[0]?.fields.find((f) =>
			f.name.includes("Portfolio"),
		);
		expect(balancesField?.name).toContain("📊");
		expect(balancesField?.value).toContain("**Proxy**");
		expect(balancesField?.value).toContain("taostats.io/account/5FakeAddress");
		// No separate Portfolio Value or Proxy Balance fields
		expect(
			body.embeds[0]?.fields.find((f) => f.name.includes("Portfolio Value")),
		).toBeUndefined();
		expect(
			body.embeds[0]?.fields.find((f) => f.name.includes("Proxy Balance")),
		).toBeUndefined();
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
			proxyFreeBalanceBefore: 5_000_000n,
			proxyFreeBalanceAfter: 5_000_000n,
			batchResult: {
				status: "timeout",
				wrapperFee: 4_000_000n,
				innerTxHash: "0xabc",
			},
			durationMs: 60_000,
			coldkeyAddress: "5FakeAddress",
		});

		const body = parsePostedBody(fetchMock);
		expect(body.embeds[0]?.title).toBe("❓ Rebalance Outcome Unknown");
		const batchField = body.embeds[0]?.fields.find((f) =>
			f.name.includes("Outcome Unknown"),
		);
		expect(batchField?.value).toContain("Timed out waiting for inner batch");
		expect(batchField?.value).toContain("View transaction on explorer");
		expect(batchField?.value).toContain("0.004000 τ");
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

		await sendErrorNotification(webhookUrl, error, 3_200);

		const body = parsePostedBody(fetchMock);
		expect(body.embeds[0]?.title).toBe("❌ Rebalance Failed");
		const fields = body.embeds[0]?.fields ?? [];
		expect(fields[0]?.value).toBe("rebalance exploded");
		expect(fields[1]?.value).toContain("Error: rebalance exploded");
	});

	it("throws when discord responds with non-OK status", async () => {
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

		await expect(
			sendErrorNotification(webhookUrl, new Error("test"), 1_000),
		).rejects.toThrow("Discord webhook 500: internal error");
	});
});

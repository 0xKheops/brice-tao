import { parseTao, TAO } from "../rebalance/tao.ts";
import type {
	BatchResult,
	OperationResult,
	RebalanceOperation,
	RebalancePlan,
} from "../rebalance/types.ts";
import type { Balances } from "./getBalances.ts";

const LOW_PROXY_THRESHOLD = parseTao(0.05);

function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function formatTao(rao: bigint): string {
	const whole = rao / TAO;
	const frac = ((rao % TAO) * 1000n) / TAO;
	return `${whole}.${frac.toString().padStart(3, "0")}`;
}

function describeOp(op: RebalanceOperation): string {
	switch (op.kind) {
		case "swap":
			return `🔄 SWAP SN${op.originNetuid} → SN${op.destinationNetuid}: ~${formatTao(op.estimatedTaoValue)} τ`;
		case "unstake":
			return `📤 UNSTAKE SN${op.netuid}: ~${formatTao(op.estimatedTaoValue)} τ (full)`;
		case "unstake_partial":
			return `📤 UNSTAKE SN${op.netuid}: ~${formatTao(op.estimatedTaoValue)} τ (partial)`;
		case "stake":
			return `📥 STAKE SN${op.netuid}: ${formatTao(op.taoAmount)} τ`;
	}
}

function describeOpWithResult(
	op: RebalanceOperation,
	result: OperationResult | null,
): string {
	const base = describeOp(op);
	if (!result) return base; // dry run or no result available
	if (result.success) return `✅ ${base}`;
	const errorSuffix = result.error ? ` — ${result.error}` : "";
	return `❌ ${base}${errorSuffix}`;
}

function getOperationResult(
	batchResult: BatchResult | null,
	index: number,
): OperationResult | null {
	if (!batchResult) return null;
	if (batchResult.status === "timeout") return null;
	return batchResult.operationResults[index] ?? null;
}

function buildBalancesTable(balances: Balances): string {
	const lines: string[] = [];

	if (balances.free > 0n) {
		lines.push(`${"TAO".padEnd(5)} │ ${formatTao(balances.free)} τ`);
	}

	const sortedStakes = balances.stakes.sort((a, b) =>
		Number(b.taoValue - a.taoValue),
	);
	for (const s of sortedStakes) {
		lines.push(
			`SN${s.netuid.toString().padStart(3)} │ ${formatTao(s.taoValue)} τ`,
		);
	}

	if (lines.length === 0) return "*No balances*";
	return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

function proxyBalanceField(proxyFreeBalance: bigint): {
	name: string;
	value: string;
	inline: boolean;
} {
	const low = proxyFreeBalance < LOW_PROXY_THRESHOLD;
	const indicator = low ? "🔴" : "🟢";
	const warning = low ? " ⚠️ **LOW — refill needed**" : "";
	return {
		name: `${indicator} Proxy Balance`,
		value: `${formatTao(proxyFreeBalance)} τ${warning}`,
		inline: false,
	};
}

function batchResultField(
	result: BatchResult | null,
	totalOps: number,
): { name: string; value: string; inline: boolean } | null {
	if (!result) return null;

	switch (result.status) {
		case "completed": {
			const succeeded = result.operationResults.filter((r) => r.success).length;
			return {
				name: "🟢 Batch Execution",
				value: `All ${succeeded} operations executed successfully (block #${result.blockNumber})`,
				inline: false,
			};
		}
		case "partial_failure": {
			const succeeded = result.operationResults.filter((r) => r.success).length;
			const failed = result.operationResults.filter((r) => !r.success).length;
			return {
				name: "🟡 Batch Partial Failure",
				value: `${succeeded}/${totalOps} succeeded, ${failed} failed (block #${result.blockNumber})`,
				inline: false,
			};
		}
		case "timeout":
			return {
				name: "🔴 Batch Execution Unknown",
				value:
					"Timed out waiting for inner batch execution. Check chain explorer for results.",
				inline: false,
			};
	}
}

function feesField(
	result: BatchResult | null,
): { name: string; value: string; inline: boolean } | null {
	if (!result) return null;

	if (result.status === "timeout") {
		if (result.wrapperFee != null && result.wrapperFee > 0n) {
			return {
				name: "💸 Transaction Fees",
				value: `Wrapper: ${formatTao(result.wrapperFee)} τ (inner batch unknown)`,
				inline: false,
			};
		}
		return null;
	}

	const total = result.wrapperFee + result.innerBatchFee;
	return {
		name: "💸 Transaction Fees",
		value: `${formatTao(total)} τ`,
		inline: false,
	};
}

function txLinkField(
	result: BatchResult | null,
): { name: string; value: string; inline: boolean } | null {
	if (!result) return null;
	return {
		name: "🔗 Transaction",
		value: `[View on Taostats](https://taostats.io/transaction/${result.innerTxHash})`,
		inline: false,
	};
}

export async function sendRebalanceNotification(
	webhookUrl: string,
	opts: {
		plan: RebalancePlan;
		balancesBefore: Balances;
		balancesAfter: Balances;
		proxyFreeBalanceBefore: bigint;
		proxyFreeBalanceAfter: bigint;
		batchResult: BatchResult | null;
		durationMs: number;
	},
): Promise<void> {
	const {
		plan,
		balancesBefore,
		balancesAfter,
		proxyFreeBalanceBefore,
		proxyFreeBalanceAfter,
		batchResult,
		durationMs,
	} = opts;

	let title: string;
	let color: number;
	if (batchResult?.status === "partial_failure") {
		title = "⚠️ Rebalance Partial Failure";
		color = 0xf0b232;
	} else if (batchResult?.status === "timeout") {
		title = "❓ Rebalance Outcome Unknown";
		color = 0xed4245;
	} else {
		title = "✅ Rebalance Complete";
		color = 0x57f287;
	}

	const operationLines =
		plan.operations.length > 0
			? plan.operations
					.map((op, i) => {
						const opResult = getOperationResult(batchResult, i);
						return describeOpWithResult(op, opResult);
					})
					.join("\n")
			: "Portfolio is balanced — no operations needed.";

	const valueBefore = formatTao(
		balancesBefore.totalTaoValue + proxyFreeBalanceBefore,
	);
	const valueAfter = formatTao(
		balancesAfter.totalTaoValue + proxyFreeBalanceAfter,
	);

	const batchField = batchResultField(batchResult, plan.operations.length);
	const feeField = feesField(batchResult);
	const txLink = txLinkField(batchResult);

	const balancesCount =
		balancesAfter.stakes.length + (balancesAfter.free > 0n ? 1 : 0);

	const embeds = [
		{
			title,
			color,
			fields: [
				{
					name: "💰 Portfolio Value",
					value: `${valueBefore} τ → ${valueAfter} τ`,
					inline: false,
				},
				proxyBalanceField(proxyFreeBalanceAfter),
				...(batchField ? [batchField] : []),
				...(txLink ? [txLink] : []),
				...(feeField ? [feeField] : []),
				{
					name: `📋 Operations (${plan.operations.length})`,
					value: operationLines,
					inline: false,
				},
				{
					name: `📊 Balances (${balancesCount})`,
					value: buildBalancesTable(balancesAfter),
					inline: false,
				},
			],
			footer: { text: `Completed in ${formatDuration(durationMs)}` },
			timestamp: new Date().toISOString(),
		},
	];

	await postWebhook(webhookUrl, { embeds });
}

export async function sendNoRebalanceNotification(
	webhookUrl: string,
	balances: Balances,
	proxyFreeBalance: bigint,
	durationMs: number,
): Promise<void> {
	const balancesCount = balances.stakes.length + (balances.free > 0n ? 1 : 0);

	const embeds = [
		{
			title: "⚖️ Portfolio Balanced",
			description: "No operations needed — portfolio is already balanced.",
			color: 0x3498db,
			fields: [
				{
					name: "💰 Portfolio Value",
					value: `${formatTao(balances.totalTaoValue + proxyFreeBalance)} τ`,
					inline: false,
				},
				proxyBalanceField(proxyFreeBalance),
				{
					name: `📊 Balances (${balancesCount})`,
					value: buildBalancesTable(balances),
					inline: false,
				},
			],
			footer: { text: `Completed in ${formatDuration(durationMs)}` },
			timestamp: new Date().toISOString(),
		},
	];

	await postWebhook(webhookUrl, { embeds });
}

export async function sendErrorNotification(
	webhookUrl: string,
	error: unknown,
	durationMs: number,
): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	const stack =
		error instanceof Error && error.stack
			? `\`\`\`\n${error.stack.slice(0, 1000)}\n\`\`\``
			: undefined;

	const embeds = [
		{
			title: "❌ Rebalance Failed",
			color: 0xed4245,
			fields: [
				{ name: "Error", value: message, inline: false },
				...(stack ? [{ name: "Stack", value: stack, inline: false }] : []),
			],
			footer: { text: `Failed after ${formatDuration(durationMs)}` },
			timestamp: new Date().toISOString(),
		},
	];

	await postWebhook(webhookUrl, { embeds });
}

async function postWebhook(
	url: string,
	body: Record<string, unknown>,
): Promise<void> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
	}
}

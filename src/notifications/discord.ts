import type { Balances } from "../balances/getBalances.ts";
import { formatTao, parseTao } from "../rebalance/tao.ts";
import type {
	BatchResult,
	OperationResult,
	RebalanceOperation,
	RebalancePlan,
} from "../rebalance/types.ts";

const LOW_PROXY_THRESHOLD = parseTao(0.05);

function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
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
		case "move":
			return `🔀 MOVE SN${op.netuid}: change validator`;
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

function buildBalancesSection(
	balances: Balances,
	proxyFreeBalance: bigint,
	coldkeyAddress: string,
): string {
	const lines: string[] = [];

	if (balances.free > 0n) {
		lines.push(`${"TAO".padEnd(5)} │ ${formatTao(balances.free)} τ`);
	}

	const sortedStakes = balances.stakes.toSorted((a, b) =>
		Number(b.taoValue - a.taoValue),
	);
	for (const s of sortedStakes) {
		lines.push(
			`SN${s.netuid.toString().padStart(3)} │ ${formatTao(s.taoValue)} τ`,
		);
	}

	const table =
		lines.length > 0 ? `\`\`\`\n${lines.join("\n")}\n\`\`\`` : "*No balances*";

	const low = proxyFreeBalance < LOW_PROXY_THRESHOLD;
	const proxyIndicator = low ? "🔴" : "🟢";
	const proxyWarning = low ? " ⚠️ **LOW — refill needed**" : "";

	const footer = [
		`${proxyIndicator} **Proxy** ${formatTao(proxyFreeBalance)} τ${proxyWarning}`,
		`[View account on explorer](https://taostats.io/account/${coldkeyAddress})`,
	].join("\n");

	return `${table}\n${footer}`;
}

function transactionField(
	result: BatchResult | null,
	totalOps: number,
): { name: string; value: string; inline: boolean } | null {
	if (!result) return null;

	const link = `[View transaction on explorer](https://taostats.io/transaction/${result.innerTxHash})`;

	switch (result.status) {
		case "completed": {
			const succeeded = result.operationResults.filter((r) => r.success).length;
			const total = result.wrapperFee + result.innerBatchFee;
			return {
				name: "🟢 Transaction",
				value: `All ${succeeded} operations executed (block #${result.blockNumber})\nFees: ${formatTao(total, 6)} τ\n${link}`,
				inline: false,
			};
		}
		case "partial_failure": {
			const succeeded = result.operationResults.filter((r) => r.success).length;
			const failed = result.operationResults.filter((r) => !r.success).length;
			const total = result.wrapperFee + result.innerBatchFee;
			return {
				name: "🟡 Transaction — Partial Failure",
				value: `${succeeded}/${totalOps} succeeded, ${failed} failed (block #${result.blockNumber})\nFees: ${formatTao(total, 6)} τ\n${link}`,
				inline: false,
			};
		}
		case "timeout": {
			const feeLine =
				result.wrapperFee != null && result.wrapperFee > 0n
					? `\nFees: ${formatTao(result.wrapperFee, 6)} τ (wrapper only, inner unknown)`
					: "";
			return {
				name: "🔴 Transaction — Outcome Unknown",
				value: `Timed out waiting for inner batch execution.${feeLine}\n${link}`,
				inline: false,
			};
		}
	}
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
		coldkeyAddress: string;
	},
): Promise<void> {
	const {
		plan,
		balancesAfter,
		proxyFreeBalanceAfter,
		batchResult,
		durationMs,
		coldkeyAddress,
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

	const tx = transactionField(batchResult, plan.operations.length);

	const portfolioValue = balancesAfter.totalTaoValue + proxyFreeBalanceAfter;

	const embeds = [
		{
			title,
			color,
			fields: [
				...(tx ? [tx] : []),
				{
					name: `📋 Operations (${plan.operations.length})`,
					value: operationLines,
					inline: false,
				},
				{
					name: `📊 Portfolio ${formatTao(portfolioValue)} τ`,
					value: buildBalancesSection(
						balancesAfter,
						proxyFreeBalanceAfter,
						coldkeyAddress,
					),
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
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: (JSON.stringify(error, null, 2)?.slice(0, 1000) ?? "Unknown error");
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
		const text = await res.text().catch(() => "");
		throw new Error(`Discord webhook ${res.status}: ${text}`);
	}
}

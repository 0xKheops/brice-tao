import type { Balances } from "./getBalances.ts";
import type { RebalanceOperation, RebalancePlan } from "./rebalance/types.ts";

const TAO = 1_000_000_000n;
const LOW_PROXY_THRESHOLD = TAO / 100n; // 0.01 TAO

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

function buildPositionsTable(balances: Balances): string {
	if (balances.stakes.length === 0) return "*No positions*";

	const lines = balances.stakes
		.sort((a, b) => Number(b.taoValue - a.taoValue))
		.map(
			(s) =>
				`SN${s.netuid.toString().padStart(3)} │ ${formatTao(s.taoValue)} τ`,
		);
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

export async function sendRebalanceNotification(
	webhookUrl: string,
	opts: {
		plan: RebalancePlan;
		balancesBefore: Balances;
		balancesAfter: Balances;
		proxyFreeBalance: bigint;
		dryRun: boolean;
	},
): Promise<void> {
	const { plan, balancesBefore, balancesAfter, proxyFreeBalance, dryRun } =
		opts;

	const title = dryRun ? "🧪 Rebalance Dry Run" : "✅ Rebalance Complete";

	const operationLines =
		plan.operations.length > 0
			? plan.operations.map(describeOp).join("\n")
			: "Portfolio is balanced — no operations needed.";

	const valueBefore = formatTao(balancesBefore.totalTaoValue);
	const valueAfter = formatTao(balancesAfter.totalTaoValue);

	const embeds = [
		{
			title,
			color: dryRun ? 0xf0b232 : 0x57f287,
			fields: [
				{
					name: "💰 Portfolio Value",
					value: `${valueBefore} τ → ${valueAfter} τ`,
					inline: false,
				},
				proxyBalanceField(proxyFreeBalance),
				{
					name: `📋 Operations (${plan.operations.length})`,
					value: operationLines,
					inline: false,
				},
				{
					name: `📊 Positions (${balancesAfter.stakes.length})`,
					value: buildPositionsTable(balancesAfter),
					inline: false,
				},
			],
			timestamp: new Date().toISOString(),
		},
	];

	await postWebhook(webhookUrl, { embeds });
}

export async function sendNoRebalanceNotification(
	webhookUrl: string,
	balances: Balances,
	proxyFreeBalance: bigint,
): Promise<void> {
	const embeds = [
		{
			title: "⚖️ Portfolio Balanced",
			description: "No operations needed — portfolio is already balanced.",
			color: 0x3498db,
			fields: [
				{
					name: "💰 Portfolio Value",
					value: `${formatTao(balances.totalTaoValue)} τ`,
					inline: false,
				},
				proxyBalanceField(proxyFreeBalance),
				{
					name: `📊 Positions (${balances.stakes.length})`,
					value: buildPositionsTable(balances),
					inline: false,
				},
			],
			timestamp: new Date().toISOString(),
		},
	];

	await postWebhook(webhookUrl, { embeds });
}

export async function sendErrorNotification(
	webhookUrl: string,
	error: unknown,
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

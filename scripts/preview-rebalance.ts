import { mkdir, writeFile } from "node:fs/promises";
import { createBittensorClient } from "../src/api/createClient.ts";
import type { Balances } from "../src/balances/getBalances.ts";
import { getBalances } from "../src/balances/getBalances.ts";
import { computeRebalance } from "../src/rebalance/computeRebalance.ts";
import { formatTao } from "../src/rebalance/tao.ts";
import type { RebalanceOperation } from "../src/rebalance/types.ts";
import { loadStrategy, resolveStrategyName } from "../src/strategies/loader.ts";

// ---------------------------------------------------------------------------
// Environment & strategy
// ---------------------------------------------------------------------------
const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const coldkey = process.env.COLDKEY_ADDRESS;
const envStrategy = process.env.STRATEGY;

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!coldkey) throw new Error("COLDKEY_ADDRESS is not set");

const strategyName = resolveStrategyName(envStrategy);
const { getStrategyTargets } = await loadStrategy(strategyName);
console.log(`Strategy: ${strategyName}`);

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------
const { client, api } = createBittensorClient(wsEndpoints);

try {
	console.log("Fetching on-chain data and running strategy…");

	// Fetch balances
	const balances = await getBalances(api, coldkey);

	// Build a minimal env object for the strategy
	const strategyEnv = {
		wsEndpoints,
		coldkey,
		proxyMnemonic: process.env.PROXY_MNEMONIC ?? "",
		validatorHotkey: process.env.VALIDATOR_HOTKEY,
		discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? "",
		strategy: envStrategy,
		leaderAddress: process.env.LEADER_ADDRESS,
		archiveWsEndpoints: process.env.ARCHIVE_WS_ENDPOINT?.split(",") ?? [],
	};

	// Run strategy
	const {
		targets,
		skipped: strategySkips,
		rebalanceConfig,
		audit,
	} = await getStrategyTargets(client, strategyEnv, balances);

	// Print strategy-specific terminal output
	if (audit) {
		for (const line of audit.terminalLines) {
			console.log(line);
		}
	}

	// Compute rebalance plan
	const plan = computeRebalance(balances, targets, rebalanceConfig);
	plan.skipped.push(...strategySkips);

	// --- Portfolio & operations terminal output ---
	const subnetNames = new Map<number, string>(); // populated from audit if available
	printPortfolio(balances, subnetNames, rebalanceConfig.freeReserveTao);
	printOperations(plan.operations, plan.skipped, subnetNames);

	// --- Build markdown report ---
	const now = new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, " UTC");

	let md = `# Rebalance Preview\n\n`;
	md += `> Generated ${now} — strategy: \`${strategyName}\`\n\n`;

	// Strategy-specific audit sections
	if (audit) {
		md += audit.reportMarkdown;
	}

	// --- Portfolio section ---
	md += `\n## Portfolio\n\n`;
	md += `| Asset | Value (τ) |\n|---|---|\n`;
	md += `| **Native TAO** | ${formatTao(balances.free)} (reserve: ${formatTao(rebalanceConfig.freeReserveTao)}) |\n`;
	for (const s of balances.stakes) {
		const name = subnetNames.get(s.netuid) ?? `SN${s.netuid}`;
		md += `| SN${s.netuid} ${name} | ${formatTao(s.taoValue)} |\n`;
	}
	md += `| **Total** | **${formatTao(balances.totalTaoValue)}** |\n`;

	// --- Operations section ---
	md += `\n## Planned Operations (${plan.operations.length})\n\n`;
	if (plan.operations.length === 0) {
		md += `Portfolio is balanced — nothing to do.\n`;
	} else {
		md += `| # | Operation | Details | ~Value (τ) |\n|---|---|---|---|\n`;
		for (const [i, op] of plan.operations.entries()) {
			md += `| ${i + 1} | ${formatOpKind(op)} | ${formatOpDetail(op, subnetNames)} | ${formatTao(opEstimatedValue(op))} |\n`;
		}
	}
	if (plan.skipped.length > 0) {
		md += `\n### Skipped\n\n`;
		for (const s of plan.skipped) {
			md += `- SN${s.netuid}: ${s.reason}\n`;
		}
	}

	// Write preview report
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const outPath = `reports/preview-${ts}.md`;
	await mkdir("reports", { recursive: true });
	await writeFile(outPath, md);

	console.log(`\nPreview written to ${outPath}`);
} finally {
	client.destroy();
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function formatOpKind(op: RebalanceOperation): string {
	switch (op.kind) {
		case "swap":
			return "Swap";
		case "unstake":
			return "Unstake";
		case "unstake_partial":
			return "Unstake (partial)";
		case "stake":
			return "Stake";
		case "move":
			return "Move hotkey";
	}
}

function formatOpDetail(
	op: RebalanceOperation,
	names: Map<number, string>,
): string {
	const sn = (netuid: number) =>
		`SN${netuid} ${names.get(netuid) ?? ""}`.trim();
	switch (op.kind) {
		case "swap":
			return `${sn(op.originNetuid)} → ${sn(op.destinationNetuid)}`;
		case "unstake":
		case "unstake_partial":
			return sn(op.netuid);
		case "stake":
			return sn(op.netuid);
		case "move":
			return `${sn(op.netuid)} (${op.originHotkey.slice(0, 8)}… → ${op.destinationHotkey.slice(0, 8)}…)`;
	}
}

function opEstimatedValue(op: RebalanceOperation): bigint {
	switch (op.kind) {
		case "swap":
		case "unstake":
		case "unstake_partial":
			return op.estimatedTaoValue;
		case "stake":
			return op.taoAmount;
		case "move":
			return 0n;
	}
}

function printPortfolio(
	balances: Balances,
	subnetNames: Map<number, string>,
	freeReserveTao: bigint,
): void {
	const reserveStatus =
		balances.free >= freeReserveTao
			? "✅"
			: `⚠️  below reserve (${formatTao(freeReserveTao)})`;
	console.log(`\n${"─".repeat(60)}`);
	console.log("Portfolio");
	console.log("─".repeat(60));
	console.log(`  Native TAO:  ${formatTao(balances.free)} τ  ${reserveStatus}`);
	console.log(`  Reserved:    ${formatTao(balances.reserved)} τ`);
	if (balances.stakes.length > 0) {
		console.log(`  Stakes (${balances.stakes.length}):`);
		const sorted = [...balances.stakes].sort((a, b) =>
			Number(b.taoValue - a.taoValue),
		);
		for (const s of sorted) {
			const name = subnetNames.get(s.netuid) ?? "";
			console.log(
				`    SN${s.netuid.toString().padStart(3)} ${name.padEnd(20).slice(0, 20)}  ${formatTao(s.taoValue).padStart(10)} τ`,
			);
		}
	}
	console.log(`  ${"─".repeat(40)}`);
	console.log(`  Total:       ${formatTao(balances.totalTaoValue)} τ`);
}

function printOperations(
	operations: RebalanceOperation[],
	skipped: Array<{ netuid: number; reason: string }>,
	subnetNames: Map<number, string>,
): void {
	console.log(`\n${"─".repeat(60)}`);
	console.log(`Operations (${operations.length})`);
	console.log("─".repeat(60));
	if (operations.length === 0) {
		console.log("  Portfolio is balanced — nothing to do.");
	} else {
		for (const [i, op] of operations.entries()) {
			const value = opEstimatedValue(op);
			const valueStr = value > 0n ? `~${formatTao(value)} τ` : "";
			console.log(
				`  ${String(i + 1).padStart(2)}. ${formatOpKind(op).padEnd(18)} ${formatOpDetail(op, subnetNames).padEnd(30).slice(0, 30)}  ${valueStr}`,
			);
		}
	}
	if (skipped.length > 0) {
		console.log(`\n  Skipped (${skipped.length}):`);
		for (const s of skipped) {
			console.log(`    SN${s.netuid}: ${s.reason}`);
		}
	}
}

import { dirname, join } from "node:path";
import { bittensor } from "@polkadot-api/descriptors";
import type { PolkadotClient, TypedApi } from "polkadot-api";
import type { Balances } from "../../balances/getBalances.ts";
import type { Env } from "../../config/env.ts";
import { log } from "../../rebalance/logger.ts";
import { formatTao } from "../../rebalance/tao.ts";
import type { StrategyTarget } from "../../rebalance/types.ts";
import { resolveValidators } from "../../validators/index.ts";
import type { AuditSections, StrategyResult } from "../types.ts";
import { loadRootEmissionConfig } from "./config.ts";
import { fetchSubnetData } from "./fetchSubnetData.ts";
import { type SubnetEvaluation, scoreSubnets } from "./scoreSubnets.ts";
import type { RootEmissionStrategyConfig } from "./types.ts";

type Api = TypedApi<typeof bittensor>;

const metaDir = new URL(".", import.meta.url).pathname;
const CONFIG_PATH = metaDir.startsWith("/$bunfs")
	? join(
			dirname(process.execPath),
			"src",
			"strategies",
			"root-emission",
			"config.yaml",
		)
	: new URL("./config.yaml", import.meta.url).pathname;

/**
 * root-emission strategy: allocates a fixed share to root (SN0) and the
 * remainder to the single best emission-yield subnet. Uses only on-chain
 * data — no SN45 API or external indexer required.
 */
export async function getStrategyTargets(
	client: PolkadotClient,
	env: Env,
	balances: Balances,
): Promise<StrategyResult> {
	const api: Api = client.getTypedApi(bittensor);
	const config = loadRootEmissionConfig(CONFIG_PATH);

	const allSubnets = await fetchSubnetData(api);

	// Current block estimate for age calculations
	let currentBlock = 0n;
	for (const s of allSubnets) {
		const estimate = s.networkRegisteredAt + s.blocksSinceLastStep;
		if (estimate > currentBlock) currentBlock = estimate;
	}

	const heldNetuids = new Set(balances.stakes.map((s) => s.netuid));

	const { winner, evaluations } = scoreSubnets(
		allSubnets,
		config.strategy,
		heldNetuids,
		currentBlock,
	);

	const rootShare = config.strategy.rootSharePct / 100;
	const alphaShare = 1 - rootShare;

	log.info(
		`Portfolio: ${formatTao(balances.totalTaoValue)} τ total, ${balances.stakes.length} positions`,
	);

	// Build target netuids: root + best emission subnet (if any)
	const targetNetuids: number[] = [0];
	if (winner) {
		targetNetuids.push(winner.netuid);
		log.info(
			`Best emission subnet: SN${winner.netuid} (${winner.name}) — yield=${formatYieldPct(winner.emissionYield)}, pool=${formatTao(winner.taoIn)} τ`,
		);
	} else {
		log.warn("No alpha subnet qualifies — allocating 100% to root (SN0)");
	}

	// Resolve validators for target subnets
	const { hotkeysByTarget, skipped } = await resolveValidators(
		api,
		balances.stakes,
		targetNetuids,
		env.validatorHotkey,
	);

	// Build targets with shares
	const targets: StrategyTarget[] = [];
	if (hotkeysByTarget.has(0)) {
		targets.push({
			netuid: 0,
			// biome-ignore lint/style/noNonNullAssertion: checked above
			hotkey: hotkeysByTarget.get(0)!,
			share: winner && hotkeysByTarget.has(winner.netuid) ? rootShare : 1,
		});
	}
	if (winner && hotkeysByTarget.has(winner.netuid)) {
		targets.push({
			netuid: winner.netuid,
			// biome-ignore lint/style/noNonNullAssertion: checked above
			hotkey: hotkeysByTarget.get(winner.netuid)!,
			share: hotkeysByTarget.has(0) ? alphaShare : 1,
		});
	}

	log.verbose(
		`Strategy: ${targets.length} targets — root ${(rootShare * 100).toFixed(0)}%, alpha ${(alphaShare * 100).toFixed(0)}%`,
	);
	for (const t of targets) {
		log.verbose(
			`  Target SN${t.netuid}: ${t.hotkey.slice(0, 8)}… (${(t.share * 100).toFixed(1)}%)`,
		);
	}

	return {
		targets,
		skipped,
		rebalanceConfig: config.rebalance,
		audit: buildAuditSections(
			evaluations,
			winner,
			config.strategy,
			heldNetuids,
		),
	};
}

// ---------------------------------------------------------------------------
// Audit rendering (for simulation)
// ---------------------------------------------------------------------------

/** Scale bigint yield (PRECISION-scaled) to a percentage string */
function formatYieldPct(yield_: bigint): string {
	// yield is scaled by 10^18, convert to percentage: yield * 100 / 10^18
	const pct = Number((yield_ * 10000n) / 10n ** 18n) / 100;
	return `${pct.toFixed(2)}%`;
}

function buildAuditSections(
	evaluations: SubnetEvaluation[],
	winner: SubnetEvaluation | null,
	strategyConfig: RootEmissionStrategyConfig,
	heldNetuids: Set<number>,
): AuditSections {
	// --- Terminal lines ---
	const lines: string[] = [];

	const sorted = [...evaluations].sort((a, b) => {
		if (a.passesAllGates !== b.passesAllGates) return a.passesAllGates ? -1 : 1;
		if (b.biasedYield !== a.biasedYield)
			return b.biasedYield > a.biasedYield ? 1 : -1;
		return a.netuid - b.netuid;
	});

	const qualifyCount = evaluations.filter((e) => e.passesAllGates).length;
	lines.push(
		`\nSubnet scoring (${qualifyCount} qualifying / ${evaluations.length} evaluated):\n`,
	);
	lines.push(
		`${"".padStart(4)}${"#".padStart(3)}  ${"SN".padEnd(6)}  ${"Name".padEnd(20)}  ${"Yield".padStart(8)}  ${"Pool (τ)".padStart(10)}  ${"Mcap (τ)".padStart(10)}  ${"Age (d)".padStart(8)}  ${"Status".padStart(8)}`,
	);
	lines.push("─".repeat(85));

	for (const [i, ev] of sorted.entries()) {
		const icon =
			winner && ev.netuid === winner.netuid
				? "🟢"
				: ev.passesAllGates
					? "⚪"
					: "❌";
		const rank = i + 1;
		const nameRaw = ev.name.length > 17 ? `${ev.name.slice(0, 16)}…` : ev.name;
		const name = ev.isHeld ? `${nameRaw} ⭐` : nameRaw;
		const yieldStr = formatYieldPct(ev.biasedYield);
		const pool = formatTao(ev.taoIn);
		const mcap = ev.mcapRao > 0n ? formatTao(ev.mcapRao) : "—";
		const age = String(ev.ageDays);

		const gates = [
			ev.passesPoolGate ? null : "pool",
			ev.passesHealthGate ? null : "health",
			ev.passesAgeGate ? null : "age",
			ev.passesMcapGate ? null : "mcap",
		].filter(Boolean);
		const status = gates.length > 0 ? `fail:${gates.join(",")}` : "pass";

		lines.push(
			`${icon} ${String(rank).padStart(3)}  ${`SN${ev.netuid}`.padEnd(6)}  ${name.padEnd(20)}  ${yieldStr.padStart(8)}  ${pool.padStart(10)}  ${mcap.padStart(10)}  ${age.padStart(8)}  ${status.padStart(8)}`,
		);
	}

	if (evaluations.length === 0) {
		lines.push("  (no subnets to evaluate)");
	}

	if (heldNetuids.size > 0) {
		lines.push(
			`\n⭐ = held subnet (+${strategyConfig.incumbencyBonus}% incumbency bonus)`,
		);
	}

	// --- Markdown report ---
	let md = "";

	md += "## Strategy: root-emission\n\n";
	md += `Root allocation: ${strategyConfig.rootSharePct}% to SN0\n`;
	md += `Alpha allocation: ${100 - strategyConfig.rootSharePct}% to best emission subnet\n\n`;

	md += "## Gate Thresholds\n\n";
	md += "| Gate | Threshold |\n|---|---|\n";
	md += `| Min Pool Depth | ${strategyConfig.minTaoIn} τ |\n`;
	md += `| Min Subnet Age | ${strategyConfig.minSubnetAgeDays} days |\n`;
	md += `| Incumbency Bonus | +${strategyConfig.incumbencyBonus}% |\n`;
	md += "\n";

	md += `## All Subnets (${qualifyCount} qualifying / ${evaluations.length} total)\n\n`;

	const cols = [
		"Rank",
		"SN",
		"Name",
		"Emission Yield",
		"Pool (τ)",
		"Mcap (τ)",
		"Emission (τ)",
		"Age (days)",
		"Pool Gate",
		"Health Gate",
		"Age Gate",
	];
	md += `| ${cols.join(" | ")} |\n`;
	md += `| ${cols.map(() => "---").join(" | ")} |\n`;

	let rank = 1;
	for (const ev of sorted) {
		const rankStr = ev.passesAllGates ? `**${rank++}**` : "—";
		const nameStr = ev.name.length > 18 ? `${ev.name.slice(0, 18)}…` : ev.name;
		const allIcon = ev.passesAllGates ? "✅" : "❌";

		const values = [
			rankStr,
			String(ev.netuid),
			`${allIcon} ${nameStr}${ev.isHeld ? " ⭐" : ""}`,
			formatYieldPct(ev.biasedYield),
			formatTao(ev.taoIn),
			ev.mcapRao > 0n ? formatTao(ev.mcapRao) : "—",
			formatTao(ev.taoInEmission),
			String(ev.ageDays),
			ev.passesPoolGate ? "✅" : "❌",
			ev.passesHealthGate ? "✅" : "❌",
			ev.passesAgeGate ? "✅" : "❌",
		];
		md += `| ${values.join(" | ")} |\n`;
	}

	if (winner) {
		md += `\n**Winner:** SN${winner.netuid} (${winner.name}) — emission yield ${formatYieldPct(winner.emissionYield)}\n`;
	} else {
		md += "\n**No alpha subnet qualifies — 100% to root (SN0)**\n";
	}

	return { terminalLines: lines, reportMarkdown: md };
}

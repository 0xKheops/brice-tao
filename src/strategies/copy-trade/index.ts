import { dirname, join } from "node:path";
import { bittensor } from "@polkadot-api/descriptors";
import type { PolkadotClient, TypedApi } from "polkadot-api";
import type { Balances } from "../../balances/getBalances.ts";
import type { Env } from "../../config/env.ts";
import { ConfigError } from "../../errors.ts";
import { log } from "../../rebalance/logger.ts";
import { formatTao } from "../../rebalance/tao.ts";
import type { StrategyTarget } from "../../rebalance/types.ts";
import { resolveValidators } from "../../validators/index.ts";
import type { AuditSections, StrategyResult } from "../types.ts";
import { loadCopyTradeConfig } from "./config.ts";
import { getLeaderShares, type LeaderShare } from "./getLeaderShares.ts";

type Api = TypedApi<typeof bittensor>;

// In compiled binaries, import.meta.url → /$bunfs/; use process.execPath instead.
const metaDir = new URL(".", import.meta.url).pathname;
const CONFIG_PATH = metaDir.startsWith("/$bunfs")
	? join(
			dirname(process.execPath),
			"src",
			"strategies",
			"copy-trade",
			"config.yaml",
		)
	: new URL("./config.yaml", import.meta.url).pathname;

/**
 * copy-trade strategy: mirrors the leader wallet's subnet allocation.
 * Fetches the leader's on-chain positions, computes proportional shares,
 * and maps them to the follower's portfolio.
 */
export async function getStrategyTargets(
	client: PolkadotClient,
	env: Env,
	balances: Balances,
): Promise<StrategyResult> {
	const api: Api = client.getTypedApi(bittensor);
	const config = loadCopyTradeConfig(CONFIG_PATH, env.leaderAddress);

	if (!config.strategy.leaderAddress) {
		throw new ConfigError(
			"LEADER_ADDRESS is required for the copy-trade strategy",
		);
	}

	let { shares, leaderBalances, filtered } = await getLeaderShares(
		api,
		config.strategy.leaderAddress,
		balances.totalTaoValue,
		config.rebalance.minPositionTao,
	);

	log.info(
		`Leader portfolio: ${formatTao(leaderBalances.totalTaoValue)} τ total, ${leaderBalances.stakes.length} positions`,
	);
	log.info(
		`Follower portfolio: ${formatTao(balances.totalTaoValue)} τ total, ${balances.stakes.length} positions`,
	);

	// All positions filtered as dust — fall back to 100% SN0 to unwind old positions
	if (shares.length === 0 && filtered.length > 0) {
		log.warn(
			"All leader positions filtered as dust — falling back to 100% SN0",
		);
		shares = [{ netuid: 0, share: 1.0 }];
	}

	if (shares.length === 0) {
		log.warn("No leader positions qualify after dust filtering");
		return {
			targets: [],
			skipped: filtered.map((f) => ({ netuid: f.netuid, reason: f.reason })),
			rebalanceConfig: config.rebalance,
		};
	}

	const targetNetuids = shares.map((s) => s.netuid);

	const { hotkeysByTarget, skipped: validatorSkipped } =
		await resolveValidators(
			api,
			balances.stakes,
			targetNetuids,
			env.validatorHotkey,
		);

	// Build targets using leader's proportional shares (not equal-weight)
	const targets: StrategyTarget[] = shares
		.filter((s) => hotkeysByTarget.has(s.netuid))
		.map((s) => ({
			netuid: s.netuid,
			// biome-ignore lint/style/noNonNullAssertion: filtered above
			hotkey: hotkeysByTarget.get(s.netuid)!,
			share: s.share,
		}));

	// Re-normalize shares after validator skips so capital is fully allocated
	const totalShare = targets.reduce((sum, t) => sum + t.share, 0);
	if (totalShare > 0 && totalShare < 1 - 1e-9) {
		for (const t of targets) {
			t.share /= totalShare;
		}
	}

	const allSkipped = [
		...filtered.map((f) => ({ netuid: f.netuid, reason: f.reason })),
		...validatorSkipped,
	];

	log.verbose(`Strategy: ${targets.length} targets from leader allocation`);
	for (const t of targets) {
		log.verbose(
			`  Target SN${t.netuid}: ${t.hotkey.slice(0, 8)}… (${(t.share * 100).toFixed(1)}%)`,
		);
	}

	return {
		targets,
		skipped: allSkipped,
		rebalanceConfig: config.rebalance,
		audit: buildAuditSections(
			shares,
			filtered,
			config.strategy.leaderAddress,
			leaderBalances,
		),
	};
}

// ---------------------------------------------------------------------------
// Audit rendering (for simulation)
// ---------------------------------------------------------------------------

function buildAuditSections(
	shares: LeaderShare[],
	filtered: Array<{ netuid: number; reason: string }>,
	leaderAddress: string,
	leaderBalances: Balances,
): AuditSections {
	// --- Terminal lines ---
	const lines: string[] = [];

	lines.push(`\nLeader: ${leaderAddress}`);
	lines.push(
		`Leader portfolio: ${formatTao(leaderBalances.totalTaoValue)} τ total\n`,
	);
	lines.push(
		`${"".padStart(4)}${"SN".padEnd(6)}  ${"Share".padStart(8)}  ${"Value (τ)".padStart(12)}`,
	);
	lines.push("─".repeat(36));

	for (const s of shares) {
		lines.push(
			`  🟢 ${`SN${s.netuid}`.padEnd(6)}  ${`${(s.share * 100).toFixed(1)}%`.padStart(8)}`,
		);
	}

	if (filtered.length > 0) {
		lines.push("");
		for (const f of filtered) {
			lines.push(`  ⚪ SN${f.netuid}: ${f.reason}`);
		}
	}

	if (shares.length === 0) {
		lines.push("  (no qualifying positions)");
	}

	// --- Markdown report ---
	let md = "";

	md += `## Copy-Trade Leader\n\n`;
	md += `**Leader address:** \`${leaderAddress}\`\n\n`;
	md += `**Leader total value:** ${formatTao(leaderBalances.totalTaoValue)} τ\n\n`;

	md += `## Target Allocation\n\n`;
	md += `| Subnet | Share | Status |\n`;
	md += `| --- | --- | --- |\n`;

	for (const s of shares) {
		md += `| SN${s.netuid} | ${(s.share * 100).toFixed(1)}% | ✅ Active |\n`;
	}

	for (const f of filtered) {
		md += `| SN${f.netuid} | — | ❌ ${f.reason} |\n`;
	}

	return { terminalLines: lines, reportMarkdown: md };
}

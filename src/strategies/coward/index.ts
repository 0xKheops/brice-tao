import { dirname, join } from "node:path";
import { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import type { Balances } from "../../balances/getBalances.ts";
import { log } from "../../rebalance/logger.ts";
import { formatTao } from "../../rebalance/tao.ts";
import type { StrategyTarget } from "../../rebalance/types.ts";
import { getValidatorCandidatesByYield } from "../../validators/pickBestValidator.ts";
import type {
	AuditSections,
	StrategyContext,
	StrategyResult,
} from "../types.ts";
import { loadCowardConfig } from "./config.ts";

type Api = TypedApi<typeof bittensor>;

const metaDir = new URL(".", import.meta.url).pathname;
const CONFIG_PATH = metaDir.startsWith("/$bunfs")
	? join(
			dirname(process.execPath),
			"src",
			"strategies",
			"coward",
			"config.yaml",
		)
	: new URL("./config.yaml", import.meta.url).pathname;

/**
 * coward strategy: consolidates the entire portfolio into SN0 (root network).
 * Picks the best-yielding SN0 validator but only switches if the improvement
 * exceeds the stickiness threshold (avoids unnecessary move_stake churn).
 */
export async function getStrategyTargets({
	client,
	env,
	balances,
}: StrategyContext): Promise<StrategyResult> {
	const api: Api = client.getTypedApi(bittensor);
	const config = loadCowardConfig(CONFIG_PATH);

	const nonRootPositions = balances.stakes.filter((s) => s.netuid !== 0);
	const rootPositions = balances.stakes.filter((s) => s.netuid === 0);

	// Resolve best SN0 validator by yield, with stickiness threshold
	const resolution = await resolveSn0Validator(
		api,
		rootPositions.length > 0
			? rootPositions.sort((a, b) =>
					b.taoValue > a.taoValue ? 1 : b.taoValue < a.taoValue ? -1 : 0,
				)[0]?.hotkey
			: undefined,
		env.validatorHotkey,
	);

	if (!resolution.hotkey) {
		return {
			targets: [],
			skipped: [{ netuid: 0, reason: "No validator available for SN0" }],
			rebalanceConfig: config.rebalance,
			audit: buildAuditSections(balances, nonRootPositions, resolution),
		};
	}

	const targets: StrategyTarget[] = [
		{ netuid: 0, hotkey: resolution.hotkey, share: 1 },
	];

	return {
		targets,
		skipped: [],
		rebalanceConfig: config.rebalance,
		audit: buildAuditSections(balances, nonRootPositions, resolution),
	};
}

// ---------------------------------------------------------------------------
// Validator resolution — stickiness: only switch for ≥1% yield improvement
// ---------------------------------------------------------------------------

/** Minimum relative yield improvement required to switch validators */
const VALIDATOR_SWITCH_THRESHOLD = 0.01;

interface ValidatorResolutionResult {
	hotkey: string | undefined;
	switched: boolean;
	currentYield?: number;
	bestYield?: number;
	bestHotkey?: string;
}

async function resolveSn0Validator(
	api: Api,
	currentHotkey: string | undefined,
	fallbackHotkey: string | undefined,
): Promise<ValidatorResolutionResult> {
	try {
		const candidates = await getValidatorCandidatesByYield(api, 0);
		const best = candidates[0];
		if (!best) {
			throw new Error("No validator candidate selected on SN0");
		}

		// No existing position — use best validator
		if (!currentHotkey) {
			log.verbose(
				`SN0 validator: ${best.hotkey.slice(0, 8)}… (UID ${best.uid}, yield ${formatYield(best.yieldPerAlpha)}) (new)`,
			);
			return {
				hotkey: best.hotkey,
				switched: false,
				bestYield: best.yieldPerAlpha,
				bestHotkey: best.hotkey,
			};
		}

		// Already on the best validator
		if (best.hotkey === currentHotkey) {
			log.verbose(
				`SN0 validator: ${best.hotkey.slice(0, 8)}… (yield ${formatYield(best.yieldPerAlpha)}) (no change, already best)`,
			);
			return {
				hotkey: currentHotkey,
				switched: false,
				currentYield: best.yieldPerAlpha,
				bestYield: best.yieldPerAlpha,
				bestHotkey: best.hotkey,
			};
		}

		// Different best — check stickiness threshold
		const current = candidates.find((c) => c.hotkey === currentHotkey);
		const currentYield = current?.yieldPerAlpha ?? 0;
		const improvement = yieldImprovement(currentYield, best.yieldPerAlpha);

		if (improvement >= VALIDATOR_SWITCH_THRESHOLD) {
			log.info(
				`Validator upgrade: ${currentHotkey.slice(0, 8)}… → ${best.hotkey.slice(0, 8)}… ` +
					`(yield ${formatYield(currentYield)} → ${formatYield(best.yieldPerAlpha)}, +${(improvement * 100).toFixed(2)}% ≥ ${(VALIDATOR_SWITCH_THRESHOLD * 100).toFixed(0)}% threshold)`,
			);
			return {
				hotkey: best.hotkey,
				switched: true,
				currentYield,
				bestYield: best.yieldPerAlpha,
				bestHotkey: best.hotkey,
			};
		}

		log.verbose(
			`SN0 validator: keeping ${currentHotkey.slice(0, 8)}… ` +
				`(yield ${formatYield(currentYield)}, best ${best.hotkey.slice(0, 8)}… at ${formatYield(best.yieldPerAlpha)}, +${(improvement * 100).toFixed(2)}% < ${(VALIDATOR_SWITCH_THRESHOLD * 100).toFixed(0)}% threshold)`,
		);
		return {
			hotkey: currentHotkey,
			switched: false,
			currentYield,
			bestYield: best.yieldPerAlpha,
			bestHotkey: best.hotkey,
		};
	} catch (err) {
		log.warn(
			`Yield-based validator selection failed for SN0: ${err instanceof Error ? err.message : err}`,
		);

		if (currentHotkey) {
			log.info(`Keeping current SN0 validator: ${currentHotkey.slice(0, 8)}…`);
			return { hotkey: currentHotkey, switched: false };
		}

		if (fallbackHotkey) {
			log.warn(
				`Falling back to VALIDATOR_HOTKEY for SN0: ${fallbackHotkey.slice(0, 8)}…`,
			);
			return { hotkey: fallbackHotkey, switched: false };
		}

		return { hotkey: undefined, switched: false };
	}
}

/** Relative yield improvement: (new - old) / old. Returns 0 if old is 0. */
function yieldImprovement(oldYield: number, newYield: number): number {
	if (oldYield <= 0) return newYield > 0 ? 1 : 0;
	return (newYield - oldYield) / oldYield;
}

function formatYield(yieldPerAlpha: number): string {
	return `${(yieldPerAlpha * 100).toFixed(4)}%`;
}

// ---------------------------------------------------------------------------
// Audit rendering
// ---------------------------------------------------------------------------

function buildAuditSections(
	balances: Balances,
	nonRootPositions: Balances["stakes"],
	resolution: ValidatorResolutionResult,
): AuditSections {
	const lines: string[] = [];

	lines.push("\nCoward Strategy: 100% allocation to SN0 (root network)\n");
	lines.push(`Portfolio: ${formatTao(balances.totalTaoValue)} τ total`);
	lines.push(`Free balance: ${formatTao(balances.free)} τ`);

	if (nonRootPositions.length > 0) {
		const totalAlpha = nonRootPositions.reduce(
			(sum, s) => sum + s.taoValue,
			0n,
		);
		lines.push(
			`Positions to liquidate: ${nonRootPositions.length} (${formatTao(totalAlpha)} τ)`,
		);
		for (const pos of nonRootPositions) {
			lines.push(
				`  SN${pos.netuid}: ${formatTao(pos.taoValue)} τ (${pos.hotkey.slice(0, 8)}…)`,
			);
		}
	} else {
		lines.push("No non-root positions to liquidate");
	}

	if (resolution.hotkey) {
		const switchLabel = resolution.switched ? " (switching)" : "";
		lines.push(
			`\nSN0 validator: ${resolution.hotkey.slice(0, 8)}…${switchLabel}`,
		);
		if (resolution.currentYield !== undefined && resolution.bestHotkey) {
			const improvement = yieldImprovement(
				resolution.currentYield,
				resolution.bestYield ?? 0,
			);
			lines.push(
				`  Current yield: ${formatYield(resolution.currentYield)}, ` +
					`best: ${formatYield(resolution.bestYield ?? 0)} (${resolution.bestHotkey.slice(0, 8)}…), ` +
					`Δ ${(improvement * 100).toFixed(2)}% (threshold: ${(VALIDATOR_SWITCH_THRESHOLD * 100).toFixed(0)}%)`,
			);
		}
	}

	let md = "## Strategy: coward\n\n";
	md += "100% allocation to SN0 (root network).\n\n";
	md += `| Metric | Value |\n|---|---|\n`;
	md += `| Total portfolio | ${formatTao(balances.totalTaoValue)} τ |\n`;
	md += `| Free balance | ${formatTao(balances.free)} τ |\n`;
	md += `| Non-root positions | ${nonRootPositions.length} |\n`;
	if (resolution.hotkey) {
		md += `| SN0 validator | \`${resolution.hotkey.slice(0, 8)}…\`${resolution.switched ? " (**switching**)" : ""} |\n`;
	}
	if (
		resolution.currentYield !== undefined &&
		resolution.bestYield !== undefined
	) {
		const improvement = yieldImprovement(
			resolution.currentYield,
			resolution.bestYield,
		);
		md += `| Current yield | ${formatYield(resolution.currentYield)} |\n`;
		md += `| Best yield | ${formatYield(resolution.bestYield)} |\n`;
		md += `| Yield Δ | ${(improvement * 100).toFixed(2)}% (threshold: ${(VALIDATOR_SWITCH_THRESHOLD * 100).toFixed(0)}%) |\n`;
	}

	return { terminalLines: lines, reportMarkdown: md };
}

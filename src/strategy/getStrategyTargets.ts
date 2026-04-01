import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import type { Balances } from "../balances/getBalances.ts";
import type { AppConfig } from "../config/types.ts";
import type { Sn45Api } from "../external-apis/generated/Sn45Api.ts";
import { log } from "../rebalance/logger.ts";
import { formatTao } from "../rebalance/tao.ts";
import type { StrategyTarget } from "../rebalance/types.ts";
import { fetchAllSubnets } from "./fetchAllSubnets.ts";
import { getBestSubnets } from "./getBestSubnets.ts";
import { getHealthySubnets } from "./getHealthySubnets.ts";
import { resolveValidators } from "./resolveValidators.ts";

type Api = TypedApi<typeof bittensor>;

interface GetStrategyTargetsOptions {
	fallbackValidatorHotkey?: string;
}

export interface GetStrategyTargetsResult {
	targets: StrategyTarget[];
	skipped: Array<{ netuid: number; reason: string }>;
}

/**
 * Single entry point for the strategy layer: fetches on-chain subnet data,
 * evaluates health and quality gates, determines which subnets to target,
 * resolves validators, and assigns portfolio shares.
 *
 * Returns fully-resolved targets ready for the rebalance layer.
 */
export async function getStrategyTargets(
	api: Api,
	sn45: Sn45Api<unknown>,
	balances: Balances,
	config: AppConfig,
	options?: GetStrategyTargetsOptions,
): Promise<GetStrategyTargetsResult> {
	const allSubnets = await fetchAllSubnets(api);
	const healthyNetuids = getHealthySubnets(allSubnets);
	const subnetNames = new Map(allSubnets.map((s) => [s.netuid, s.name]));

	const pruneTarget = allSubnets.find((s) => s.isPruneTarget);
	log.verbose(
		`Subnet health: ${healthyNetuids.size} healthy out of ${allSubnets.length} total${pruneTarget ? ` (SN${pruneTarget.netuid} next to prune)` : ""}`,
	);
	for (const h of allSubnets) {
		const healthy = healthyNetuids.has(h.netuid) ? "✓" : "✗";
		const flags = [
			h.isImmune ? "immune" : null,
			h.isPruneTarget ? "PRUNE_RISK" : null,
		]
			.filter(Boolean)
			.join(",");
		log.verbose(
			`  SN${h.netuid.toString().padStart(3)} [${healthy}] emission=${h.taoInEmission} volume=${h.subnetVolume}${flags ? ` [${flags}]` : ""}`,
		);
	}

	const heldNetuids = new Set(balances.stakes.map((s) => s.netuid));

	const { winners: eligible } = await getBestSubnets(
		sn45,
		config.strategy,
		healthyNetuids,
		log,
		subnetNames,
		heldNetuids,
	);

	log.info(
		`Portfolio: ${formatTao(balances.totalTaoValue)} τ total, ${balances.stakes.length} positions, ${eligible.length} eligible subnets`,
	);

	// Compute effective target count: min(maxSubnets, portfolioCapacity, eligibleCount)
	const available = balances.totalTaoValue - config.rebalance.freeReserveTao;
	if (available <= 0n) {
		log.warn("Portfolio too small to rebalance (below free reserve)");
		return { targets: [], skipped: [] };
	}

	const x = Math.min(
		config.strategy.maxSubnets,
		Math.max(
			Number(balances.totalTaoValue / config.rebalance.minPositionTao),
			1,
		),
		Math.max(eligible.length, 1),
	);

	if (x < 1) {
		log.warn("Not enough TAO for even one position");
		return { targets: [], skipped: [] };
	}

	// Select target netuids — pad with netuid 0 if fewer eligible than x
	const targetNetuids = eligible.slice(0, x).map((s) => s.netuid);
	while (targetNetuids.length < x) {
		if (!targetNetuids.includes(0)) {
			targetNetuids.push(0);
		} else {
			break;
		}
	}

	// Resolve validators for target subnets
	const { hotkeysByTarget, skipped } = await resolveValidators(
		api,
		balances.stakes,
		targetNetuids,
		options?.fallbackValidatorHotkey,
	);

	// Assign equal-weight shares
	const share = 1 / targetNetuids.length;
	const targets: StrategyTarget[] = targetNetuids
		.filter((netuid) => hotkeysByTarget.has(netuid))
		.map((netuid) => ({
			netuid,
			// biome-ignore lint/style/noNonNullAssertion: filtered above
			hotkey: hotkeysByTarget.get(netuid)!,
			share,
		}));

	log.verbose(
		`Strategy: ${targets.length} targets, ${(share * 100).toFixed(1)}% each`,
	);
	for (const t of targets) {
		log.verbose(`  Target SN${t.netuid}: ${t.hotkey.slice(0, 8)}…`);
	}

	return { targets, skipped };
}

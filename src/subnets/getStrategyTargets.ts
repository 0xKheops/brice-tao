import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import type { Sn45Api } from "../api/generated/Sn45Api.ts";
import type { Balances } from "../balances/getBalances.ts";
import type { AppConfig } from "../config/types.ts";
import { log } from "../rebalance/logger.ts";
import { TAO } from "../rebalance/tao.ts";
import type { StrategyTarget } from "../rebalance/types.ts";
import { getBestSubnets } from "./getBestSubnets.ts";
import { resolveValidators } from "./resolveValidators.ts";

type Api = TypedApi<typeof bittensor>;

interface GetStrategyTargetsOptions {
	subnetNames?: Map<number, string>;
	fallbackValidatorHotkey?: string;
}

export interface GetStrategyTargetsResult {
	targets: StrategyTarget[];
	skipped: Array<{ netuid: number; reason: string }>;
}

/**
 * Single entry point for the strategy layer: determines which subnets
 * to target, which validators to use, and what share of the portfolio
 * each target gets.
 *
 * Returns fully-resolved targets ready for the rebalance layer.
 */
export async function getStrategyTargets(
	api: Api,
	sn45: Sn45Api<unknown>,
	balances: Balances,
	config: AppConfig,
	healthyNetuids: Set<number>,
	options?: GetStrategyTargetsOptions,
): Promise<GetStrategyTargetsResult> {
	const heldNetuids = new Set(balances.stakes.map((s) => s.netuid));

	const { winners: eligible } = await getBestSubnets(
		sn45,
		config.strategy,
		healthyNetuids,
		log,
		options?.subnetNames,
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

function formatTao(rao: bigint): string {
	const whole = rao / TAO;
	const frac = ((rao % TAO) * 1000n) / TAO;
	return `${whole}.${frac.toString().padStart(3, "0")}`;
}

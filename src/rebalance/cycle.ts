import { deriveSigner } from "../accounts/deriveSigner.ts";
import type { BittensorClient } from "../api/createClient.ts";
import { getBalances } from "../balances/getBalances.ts";
import type { Env } from "../config/env.ts";
import { MevShieldError, RebalanceError, SlippageError } from "../errors.ts";
import {
	sendErrorNotification,
	sendRebalanceNotification,
} from "../notifications/discord.ts";
import type { RebalanceCycleResult } from "../scheduling/types.ts";
import type { StrategyFn } from "../strategies/types.ts";
import { computeRebalance } from "./computeRebalance.ts";
import { executeRebalancePlan } from "./executeRebalancePlan.ts";
import { initLog, log, logBalancesDetail } from "./logger.ts";
import { getNextKey } from "./mevShield.ts";

export interface CycleOptions {
	dryRun: boolean;
}

/**
 * Execute a full rebalance cycle: fetch balances → compute targets → execute → notify.
 *
 * Extracted from main.ts so both the scheduler runner and the one-shot CLI
 * can share the same pipeline.
 */
export async function executeRebalanceCycle(
	{ client, api }: BittensorClient,
	env: Env,
	getStrategyTargets: StrategyFn,
	{ dryRun }: CycleOptions,
): Promise<RebalanceCycleResult> {
	initLog({ dryRun });

	const { signer, address: proxyAddress } = deriveSigner(env.proxyMnemonic);
	const startedAt = performance.now();

	try {
		if (dryRun) log.info("[DRY RUN] Will not submit transaction.\n");

		// 1. Fetch current state
		log.info("Fetching balances...");
		const [balances, proxyAccount] = await Promise.all([
			getBalances(api, env.coldkey),
			api.query.System.Account.getValue(proxyAddress),
		]);
		const proxyFreeBalance = proxyAccount.data.free;
		logBalancesDetail("BEFORE", env.coldkey, balances);

		// 2. Ask strategy for targets and shares
		log.info("Computing strategy targets...");
		const {
			targets,
			skipped: strategySkips,
			rebalanceConfig,
			audit,
		} = await getStrategyTargets(client, env, balances);

		// Surface strategy audit in dry-run mode for richer operator feedback
		if (dryRun && audit) {
			for (const line of audit.terminalLines) {
				log.info(line);
			}
		}

		// 3. Determine MEV shield state (single query, threaded through entire flow)
		const mevKey = await getNextKey(api);
		const useLimits = rebalanceConfig.enforceSlippage || !mevKey;

		// 4. Ask rebalance module for a plan
		const plan = computeRebalance(balances, targets, rebalanceConfig, {
			useLimits,
		});
		plan.skipped.push(...strategySkips);

		if (plan.operations.length === 0) {
			log.info("Portfolio is balanced — nothing to do.");
		} else {
			// 5. Execute the rebalancing plan
			const { batchResult, balancesAfter, proxyFreeBalanceAfter } =
				await executeRebalancePlan({
					client,
					api,
					signer,
					coldkey: env.coldkey,
					proxyAddress,
					plan,
					balances,
					proxyFreeBalance,
					rebalanceConfig,
					dryRun,
					mevKey,
				});

			// 6. Report
			if (!dryRun && env.discordWebhookUrl) {
				await sendRebalanceNotification(env.discordWebhookUrl, {
					plan,
					balancesBefore: balances,
					balancesAfter,
					proxyFreeBalanceBefore: proxyFreeBalance,
					proxyFreeBalanceAfter,
					batchResult,
					durationMs: performance.now() - startedAt,
					coldkeyAddress: env.coldkey,
				});
			}
		}

		log.info(`Log file: ${log.filePath()}`);
		return { exitCode: 0 };
	} catch (err) {
		const errorLabel =
			err instanceof SlippageError
				? `Slippage error on SN${err.netuid}`
				: err instanceof MevShieldError
					? "MEV Shield error"
					: err instanceof RebalanceError
						? `${err.name} [${err.code}]`
						: "Rebalance failed";

		log.error(errorLabel, err);
		if (!dryRun && env.discordWebhookUrl) {
			await sendErrorNotification(
				env.discordWebhookUrl,
				err,
				performance.now() - startedAt,
			).catch((e) => log.error("Failed to send Discord error notification", e));
		}
		return { exitCode: 1 };
	}
}

import { deriveSigner } from "../accounts/deriveSigner.ts";
import type { BittensorClient } from "../api/createClient.ts";
import { getBalances } from "../balances/getBalances.ts";
import type { Env } from "../config/env.ts";
import { MevShieldError, RebalanceError, SlippageError } from "../errors.ts";
import type { HistoryDatabase } from "../history/db.ts";
import type { CycleRecord } from "../history/types.ts";
import {
	sendErrorNotification,
	sendRebalanceNotification,
} from "../notifications/discord.ts";
import type { RebalanceCycleResult } from "../scheduling/types.ts";
import type { StrategyFn } from "../strategies/types.ts";
import { GIT_COMMIT } from "../version.ts";
import { computeRebalance } from "./computeRebalance.ts";
import { executeRebalancePlan } from "./executeRebalancePlan.ts";
import { initLog, log, logBalancesDetail } from "./logger.ts";
import { getNextKey } from "./mevShield.ts";
import { buildTradeRecords } from "./tradeRecorder.ts";

/** Caller-provided cycle options (strategy name and historyDb are added by buildRunnerContext) */
export interface CycleCallerOptions {
	dryRun: boolean;
}

/** Full cycle options including tracking context — used internally by executeRebalanceCycle */
export interface CycleOptions extends CycleCallerOptions {
	strategyName: string;
	historyDb: HistoryDatabase;
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
	{ dryRun, strategyName, historyDb }: CycleOptions,
): Promise<RebalanceCycleResult> {
	initLog({ dryRun });

	const { signer, address: proxyAddress } = deriveSigner(env.proxyMnemonic);
	const startedAt = performance.now();
	const cycleTimestamp = Date.now();

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
			recordCycleToDb(historyDb, {
				strategy: strategyName,
				gitCommit: GIT_COMMIT,
				blockNumber: null,
				txHash: null,
				timestamp: cycleTimestamp,
				status: "no_ops",
				totalBefore: balances.totalTaoValue,
				totalAfter: balances.totalTaoValue,
				feeInner: 0n,
				feeWrapper: 0n,
				opsTotal: 0,
				opsSucceeded: 0,
				dryRun,
			});
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

			// 5b. Record cycle + trades to history DB
			const opsSucceeded =
				batchResult?.status !== "timeout"
					? (batchResult?.operationResults.filter((r) => r.success).length ?? 0)
					: 0;
			const cycleRecord: CycleRecord = {
				strategy: strategyName,
				gitCommit: GIT_COMMIT,
				blockNumber:
					batchResult && "blockNumber" in batchResult
						? batchResult.blockNumber
						: null,
				txHash: batchResult?.innerTxHash ?? null,
				timestamp: cycleTimestamp,
				status: batchResult?.status ?? "error",
				totalBefore: balances.totalTaoValue,
				totalAfter: balancesAfter.totalTaoValue,
				feeInner:
					batchResult && "innerBatchFee" in batchResult
						? batchResult.innerBatchFee
						: 0n,
				feeWrapper: batchResult?.wrapperFee ?? 0n,
				opsTotal: plan.operations.length,
				opsSucceeded,
				dryRun,
			};
			const trades = buildTradeRecords(
				0, // placeholder — replaced by actual ID below
				plan,
				balances,
				balancesAfter,
				batchResult,
			);
			recordCycleToDb(historyDb, cycleRecord, trades);

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
		recordCycleToDb(historyDb, {
			strategy: strategyName,
			gitCommit: GIT_COMMIT,
			blockNumber: null,
			txHash: null,
			timestamp: cycleTimestamp,
			status: "error",
			totalBefore: 0n,
			totalAfter: 0n,
			feeInner: 0n,
			feeWrapper: 0n,
			opsTotal: 0,
			opsSucceeded: 0,
			dryRun,
		});
		return { exitCode: 1 };
	}
}

/**
 * Persist cycle + trades to the history DB. Never throws — recording
 * failures are logged but don't break the rebalance pipeline.
 */
function recordCycleToDb(
	historyDb: HistoryDatabase,
	cycle: CycleRecord,
	trades?: import("../history/types.ts").TradeRecord[],
): void {
	try {
		const cycleId = historyDb.recordCycle(cycle);
		if (trades && trades.length > 0) {
			const withId = trades.map((t) => ({ ...t, cycleId }));
			historyDb.recordTrades(withId);
		}
	} catch (err) {
		log.warn(
			`Failed to record cycle to history DB: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

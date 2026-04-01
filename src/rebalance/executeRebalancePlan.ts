import type { bittensor } from "@polkadot-api/descriptors";
import type { PolkadotClient, PolkadotSigner, TypedApi } from "polkadot-api";
import type { Balances } from "../balances/getBalances.ts";
import { getBalances } from "../balances/getBalances.ts";
import type { AppConfig } from "../config/types.ts";
import { executeRebalance } from "./executeRebalance.ts";
import { log, logBalancesDetail } from "./logger.ts";
import { simulateAllOperations } from "./simulateSlippage.ts";
import { formatTao } from "./tao.ts";
import type { BatchResult, RebalancePlan } from "./types.ts";

type Api = TypedApi<typeof bittensor>;

export interface ExecutePlanParams {
	client: PolkadotClient;
	api: Api;
	signer: PolkadotSigner;
	coldkey: string;
	proxyAddress: string;
	plan: RebalancePlan;
	balances: Balances;
	proxyFreeBalance: bigint;
	rebalanceConfig: AppConfig["rebalance"];
	dryRun: boolean;
}

export interface ExecutePlanResult {
	batchResult: BatchResult | null;
	balancesAfter: Balances;
	proxyFreeBalanceAfter: bigint;
}

/**
 * Execute a rebalance plan end-to-end: log the plan summary, simulate
 * slippage for limit prices, submit the MEV-shielded batch, and fetch
 * post-rebalance balances.
 *
 * Returns the batch result and post-rebalance state for reporting.
 */
export async function executeRebalancePlan(
	params: ExecutePlanParams,
): Promise<ExecutePlanResult> {
	const {
		client,
		api,
		signer,
		coldkey,
		proxyAddress,
		plan,
		balances,
		proxyFreeBalance,
		rebalanceConfig,
		dryRun,
	} = params;

	log.info(
		`Plan: ${plan.operations.length} operations across ${plan.targets.length} target subnets`,
	);
	for (const skip of plan.skipped) {
		log.verbose(`  Skipped SN${skip.netuid}: ${skip.reason}`);
	}

	// Simulate all operations to compute accurate limit prices
	log.info("Simulating operations for limit prices...");
	plan.operations = await simulateAllOperations(
		api,
		plan.operations,
		rebalanceConfig,
	);

	const batchResult = await executeRebalance(
		client,
		api,
		signer,
		coldkey,
		plan,
		{
			dryRun,
		},
	);

	// Fetch post-rebalance balances (or reuse current for dry-run)
	const [balancesAfter, proxyFreeBalanceAfter] = dryRun
		? [balances, proxyFreeBalance]
		: await (async () => {
				log.info("Fetching post-rebalance balances...");
				const [b, proxyAccount] = await Promise.all([
					getBalances(api, coldkey),
					api.query.System.Account.getValue(proxyAddress),
				]);
				log.info(
					`Portfolio after: ${formatTao(b.totalTaoValue)} τ total, ${b.stakes.length} positions`,
				);
				logBalancesDetail("AFTER", coldkey, b);
				return [b, proxyAccount.data.free] as const;
			})();

	return { batchResult, balancesAfter, proxyFreeBalanceAfter };
}

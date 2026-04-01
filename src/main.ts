import { join } from "node:path";
import { deriveSigner } from "./accounts/deriveSigner.ts";
import { createBittensorClient } from "./api/createClient.ts";
import { getBalances } from "./balances/getBalances.ts";
import { loadEnv } from "./config/env.ts";
import { loadConfig } from "./config/loadConfig.ts";
import { MevShieldError, RebalanceError, SlippageError } from "./errors.ts";
import { Sn45Api } from "./external-apis/generated/Sn45Api.ts";
import {
	sendErrorNotification,
	sendRebalanceNotification,
} from "./notifications/discord.ts";
import { computeRebalance } from "./rebalance/computeRebalance.ts";
import { executeRebalancePlan } from "./rebalance/executeRebalancePlan.ts";
import { initLog, log, logBalancesDetail } from "./rebalance/logger.ts";
import { getStrategyTargets } from "./strategy/getStrategyTargets.ts";

// --- CLI arguments ---
const dryRun = process.argv.includes("--dry-run");
initLog({ dryRun });

// --- Load configuration & environment ---
const configPath = join(process.cwd(), "src", "config.yaml");
const config = loadConfig(configPath);
const env = loadEnv();

// --- Create signer from proxy mnemonic ---
const { signer, address: proxyAddress } = deriveSigner(env.proxyMnemonic);

// --- Connect to chain ---
const { client, api } = createBittensorClient(env.wsEndpoints);
const sn45 = new Sn45Api({
	baseUrl: "https://sn45api.talisman.xyz",
	baseApiParams: { headers: { "X-API-Key": env.sn45ApiKey } },
});

const startedAt = performance.now();
let exitCode = 0;

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
	const { targets, skipped: strategySkips } = await getStrategyTargets(
		api,
		sn45,
		balances,
		config,
		{ fallbackValidatorHotkey: env.validatorHotkey },
	);

	// 3. Ask rebalance module for a plan
	const plan = computeRebalance(balances, targets, config.rebalance);
	plan.skipped.push(...strategySkips);

	if (plan.operations.length === 0) {
		log.info("Portfolio is balanced — nothing to do.");
	} else {
		// 4. Execute the rebalancing plan
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
				rebalanceConfig: config.rebalance,
				dryRun,
			});

		// 5. Report
		if (!dryRun) {
			await sendRebalanceNotification(env.discordWebhookUrl, {
				plan,
				balancesBefore: balances,
				balancesAfter,
				proxyFreeBalanceBefore: proxyFreeBalance,
				proxyFreeBalanceAfter,
				batchResult,
				durationMs: performance.now() - startedAt,
			});
		}
	}

	log.info(`Log file: ${log.filePath()}`);
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
	if (!dryRun) {
		await sendErrorNotification(
			env.discordWebhookUrl,
			err,
			performance.now() - startedAt,
		).catch((e) => log.error("Failed to send Discord error notification", e));
	}
	exitCode = 1;
} finally {
	client.destroy();
	process.exit(exitCode);
}

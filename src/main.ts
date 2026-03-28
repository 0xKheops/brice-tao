import { join } from "node:path";
import {
	bittensor,
	getMetadata as getDescriptorsMetadata,
} from "@polkadot-api/descriptors";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
	entropyToMiniSecret,
	mnemonicToEntropy,
	ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { createWsClient } from "polkadot-api/ws";
import { Sn45Api } from "./api/generated/Sn45Api.ts";
import type { Balances } from "./balances/getBalances.ts";
import { getBalances } from "./balances/getBalances.ts";
import { loadConfig } from "./config/loadConfig.ts";
import { MevShieldError, RebalanceError, SlippageError } from "./errors.ts";
import {
	sendErrorNotification,
	sendRebalanceNotification,
} from "./notifications/discord.ts";
import { computeRebalance } from "./rebalance/computeRebalance.ts";
import { executeRebalance } from "./rebalance/executeRebalance.ts";
import { initLog, log } from "./rebalance/logger.ts";
import { simulateAllOperations } from "./rebalance/simulateSlippage.ts";
import { TAO } from "./rebalance/tao.ts";
import { fetchAllSubnets } from "./subnets/fetchAllSubnets.ts";
import { getBestSubnets } from "./subnets/getBestSubnets.ts";
import { getHealthySubnets } from "./subnets/getHealthySubnets.ts";

// --- CLI arguments ---
const dryRun = process.argv.includes("--dry-run");
initLog({ dryRun });

// --- Load configuration ---
const configPath = join(process.cwd(), "src", "config.yaml");
const config = loadConfig(configPath);

// --- Environment validation ---
const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const coldkey = process.env.COLDKEY_ADDRESS;
const sn45ApiKey = process.env.SN45_API_KEY;
const proxyMnemonic = process.env.PROXY_MNEMONIC;
const validatorHotkey = process.env.VALIDATOR_HOTKEY;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!coldkey) throw new Error("COLDKEY_ADDRESS is not set");
if (!sn45ApiKey) throw new Error("SN45_API_KEY is not set");
if (!proxyMnemonic) throw new Error("PROXY_MNEMONIC is not set");
if (!discordWebhookUrl) throw new Error("DISCORD_WEBHOOK_URL is not set");

// --- Create signer from proxy mnemonic ---
const miniSecret = entropyToMiniSecret(mnemonicToEntropy(proxyMnemonic));
const derive = sr25519CreateDerive(miniSecret);
const keyPair = derive("");
const signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);
const proxyAddress = ss58Address(keyPair.publicKey, 42);

// --- Metadata caching (avoids re-downloading metadata on every run) ---
const CACHE_DIR = ".papi/cache";
await Bun.write(Bun.file(`${CACHE_DIR}/.gitkeep`), "");

const setMetadata = (codeHash: string, value: Uint8Array) => {
	Bun.write(Bun.file(`${CACHE_DIR}/${codeHash}.bin`), value);
};

const getMetadata = async (codeHash: string) => {
	const file = Bun.file(`${CACHE_DIR}/${codeHash}.bin`);
	if (await file.exists()) return new Uint8Array(await file.arrayBuffer());

	const metadata = await getDescriptorsMetadata(codeHash);
	if (metadata) setMetadata(codeHash, metadata);
	return metadata;
};

// --- Connect to chain ---
const client = createWsClient(wsEndpoints, { getMetadata, setMetadata });
const sn45 = new Sn45Api({
	baseUrl: "https://sn45api.talisman.xyz",
	baseApiParams: { headers: { "X-API-Key": sn45ApiKey } },
});

const startedAt = performance.now();
let exitCode = 0;

try {
	const api = client.getTypedApi(bittensor);

	if (dryRun) log.info("[DRY RUN] Will not submit transaction.\n");

	log.info("Fetching balances, subnet health, and eligible subnets...");
	const [balances, allSubnets, proxyAccount] = await Promise.all([
		getBalances(api, coldkey),
		fetchAllSubnets(api),
		api.query.System.Account.getValue(proxyAddress),
	]);
	const healthyNetuids = getHealthySubnets(
		allSubnets,
		BigInt(config.health.minPoolTao) * TAO,
	);
	const proxyFreeBalance = proxyAccount.data.free;

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
			`  SN${h.netuid.toString().padStart(3)} [${healthy}] emission=${h.taoInEmission} tao_in=${h.taoIn} volume=${h.subnetVolume}${flags ? ` [${flags}]` : ""}`,
		);
	}

	const subnetNames = new Map(allSubnets.map((s) => [s.netuid, s.name]));
	const heldNetuids = new Set(balances.stakes.map((s) => s.netuid));
	const immuneNetuids = new Set(
		allSubnets.filter((s) => s.isImmune).map((s) => s.netuid),
	);
	const { winners: eligible } = await getBestSubnets(
		sn45,
		config.strategy,
		healthyNetuids,
		log,
		subnetNames,
		heldNetuids,
		immuneNetuids,
		config.rebalance.incumbencyBonus,
	);

	log.info(
		`Portfolio: ${formatTao(balances.totalTaoValue)} τ total, ${balances.stakes.length} positions, ${eligible.length} eligible subnets`,
	);
	logBalancesDetail("BEFORE", coldkey, balances);

	const plan = await computeRebalance(
		api,
		balances,
		eligible,
		config.rebalance,
		validatorHotkey,
	);

	if (plan.operations.length === 0) {
		log.info("Portfolio is balanced — nothing to do.");
	} else {
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
			config.rebalance,
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

		// Fetch post-rebalance balances and proxy balance (or reuse current for dry-run)
		const [postBalances, postProxyFreeBalance] = dryRun
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

		if (!dryRun) {
			await sendRebalanceNotification(discordWebhookUrl, {
				plan,
				balancesBefore: balances,
				balancesAfter: postBalances,
				proxyFreeBalanceBefore: proxyFreeBalance,
				proxyFreeBalanceAfter: postProxyFreeBalance,
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
			discordWebhookUrl,
			err,
			performance.now() - startedAt,
		).catch((e) => log.error("Failed to send Discord error notification", e));
	}
	exitCode = 1;
} finally {
	client.destroy();
	process.exit(exitCode);
}

function formatTao(rao: bigint): string {
	const whole = rao / TAO;
	const frac = ((rao % TAO) * 1000n) / TAO;
	return `${whole}.${frac.toString().padStart(3, "0")}`;
}

function logBalancesDetail(
	label: string,
	address: string,
	balances: Balances,
): void {
	log.verbose(`=== Balances ${label} (${address}) ===`);
	log.verbose(`  Free:      ${formatTao(balances.free)} τ`);
	log.verbose(`  Reserved:  ${formatTao(balances.reserved)} τ`);
	log.verbose(`  Stakes (${balances.stakes.length}):`);
	for (const s of balances.stakes) {
		log.verbose(
			`    SN${s.netuid.toString().padStart(3)} | hotkey=${s.hotkey} | alpha=${s.stake} | price=${s.alphaPrice} | ~${formatTao(s.taoValue)} τ`,
		);
	}
	const stakesTotal = balances.stakes.reduce((sum, s) => sum + s.taoValue, 0n);
	log.verbose(`  Stakes total: ${formatTao(stakesTotal)} τ`);
	log.verbose(`  Total value:  ${formatTao(balances.totalTaoValue)} τ`);
	log.verbose(`=== End ${label} ===`);
}

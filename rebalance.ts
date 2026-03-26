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
import { Sn45Api } from "./src/api/generated/Sn45Api.ts";
import {
	sendErrorNotification,
	sendNoRebalanceNotification,
	sendRebalanceNotification,
} from "./src/discord.ts";
import type { Balances } from "./src/getBalances.ts";
import { getBalances } from "./src/getBalances.ts";
import { getHealthySubnets } from "./src/getSubnetHealth.ts";
import { pickBestSubnets } from "./src/pickBestSubnets.ts";
import { computeRebalance } from "./src/rebalance/computeRebalance.ts";
import { executeRebalance } from "./src/rebalance/executeRebalance.ts";
import { initLog, log } from "./src/rebalance/logger.ts";
import { simulateAllOperations } from "./src/rebalance/simulateSlippage.ts";
import { TAO } from "./src/rebalance/tao.ts";

// --- CLI arguments ---
const dryRun = process.argv.includes("--dry-run");
initLog({ dryRun });

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

try {
	const api = client.getTypedApi(bittensor);

	if (dryRun) log.info("[DRY RUN] Will not submit transaction.\n");

	log.info("Fetching balances, subnet health, and profitable subnets...");
	const [balances, { healthyNetuids, allHealth, subnetNames }, proxyAccount] =
		await Promise.all([
			getBalances(api, coldkey),
			getHealthySubnets(api),
			api.query.System.Account.getValue(proxyAddress),
		]);
	const proxyFreeBalance = proxyAccount.data.free;

	log.verbose(
		`Subnet health: ${healthyNetuids.size} healthy out of ${allHealth.length} total`,
	);
	for (const h of allHealth) {
		const healthy = healthyNetuids.has(h.netuid) ? "✓" : "✗";
		log.verbose(
			`  SN${h.netuid.toString().padStart(3)} [${healthy}] emission=${h.taoInEmission} tao_in=${h.taoIn} volume=${h.subnetVolume}`,
		);
	}

	const profitable = await pickBestSubnets(
		sn45,
		undefined,
		healthyNetuids,
		log,
		subnetNames,
	);

	log.info(
		`Portfolio: ${formatTao(balances.totalTaoValue)} τ total, ${balances.stakes.length} positions, ${profitable.length} profitable subnets`,
	);
	logBalancesDetail("BEFORE", coldkey, balances);

	const plan = await computeRebalance(
		api,
		balances,
		profitable,
		validatorHotkey,
	);

	if (plan.operations.length === 0) {
		log.info("Portfolio is balanced — nothing to do.");
		if (!dryRun) {
			await sendNoRebalanceNotification(
				discordWebhookUrl,
				balances,
				proxyFreeBalance,
				performance.now() - startedAt,
			);
		}
	} else {
		log.info(
			`Plan: ${plan.operations.length} operations across ${plan.targets.length} target subnets`,
		);
		for (const skip of plan.skipped) {
			log.verbose(`  Skipped SN${skip.netuid}: ${skip.reason}`);
		}

		// Simulate all operations to compute accurate limit prices
		log.info("Simulating operations for limit prices...");
		plan.operations = await simulateAllOperations(api, plan.operations);

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
				proxyFreeBalance: postProxyFreeBalance,
				batchResult,
				durationMs: performance.now() - startedAt,
			});
		}
	}

	log.info(`Log file: ${log.filePath()}`);
} catch (err) {
	log.error("Rebalance failed", err);
	if (!dryRun) {
		await sendErrorNotification(
			discordWebhookUrl,
			err,
			performance.now() - startedAt,
		).catch((e) => log.error("Failed to send Discord error notification", e));
	}
	process.exit(1);
} finally {
	client.destroy();
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

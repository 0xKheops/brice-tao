import { bittensor } from "@polkadot-api/descriptors";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
	entropyToMiniSecret,
	mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { createWsClient } from "polkadot-api/ws";
import { Sn45Api } from "./src/api/generated/Sn45Api.ts";
import type { Balances } from "./src/getBalances.ts";
import { getBalances } from "./src/getBalances.ts";
import { getMostProfitableSubnets } from "./src/getMostProfitableSubnets.ts";
import { getHealthySubnets } from "./src/getSubnetHealth.ts";
import { computeRebalance } from "./src/rebalance/computeRebalance.ts";
import { executeRebalance } from "./src/rebalance/executeRebalance.ts";
import { log } from "./src/rebalance/logger.ts";

// --- CLI arguments ---
const dryRun = process.argv.includes("--dry-run");

// --- Environment validation ---
const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const coldkey = process.env.COLDKEY_ADDRESS;
const sn45ApiKey = process.env.SN45_API_KEY;
const proxyMnemonic = process.env.PROXY_MNEMONIC;
const validatorHotkey = process.env.VALIDATOR_HOTKEY;

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!coldkey) throw new Error("COLDKEY_ADDRESS is not set");
if (!sn45ApiKey) throw new Error("SN45_API_KEY is not set");
if (!proxyMnemonic) throw new Error("PROXY_MNEMONIC is not set");
if (!validatorHotkey) throw new Error("VALIDATOR_HOTKEY is not set");

// --- Create signer from proxy mnemonic ---
const miniSecret = entropyToMiniSecret(mnemonicToEntropy(proxyMnemonic));
const derive = sr25519CreateDerive(miniSecret);
const keyPair = derive("");
const signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);

// --- Connect to chain ---
const client = createWsClient(wsEndpoints);
const sn45 = new Sn45Api({
	baseUrl: "https://sn45api.talisman.xyz",
	baseApiParams: { headers: { "X-API-Key": sn45ApiKey } },
});

try {
	const api = client.getTypedApi(bittensor);

	if (dryRun) log.info("[DRY RUN] Will not submit transaction.\n");

	log.info("Fetching balances, subnet health, and profitable subnets...");
	const [balances, { healthyNetuids, allHealth }] = await Promise.all([
		getBalances(api, coldkey),
		getHealthySubnets(api),
	]);

	log.verbose(
		`Subnet health: ${healthyNetuids.size} healthy out of ${allHealth.length} total`,
	);
	for (const h of allHealth) {
		const healthy = healthyNetuids.has(h.netuid) ? "✓" : "✗";
		log.verbose(
			`  SN${h.netuid.toString().padStart(3)} [${healthy}] emission=${h.taoInEmission} tao_in=${h.taoIn} volume=${h.subnetVolume}`,
		);
	}

	const profitable = await getMostProfitableSubnets(
		sn45,
		undefined,
		healthyNetuids,
	);

	log.info(
		`Portfolio: ${formatTao(balances.totalTaoValue)} τ total, ${balances.stakes.length} positions, ${profitable.length} profitable subnets`,
	);
	logBalancesDetail("BEFORE", coldkey, balances);

	const plan = computeRebalance(balances, profitable, validatorHotkey);

	if (plan.operations.length === 0) {
		log.info("Portfolio is balanced — nothing to do.");
	} else {
		log.info(
			`Plan: ${plan.operations.length} operations across ${plan.targets.length} target subnets`,
		);
		for (const skip of plan.skipped) {
			log.verbose(`  Skipped SN${skip.netuid}: ${skip.reason}`);
		}

		await executeRebalance(api, signer, coldkey, plan, { dryRun });

		if (!dryRun) {
			// Re-fetch and log balances after execution
			log.info("Fetching post-rebalance balances...");
			const postBalances = await getBalances(api, coldkey);
			log.info(
				`Portfolio after: ${formatTao(postBalances.totalTaoValue)} τ total, ${postBalances.stakes.length} positions`,
			);
			logBalancesDetail("AFTER", coldkey, postBalances);
		}
	}

	log.info(`Log file: ${log.filePath()}`);
} catch (err) {
	log.error("Rebalance failed", err);
	process.exit(1);
} finally {
	client.destroy();
}

function formatTao(rao: bigint): string {
	const TAO = 1_000_000_000n;
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

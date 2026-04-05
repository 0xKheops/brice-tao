import { deriveSigner } from "../src/accounts/deriveSigner.ts";
import { createBittensorClient } from "../src/api/createClient.ts";
import { fetchSubnetNames } from "../src/api/fetchSubnetNames.ts";
import type { Balances } from "../src/balances/getBalances.ts";
import { getBalances } from "../src/balances/getBalances.ts";
import {
	sendErrorNotification,
	sendRebalanceNotification,
} from "../src/notifications/discord.ts";
import { executeRebalancePlan } from "../src/rebalance/executeRebalancePlan.ts";
import { initLog, log } from "../src/rebalance/logger.ts";
import { getNextKey } from "../src/rebalance/mevShield.ts";
import { formatTao, parseTao } from "../src/rebalance/tao.ts";
import type {
	RebalanceConfig,
	RebalanceOperation,
	RebalancePlan,
} from "../src/rebalance/types.ts";
import { pickBestValidatorByYield } from "../src/validators/pickBestValidator.ts";

// u64::MAX — used with move_stake to sweep all alpha for a hotkey on a subnet
const U64_MAX = 18_446_744_073_709_551_615n;

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const dryRun = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const coldkey = process.env.COLDKEY_ADDRESS;
const proxyMnemonic = process.env.PROXY_MNEMONIC;
const validatorHotkey = process.env.VALIDATOR_HOTKEY;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!coldkey) throw new Error("COLDKEY_ADDRESS is not set");
if (!proxyMnemonic) throw new Error("PROXY_MNEMONIC is not set");

// ---------------------------------------------------------------------------
// Connect & initialise
// ---------------------------------------------------------------------------
initLog({ dryRun });
const { signer, address: proxyAddress } = deriveSigner(proxyMnemonic);
const { client, api } = createBittensorClient(wsEndpoints);
const startedAt = performance.now();

try {
	if (dryRun) log.info("[DRY RUN] Will not submit transaction.\n");

	log.info("🏚️  Bunker — moving all positions to SN0 (root)\n");

	// 1. Fetch balances, proxy account, subnet names in parallel
	const [balances, proxyAccount, subnetNames] = await Promise.all([
		getBalances(api, coldkey),
		api.query.System.Account.getValue(proxyAddress),
		fetchSubnetNames(api),
	]);
	const proxyFreeBalance = proxyAccount.data.free;

	printPortfolio(balances, subnetNames);

	// 2. Determine the target hotkey on SN0
	const targetHotkey = await resolveSn0Hotkey();

	log.info(`Target SN0 validator: ${targetHotkey.slice(0, 8)}…\n`);

	// 3. Determine MEV shield state — derive useLimits identically to
	//    executeRebalancePlan to avoid split-brain between op-building and execution
	const rebalanceConfig = buildConfig(balances);
	const mevKey = await getNextKey(api);
	const useLimits = rebalanceConfig.enforceSlippage || !mevKey;

	// 4. Build operations
	const { operations, skipped } = buildOperations(
		balances,
		targetHotkey,
		useLimits,
	);

	if (operations.length === 0) {
		log.info("Already bunkered — nothing to do.");
		client.destroy();
		process.exit(0);
	}

	if (operations.length > 20) {
		log.warn(
			`Large batch (${operations.length} ops) — may exceed block weight limits`,
		);
	}

	printOperations(operations, skipped, subnetNames);

	// 5. Execute
	const plan: RebalancePlan = {
		targets: [{ netuid: 0, hotkey: targetHotkey, share: 1.0 }],
		operations,
		skipped,
	};

	const { batchResult, balancesAfter, proxyFreeBalanceAfter } =
		await executeRebalancePlan({
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
			mevKey,
		});

	// 6. Discord notification
	if (!dryRun && discordWebhookUrl) {
		await sendRebalanceNotification(discordWebhookUrl, {
			plan,
			balancesBefore: balances,
			balancesAfter,
			proxyFreeBalanceBefore: proxyFreeBalance,
			proxyFreeBalanceAfter,
			batchResult,
			durationMs: performance.now() - startedAt,
		});
	}

	log.info(`\nLog file: ${log.filePath()}`);
} catch (err) {
	log.error("Bunker failed", err);
	if (!dryRun && discordWebhookUrl) {
		await sendErrorNotification(
			discordWebhookUrl,
			err,
			performance.now() - startedAt,
		).catch((e) => log.error("Failed to send Discord error notification", e));
	}
	client.destroy();
	process.exit(1);
} finally {
	client.destroy();
	process.exit(0);
}

// ---------------------------------------------------------------------------
// SN0 validator selection: pickBest → VALIDATOR_HOTKEY fallback
// ---------------------------------------------------------------------------
async function resolveSn0Hotkey(): Promise<string> {
	try {
		const best = await pickBestValidatorByYield(api, 0);
		log.info(
			`SN0 validator: yield-picked ${best.hotkey.slice(0, 8)}… (UID ${best.candidate.uid})`,
		);
		return best.hotkey;
	} catch (err) {
		if (validatorHotkey) {
			log.warn(
				`SN0 yield-based validator selection failed; using VALIDATOR_HOTKEY (${validatorHotkey.slice(0, 8)}…): ${String(err)}`,
			);
			return validatorHotkey;
		}
		throw new Error(
			`Cannot select validator for SN0: yield selection failed and VALIDATOR_HOTKEY not set. ${String(err)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Operation builder
// ---------------------------------------------------------------------------
function buildOperations(
	balances: Balances,
	targetHotkey: string,
	useLimits: boolean,
): { operations: RebalanceOperation[]; skipped: RebalancePlan["skipped"] } {
	const operations: RebalanceOperation[] = [];
	const skipped: RebalancePlan["skipped"] = [];
	const minOpTao = parseTao(0.01);

	// Phase 1: Consolidate existing SN0 positions to target hotkey
	for (const stake of balances.stakes) {
		if (stake.netuid !== 0) continue;
		if (stake.hotkey === targetHotkey) continue;

		operations.push({
			kind: "move",
			netuid: 0,
			originHotkey: stake.hotkey,
			destinationHotkey: targetHotkey,
			alphaAmount: U64_MAX,
		});
	}

	// Phase 2: Swap all non-SN0 positions to SN0
	for (const stake of balances.stakes) {
		if (stake.netuid === 0) continue;

		// Warn on zero-price positions — in an emergency exit, don't silently skip
		// real positions just because the price oracle returned 0
		if (stake.stake > 0n && stake.taoValue === 0n) {
			log.warn(
				`SN${stake.netuid} has alpha (${stake.stake}) but zero price — swapping anyway`,
			);
		} else if (stake.taoValue < minOpTao) {
			skipped.push({
				netuid: stake.netuid,
				reason: `Position too small to exit (${formatTao(stake.taoValue)} τ)`,
			});
			continue;
		}

		const needsHotkeyChange = stake.hotkey !== targetHotkey;
		if (needsHotkeyChange && useLimits) {
			operations.push({
				kind: "move",
				netuid: stake.netuid,
				originHotkey: stake.hotkey,
				destinationHotkey: targetHotkey,
				alphaAmount: U64_MAX,
			});
		}

		operations.push({
			kind: "swap",
			originNetuid: stake.netuid,
			destinationNetuid: 0,
			hotkey: needsHotkeyChange ? targetHotkey : stake.hotkey,
			alphaAmount: stake.stake,
			estimatedTaoValue: stake.taoValue,
			limitPrice: 0n,
			originHotkey: needsHotkeyChange && !useLimits ? stake.hotkey : undefined,
		});
	}

	return { operations, skipped };
}

// ---------------------------------------------------------------------------
// Hardcoded conservative config — designed for emergency exit
// ---------------------------------------------------------------------------
function buildConfig(balances: Balances): RebalanceConfig {
	return {
		minPositionTao: parseTao(0.01),
		freeReserveTao: balances.free,
		freeReserveTaoDriftPercent: 0.05,
		minOperationTao: parseTao(0.01),
		minStakeTao: parseTao(0.01),
		minRebalanceTao: parseTao(0.01),
		slippageBuffer: 0.03,
		enforceSlippage: false,
		allocationDriftPercent: 0,
	};
}

// ---------------------------------------------------------------------------
// Terminal display
// ---------------------------------------------------------------------------
function printPortfolio(
	balances: Balances,
	subnetNames: Map<number, string>,
): void {
	log.info("─".repeat(60));
	log.info("Portfolio");
	log.info("─".repeat(60));
	log.info(`  Free:      ${formatTao(balances.free)} τ`);

	if (balances.stakes.length === 0) {
		log.info("  Stakes:    (none)");
	} else {
		const sorted = [...balances.stakes].sort((a, b) =>
			Number(b.taoValue - a.taoValue),
		);
		log.info(`  Stakes (${sorted.length}):`);
		for (const s of sorted) {
			const name = (subnetNames.get(s.netuid) ?? "Unknown").padEnd(14);
			const snLabel = `SN${s.netuid.toString().padStart(3, " ")}`;
			log.info(
				`    ${snLabel} │ ${name} │ ${formatTao(s.taoValue).padStart(12)} τ`,
			);
		}
	}

	log.info(`  ${"─".repeat(40)}`);
	log.info(`  Total:     ${formatTao(balances.totalTaoValue)} τ\n`);
}

function printOperations(
	operations: RebalanceOperation[],
	skipped: RebalancePlan["skipped"],
	subnetNames: Map<number, string>,
): void {
	log.info("─".repeat(60));
	log.info(`Operations (${operations.length})`);
	log.info("─".repeat(60));

	for (const [i, op] of operations.entries()) {
		const desc = formatOpDescription(op, subnetNames);
		log.info(`  ${String(i + 1).padStart(2)}. ${desc}`);
	}

	if (skipped.length > 0) {
		log.info(`\n  Skipped (${skipped.length}):`);
		for (const s of skipped) {
			log.info(`    SN${s.netuid}: ${s.reason}`);
		}
	}

	log.info("");
}

function formatOpDescription(
	op: RebalanceOperation,
	names: Map<number, string>,
): string {
	const sn = (netuid: number) => {
		const name = names.get(netuid) ?? "";
		return `SN${netuid}${name ? ` ${name}` : ""}`.trim();
	};

	switch (op.kind) {
		case "move":
			return `Move hotkey   ${sn(op.netuid)} (${op.originHotkey.slice(0, 8)}… → ${op.destinationHotkey.slice(0, 8)}…)`;
		case "swap":
			return `Swap          ${sn(op.originNetuid)} → ${sn(op.destinationNetuid)}  ~${formatTao(op.estimatedTaoValue)} τ`;
		case "unstake":
		case "unstake_partial":
			return `Unstake       ${sn(op.netuid)}  ~${formatTao(op.estimatedTaoValue)} τ`;
		case "stake":
			return `Stake         ${sn(op.netuid)}  ${formatTao(op.taoAmount)} τ`;
	}
}

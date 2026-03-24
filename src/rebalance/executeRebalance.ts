import { type bittensor, MultiAddress } from "@polkadot-api/descriptors";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";
import type { PolkadotClient, PolkadotSigner, TypedApi } from "polkadot-api";
import { Enum } from "polkadot-api";
import { TAO } from "./constants.ts";
import { log } from "./logger.ts";
import { getNextKey, submitShieldedTx } from "./mevShield.ts";
import type {
	BatchResult,
	RebalanceOperation,
	RebalancePlan,
} from "./types.ts";
import { waitForInnerBatch } from "./waitForBatch.ts";

type Api = TypedApi<typeof bittensor>;

export interface ExecuteOptions {
	dryRun?: boolean;
}

/**
 * Execute a rebalance plan: build the batch of proxy-wrapped staking calls,
 * sign, encrypt via MEV shield, and submit.
 * Then wait for the inner batch to be executed and return the result.
 *
 * In dry-run mode, builds and prints the decoded call but does not sign or submit.
 */
export async function executeRebalance(
	client: PolkadotClient,
	api: Api,
	signer: PolkadotSigner,
	coldkeyAddress: string,
	plan: RebalancePlan,
	options?: ExecuteOptions,
): Promise<BatchResult | null> {
	const dryRun = options?.dryRun ?? false;

	if (plan.operations.length === 0) {
		log.info("No operations to execute — portfolio is balanced.");
		return null;
	}

	log.info(
		`${dryRun ? "[DRY RUN] " : ""}Executing ${plan.operations.length} operations...`,
	);

	// Build inner staking calls, each wrapped in Proxy.proxy
	const proxiedCalls = plan.operations.map((op, i) => {
		const innerCall = buildStakingCall(api, op);
		log.info(`  [${i + 1}/${plan.operations.length}] ${describeOperation(op)}`);
		log.verbose(`  ${describeOperation(op)}`);
		return api.tx.Proxy.proxy({
			real: MultiAddress.Id(coldkeyAddress),
			force_proxy_type: Enum("Staking"),
			call: innerCall.decodedCall,
		});
	});

	// Bundle into Utility.force_batch (continues on individual failures, unlike batch)
	const batchTx = api.tx.Utility.force_batch({
		calls: proxiedCalls.map((tx) => tx.decodedCall),
	});

	// Print full decoded call to terminal only (not in log file)
	log.console("\nDecoded batch call:");
	log.console(
		JSON.stringify(
			batchTx.decodedCall,
			(_key, value) => (typeof value === "bigint" ? value.toString() : value),
			2,
		),
	);
	log.console("");

	if (dryRun) {
		log.info("[DRY RUN] Skipping sign & submit.");
		return null;
	}

	// Get current nonce for MEV shield double-nonce pattern
	const proxyAddress = signerAddress(signer);
	const account = await api.query.System.Account.getValue(proxyAddress);
	const nonce = account.nonce;

	// Get MEV shield encryption key
	const nextKey = await getNextKey(api);
	if (!nextKey) {
		throw new Error(
			"No MEV shield NextKey available — cannot submit shielded transaction",
		);
	}

	log.verbose("Signing inner batch transaction...");
	// Sign the inner batch with nonce + 1 (MEV shield reserves nonce for wrapper)
	const innerSignedBytes = await batchTx.sign(signer, { nonce: nonce + 1 });

	log.verbose("Encrypting and submitting via MEV shield...");
	const outerResult = await submitShieldedTx(
		api,
		signer,
		innerSignedBytes,
		nextKey,
		nonce,
	);

	const wrapperFee = extractWrapperFee(outerResult.events);
	log.info(
		`✓ MEV-shielded wrapper finalized in block ${outerResult.block.number} (fee: ${formatFee(wrapperFee)} τ)`,
	);

	// Wait for the inner batch transaction to be executed
	log.info("Waiting for inner batch execution...");
	const batchResult = await waitForInnerBatch(
		client,
		api,
		innerSignedBytes,
		plan.operations.length,
		wrapperFee,
	);

	if (batchResult.status !== "timeout") {
		log.info(
			`Inner batch fee: ${formatFee(batchResult.innerBatchFee)} τ | Total fees: ${formatFee(wrapperFee + batchResult.innerBatchFee)} τ`,
		);
	}

	return batchResult;
}

function buildStakingCall(api: Api, op: RebalanceOperation) {
	switch (op.kind) {
		case "swap":
			return api.tx.SubtensorModule.swap_stake_limit({
				hotkey: op.hotkey,
				origin_netuid: op.originNetuid,
				destination_netuid: op.destinationNetuid,
				alpha_amount: op.alphaAmount,
				limit_price: op.limitPrice,
				allow_partial: false,
			});

		case "unstake":
			return api.tx.SubtensorModule.remove_stake_full_limit({
				hotkey: op.hotkey,
				netuid: op.netuid,
				limit_price: op.limitPrice,
			});

		case "unstake_partial":
			return api.tx.SubtensorModule.remove_stake_limit({
				hotkey: op.hotkey,
				netuid: op.netuid,
				amount_unstaked: op.alphaAmount,
				limit_price: op.limitPrice,
				allow_partial: false,
			});

		case "stake":
			return api.tx.SubtensorModule.add_stake_limit({
				hotkey: op.hotkey,
				netuid: op.netuid,
				amount_staked: op.taoAmount,
				limit_price: op.limitPrice,
				allow_partial: false,
			});
	}
}

function signerAddress(signer: PolkadotSigner): string {
	return ss58Address(signer.publicKey, 42);
}

function describeOperation(op: RebalanceOperation): string {
	const fmt = (rao: bigint) =>
		`${rao / TAO}.${(((rao % TAO) * 1000n) / TAO).toString().padStart(3, "0")} τ`;
	switch (op.kind) {
		case "swap":
			return `SWAP SN${op.originNetuid}→SN${op.destinationNetuid}: ~${fmt(op.estimatedTaoValue)}`;
		case "unstake":
			return `UNSTAKE SN${op.netuid}: ~${fmt(op.estimatedTaoValue)} (full)`;
		case "unstake_partial":
			return `UNSTAKE SN${op.netuid}: ~${fmt(op.estimatedTaoValue)} (partial)`;
		case "stake":
			return `STAKE SN${op.netuid}: ${fmt(op.taoAmount)}`;
	}
}

function extractWrapperFee(
	events: Array<{ type: string; value: unknown }>,
): bigint {
	for (const event of events) {
		if (event.type === "TransactionPayment") {
			const value = event.value as { type: string; value: unknown };
			if (value.type === "TransactionFeePaid") {
				const feePaid = value.value as { actual_fee: bigint };
				return feePaid.actual_fee;
			}
		}
	}
	return 0n;
}

function formatFee(rao: bigint): string {
	const whole = rao / TAO;
	const frac = ((rao % TAO) * 1_000_000n) / TAO;
	return `${whole}.${frac.toString().padStart(6, "0")}`;
}

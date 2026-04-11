import { type bittensor, MultiAddress } from "@polkadot-api/descriptors";
import { fromBufferToBase58 } from "@polkadot-api/substrate-bindings";
import type { PolkadotClient, PolkadotSigner, TypedApi } from "polkadot-api";
import { Enum } from "polkadot-api";
import { TAO } from "./constants.ts";
import { log } from "./logger.ts";
import { submitShieldedTx } from "./mevShield.ts";
import { extractProxyResults } from "./proxyEvents.ts";
import { formatTao } from "./tao.ts";
import type {
	BatchResult,
	RebalanceOperation,
	RebalancePlan,
} from "./types.ts";
import { waitForInnerBatch } from "./waitForBatch.ts";

type Api = TypedApi<typeof bittensor>;

export interface ExecuteOptions {
	dryRun?: boolean;
	/** When true, use limit-price extrinsics (with allow_partial: false) */
	useLimits?: boolean;
	/** Pre-fetched MEV shield public key (undefined = unavailable) */
	mevKey?: Uint8Array;
}

/**
 * Execute a rebalance plan: build the batch of proxy-wrapped staking calls,
 * sign, and submit — either via MEV shield (encrypted, double-nonce) or
 * directly (single nonce) when the shield is unavailable.
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
	const useLimits = options?.useLimits ?? true;

	if (plan.operations.length === 0) {
		log.info("No operations to execute — portfolio is balanced.");
		return null;
	}

	log.info(
		`${dryRun ? "[DRY RUN] " : ""}Executing ${plan.operations.length} operations...`,
	);

	// Build inner staking calls, each wrapped in Proxy.proxy
	const proxiedCalls = plan.operations.map((op, i) => {
		const innerCall = buildStakingCall(api, op, useLimits);
		log.info(`  [${i + 1}/${plan.operations.length}] ${describeOperation(op)}`);
		log.verbose(`  ${describeOperation(op)}`);
		return api.tx.Proxy.proxy({
			real: MultiAddress.Id(coldkeyAddress),
			force_proxy_type: Enum("Staking"),
			call: innerCall.decodedCall,
		});
	});

	// When there's only one call, submit it directly to save batch overhead fees.
	// For multiple calls, bundle into Utility.force_batch (continues on individual failures).
	const innerTx =
		proxiedCalls.length > 1
			? api.tx.Utility.force_batch({
					calls: proxiedCalls.map((tx) => tx.decodedCall),
				})
			: proxiedCalls[0];

	if (!innerTx) {
		throw new Error("Unreachable: proxiedCalls is non-empty");
	}

	// Print full decoded call to terminal only (not in log file)
	log.console("\nDecoded call:");
	log.console(
		JSON.stringify(
			innerTx.decodedCall,
			(_key, value) => (typeof value === "bigint" ? value.toString() : value),
			2,
		),
	);
	log.console("");

	if (dryRun) {
		log.info("[DRY RUN] Skipping sign & submit.");
		return null;
	}

	// Use the pre-fetched MEV key — no additional RPC call
	const mevKey = options?.mevKey;

	if (mevKey) {
		return submitShielded(client, api, signer, innerTx, mevKey, plan);
	}
	return submitDirect(client, signer, innerTx, plan);
}

/** Submit via MEV shield: sign with double-nonce, encrypt, and wait for inner batch */
async function submitShielded(
	client: PolkadotClient,
	api: Api,
	signer: PolkadotSigner,
	innerTx: ReturnType<Api["tx"]["Utility"]["force_batch"]>,
	nextKey: Uint8Array,
	plan: RebalancePlan,
): Promise<BatchResult> {
	const proxyAddress = signerAddress(signer);
	const account = await api.query.System.Account.getValue(proxyAddress);
	const nonce = account.nonce;

	log.verbose("Signing inner transaction (MEV shield double-nonce)...");
	const innerSignedBytes = await innerTx.sign(signer, { nonce: nonce + 1 });

	log.verbose("Encrypting and submitting via MEV shield...");
	const outerResult = await submitShieldedTx(
		api,
		signer,
		innerSignedBytes,
		nextKey,
		nonce,
	);

	const wrapperFee = extractFee(outerResult.events);
	log.info(
		`✓ MEV-shielded wrapper finalized in block ${outerResult.block.number} (fee: ${formatTao(wrapperFee, 6)} τ)`,
	);

	log.info("Waiting for inner transaction execution...");
	const batchResult = await waitForInnerBatch(
		client,
		api,
		innerSignedBytes,
		plan.operations.length,
		wrapperFee,
	);

	if (batchResult.status !== "timeout") {
		log.info(
			`Inner batch fee: ${formatTao(batchResult.innerBatchFee, 6)} τ | Total fees: ${formatTao(wrapperFee + batchResult.innerBatchFee, 6)} τ`,
		);
	}

	return batchResult;
}

/** Submit directly without MEV shield: single nonce, wait for finalization */
async function submitDirect(
	_client: PolkadotClient,
	signer: PolkadotSigner,
	innerTx: ReturnType<Api["tx"]["Utility"]["force_batch"]>,
	plan: RebalancePlan,
): Promise<BatchResult> {
	log.warn(
		"MEV shield unavailable — submitting directly (no encryption, no frontrun protection)",
	);

	const result = await innerTx.signAndSubmit(signer, {
		mortality: { mortal: true, period: 8 },
	});

	const fee = extractFee(result.events);
	log.info(
		`✓ Direct batch finalized in block ${result.block.number} (fee: ${formatTao(fee, 6)} τ)`,
	);

	const innerTxHash = result.txHash;

	// For direct submission, parse batch results from finalized block events
	const directResult = await parseBatchResultFromEvents(
		result,
		plan.operations.length,
		innerTxHash,
	);

	return directResult;
}

function buildStakingCall(
	api: Api,
	op: RebalanceOperation,
	useLimits: boolean,
) {
	switch (op.kind) {
		case "swap":
			if (useLimits) {
				return api.tx.SubtensorModule.swap_stake_limit({
					hotkey: op.hotkey,
					origin_netuid: op.originNetuid,
					destination_netuid: op.destinationNetuid,
					alpha_amount: op.alphaAmount,
					limit_price: op.limitPrice,
					allow_partial: false,
				});
			}
			// Simple path: use move_stake (supports hotkey change in one call, ~50% cheaper)
			return api.tx.SubtensorModule.move_stake({
				origin_hotkey: op.originHotkey ?? op.hotkey,
				destination_hotkey: op.hotkey,
				origin_netuid: op.originNetuid,
				destination_netuid: op.destinationNetuid,
				alpha_amount: op.alphaAmount,
			});

		case "unstake":
			if (useLimits) {
				return api.tx.SubtensorModule.remove_stake_full_limit({
					hotkey: op.hotkey,
					netuid: op.netuid,
					limit_price: op.limitPrice,
				});
			}
			// Simple path: remove_stake_full_limit without limit_price
			return api.tx.SubtensorModule.remove_stake_full_limit({
				hotkey: op.hotkey,
				netuid: op.netuid,
				limit_price: undefined,
			});

		case "unstake_partial":
			if (useLimits) {
				return api.tx.SubtensorModule.remove_stake_limit({
					hotkey: op.hotkey,
					netuid: op.netuid,
					amount_unstaked: op.alphaAmount,
					limit_price: op.limitPrice,
					allow_partial: false,
				});
			}
			// Simple path: remove_stake (fill-or-kill by default)
			return api.tx.SubtensorModule.remove_stake({
				hotkey: op.hotkey,
				netuid: op.netuid,
				amount_unstaked: op.alphaAmount,
			});

		case "stake":
			if (useLimits) {
				return api.tx.SubtensorModule.add_stake_limit({
					hotkey: op.hotkey,
					netuid: op.netuid,
					amount_staked: op.taoAmount,
					limit_price: op.limitPrice,
					allow_partial: false,
				});
			}
			// Simple path: add_stake (fill-or-kill by default)
			return api.tx.SubtensorModule.add_stake({
				hotkey: op.hotkey,
				netuid: op.netuid,
				amount_staked: op.taoAmount,
			});

		case "move":
			return api.tx.SubtensorModule.move_stake({
				origin_hotkey: op.originHotkey,
				destination_hotkey: op.destinationHotkey,
				origin_netuid: op.netuid,
				destination_netuid: op.netuid,
				alpha_amount: op.alphaAmount,
			});
	}
}

const toSs58 = fromBufferToBase58(42);

function signerAddress(signer: PolkadotSigner): string {
	return toSs58(signer.publicKey);
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
		case "move":
			return `MOVE SN${op.netuid}: reassign ${op.originHotkey.slice(0, 8)}…→${op.destinationHotkey.slice(0, 8)}…`;
	}
}

function extractFee(events: Array<{ type: string; value: unknown }>): bigint {
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

/**
 * Parse batch results from a directly-submitted (non-shielded) transaction's
 * finalized events. Handles both single-call and force_batch results.
 */
async function parseBatchResultFromEvents(
	result: {
		block: { number: number; hash: string };
		events: Array<{ type: string; value: unknown }>;
	},
	totalOps: number,
	txHash: string,
): Promise<BatchResult> {
	const fee = extractFee(result.events);

	// Collect per-operation results from Proxy.ProxyExecuted events
	const proxyResults = extractProxyResults(
		result.events,
		(e) => e as { type: string; value: unknown },
	);

	const operationResults = Array.from({ length: totalOps }, (_, i) => ({
		index: i,
		success: proxyResults[i]?.ok ?? true,
		error: proxyResults[i]?.ok === false ? proxyResults[i].error : undefined,
	}));

	const failedCount = operationResults.filter((r) => !r.success).length;

	return {
		status: failedCount > 0 ? "partial_failure" : "completed",
		blockNumber: result.block.number,
		operationResults,
		wrapperFee: 0n,
		innerBatchFee: fee,
		innerTxHash: txHash,
	};
}

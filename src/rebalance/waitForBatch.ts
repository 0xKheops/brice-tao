import { blake2AsHex } from "@polkadot/util-crypto";
import type { bittensor } from "@polkadot-api/descriptors";
import type { PolkadotClient, TypedApi } from "polkadot-api";
import { timeout as rxTimeout } from "rxjs/operators";
import { log } from "./logger.ts";
import { extractProxyResults } from "./proxyEvents.ts";
import type { BatchResult, OperationResult } from "./types.ts";

type Api = TypedApi<typeof bittensor>;

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * After the outer MEV-shield transaction is finalized, watch finalized blocks
 * until the inner batch transaction appears in a block body (matched by raw bytes).
 * Then parse per-operation results from the block's events.
 */
export async function waitForInnerBatch(
	client: PolkadotClient,
	api: Api,
	innerSignedBytes: Uint8Array,
	totalOps: number,
	wrapperFee: bigint,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BatchResult> {
	const innerTxHash = blake2AsHex(innerSignedBytes, 256);
	log.verbose(
		`Watching finalized blocks for inner batch transaction (${innerTxHash})...`,
	);

	try {
		const found = await findTxInFinalizedBlocks(
			client,
			innerSignedBytes,
			timeoutMs,
		);

		log.info(
			`Inner batch found in block #${found.blockNumber} at extrinsic index ${found.extrinsicIndex}`,
		);

		const { operationResults, fee: innerBatchFee } =
			await extractOperationResults(
				api,
				found.blockHash,
				found.extrinsicIndex,
				totalOps,
			);

		const failedCount = operationResults.filter((r) => !r.success).length;

		if (failedCount === 0) {
			log.info(
				`✓ Batch completed successfully: all ${totalOps} operations succeeded (block #${found.blockNumber})`,
			);
			return {
				status: "completed",
				blockNumber: found.blockNumber,
				operationResults,
				wrapperFee,
				innerBatchFee,
				innerTxHash,
			};
		}

		log.warn(
			`⚠ Batch completed with ${failedCount}/${totalOps} failure(s) in block #${found.blockNumber}`,
		);
		for (const r of operationResults) {
			if (!r.success) {
				log.warn(`  Operation ${r.index}: ${r.error ?? "unknown error"}`);
			}
		}
		return {
			status: "partial_failure",
			blockNumber: found.blockNumber,
			operationResults,
			wrapperFee,
			innerBatchFee,
			innerTxHash,
		};
	} catch (err) {
		if (err instanceof TxSearchTimeoutError) {
			log.warn(
				`Timed out waiting for inner batch execution after ${timeoutMs / 1000}s`,
			);
			return { status: "timeout", wrapperFee, innerTxHash };
		}
		throw err;
	}
}

class TxSearchTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Inner batch tx not found within ${timeoutMs / 1000}s`);
		this.name = "TxSearchTimeoutError";
	}
}

interface FoundTx {
	blockHash: string;
	blockNumber: number;
	extrinsicIndex: number;
}

/**
 * Subscribe to finalized blocks, fetch each block's body, and find the
 * extrinsic matching `innerSignedBytes` by direct byte comparison.
 * This is the same approach polkadot-api uses internally (track-tx.mjs).
 */
async function findTxInFinalizedBlocks(
	client: PolkadotClient,
	innerSignedBytes: Uint8Array,
	timeoutMs: number,
): Promise<FoundTx> {
	return new Promise<FoundTx>((resolve, reject) => {
		const deadline = new Date(Date.now() + timeoutMs);
		const sub = client.finalizedBlock$.pipe(rxTimeout(deadline)).subscribe({
			next: async (block) => {
				try {
					log.verbose(
						`  Scanning finalized block #${block.number} (${block.hash.slice(0, 10)}...)`,
					);
					const body = await client.getBlockBody(block.hash);

					for (const [i, ext] of body.entries()) {
						if (bytesEqual(ext, innerSignedBytes)) {
							sub.unsubscribe();
							resolve({
								blockHash: block.hash,
								blockNumber: block.number,
								extrinsicIndex: i,
							});
							return;
						}
					}
				} catch (err) {
					sub.unsubscribe();
					reject(err);
				}
			},
			error: (err) => {
				if (err?.name === "TimeoutError") {
					reject(new TxSearchTimeoutError(timeoutMs));
				} else {
					reject(err);
				}
			},
		});
	});
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Given a block hash and extrinsic index, fetch the block's events and
 * extract per-operation results from Utility ItemCompleted/ItemFailed events,
 * cross-referenced with Proxy.ProxyExecuted events.
 *
 * Each batch call is wrapped in Proxy.proxy, so even when the inner staking
 * call fails, the proxy dispatch itself succeeds (emitting ItemCompleted).
 * The real result lives in the Proxy.ProxyExecuted event. We must check both.
 */
function extractTransactionFee(
	extrinsicEvents: Array<{
		event: { type: string; value: unknown };
	}>,
): bigint {
	for (const record of extrinsicEvents) {
		if (record.event.type === "TransactionPayment") {
			const value = record.event.value as { type: string; value: unknown };
			if (value.type === "TransactionFeePaid") {
				const feePaid = value.value as { actual_fee: bigint };
				return feePaid.actual_fee;
			}
		}
	}
	return 0n;
}

async function extractOperationResults(
	api: Api,
	blockHash: string,
	extrinsicIndex: number,
	totalOps: number,
): Promise<{ operationResults: OperationResult[]; fee: bigint }> {
	const events = await api.query.System.Events.getValue({ at: blockHash });

	// Filter events belonging to our extrinsic
	const extrinsicEvents = events.filter(
		(e) =>
			e.phase.type === "ApplyExtrinsic" && e.phase.value === extrinsicIndex,
	);

	const fee = extractTransactionFee(extrinsicEvents);

	// Collect Proxy.ProxyExecuted results in order — they correspond 1:1 to proxy calls
	const proxyResults = extractProxyResults(
		extrinsicEvents,
		(r) => r.event,
		(value) => formatDispatchError(value as { type: string; value?: unknown }),
	);

	// Check if this was a batched call by looking for Utility item events
	const hasUtilityItems = extrinsicEvents.some(
		(r) =>
			r.event.type === "Utility" &&
			(r.event.value.type === "ItemCompleted" ||
				r.event.value.type === "ItemFailed"),
	);

	// Single (non-batched) proxy call — derive result directly from ProxyExecuted
	if (!hasUtilityItems) {
		const pr = proxyResults[0];
		const operationResults: OperationResult[] = pr
			? [
					{
						index: 0,
						success: pr.ok,
						error: pr.ok ? undefined : (pr.error ?? "Proxied call failed"),
					},
				]
			: [
					{
						index: 0,
						success: false,
						error: "No event found for this operation",
					},
				];

		return { operationResults, fee };
	}

	// Walk ItemCompleted/ItemFailed events in order — they correspond 1:1 to batch calls
	const results: OperationResult[] = [];
	for (const record of extrinsicEvents) {
		if (record.event.type !== "Utility") continue;
		const ev = record.event.value;

		if (ev.type === "ItemCompleted") {
			// Batch item succeeded, but check if the proxied inner call failed
			const proxyResult = proxyResults[results.length];
			if (proxyResult && !proxyResult.ok) {
				results.push({
					index: results.length,
					success: false,
					error: proxyResult.error ?? "Proxied call failed",
				});
			} else {
				results.push({ index: results.length, success: true });
			}
		} else if (ev.type === "ItemFailed") {
			results.push({
				index: results.length,
				success: false,
				error: formatDispatchError(ev.value.error),
			});
		}
		if (results.length >= totalOps) break;
	}

	// Pad remaining as unknown failures if fewer results than expected
	while (results.length < totalOps) {
		results.push({
			index: results.length,
			success: false,
			error: "No event found for this operation",
		});
	}

	return { operationResults: results, fee };
}

/**
 * Convert a DispatchError into a human-readable string.
 * For Module errors, extracts the pallet and error variant names.
 */
function formatDispatchError(error: { type: string; value?: unknown }): string {
	switch (error.type) {
		case "Module": {
			const moduleError = error.value as {
				type: string;
				value?: { type: string };
			};
			const pallet = moduleError.type;
			const errorName =
				moduleError.value &&
				typeof moduleError.value === "object" &&
				"type" in moduleError.value
					? (moduleError.value as { type: string }).type
					: "Unknown";
			return `${pallet}::${errorName}`;
		}
		case "Token": {
			const tokenError = error.value as { type: string };
			return `Token::${tokenError.type}`;
		}
		case "Arithmetic": {
			const arithError = error.value as { type: string };
			return `Arithmetic::${arithError.type}`;
		}
		default:
			return error.type;
	}
}

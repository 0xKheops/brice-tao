import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { log } from "./logger.ts";
import type { BatchResult } from "./types.ts";

type Api = TypedApi<typeof bittensor>;

const POLL_INTERVAL_MS = 6_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_BLOCKS_TO_SCAN = 5;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After the outer MEV-shield transaction is finalized, poll finalized blocks
 * to detect when the inner batch transaction is executed and determine its outcome.
 *
 * The inner tx was signed with `startNonce + 1`, so once the signer's on-chain nonce
 * reaches `startNonce + 2` we know both the outer and inner tx have been consumed.
 * We then scan recent blocks for Utility batch events to determine success/failure.
 */
export async function waitForInnerBatch(
	api: Api,
	signerAddress: string,
	startNonce: number,
	outerBlockNumber: number,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BatchResult> {
	const expectedNonce = startNonce + 2;
	const deadline = Date.now() + timeoutMs;

	log.verbose(
		`Waiting for inner batch execution (nonce ${startNonce + 1}, expecting nonce to reach ${expectedNonce})...`,
	);

	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);

		const account = await api.query.System.Account.getValue(signerAddress);
		if (account.nonce < expectedNonce) {
			log.verbose(`  Nonce still at ${account.nonce}, waiting...`);
			continue;
		}

		log.verbose(`  Nonce reached ${account.nonce} — inner tx was included`);

		// Scan recent finalized blocks for batch events
		const currentBlockNum = await api.query.System.Number.getValue();

		const scanStart = Math.max(
			outerBlockNumber + 1,
			currentBlockNum - MAX_BLOCKS_TO_SCAN,
		);
		for (let blockNum = scanStart; blockNum <= currentBlockNum; blockNum++) {
			const result = await checkBlockForBatchResult(api, blockNum);
			if (result) return result;
		}

		// Nonce advanced but no batch events found — likely succeeded
		// (events may have been pruned or the batch had zero operations)
		log.warn(
			"Nonce advanced but no Utility batch events found in recent blocks",
		);
		return { status: "completed", blockNumber: currentBlockNum };
	}

	log.warn(
		`Timed out waiting for inner batch execution after ${timeoutMs / 1000}s`,
	);
	return { status: "timeout" };
}

async function checkBlockForBatchResult(
	api: Api,
	blockNumber: number,
): Promise<BatchResult | null> {
	const blockHash = await api.query.System.BlockHash.getValue(blockNumber);
	const zeroHash =
		"0x0000000000000000000000000000000000000000000000000000000000000000";
	if (blockHash === zeroHash) return null;

	const events = await api.query.System.Events.getValue({ at: blockHash });

	for (const record of events) {
		if (record.event.type !== "Utility") continue;

		const utilityEvent = record.event.value;

		if (utilityEvent.type === "BatchCompleted") {
			log.info(`✓ Batch completed successfully in block ${blockNumber}`);
			return { status: "completed", blockNumber };
		}

		if (utilityEvent.type === "BatchCompletedWithErrors") {
			// force_batch emits this when some items failed but execution continued
			const extrinsicIndex =
				record.phase.type === "ApplyExtrinsic" ? record.phase.value : undefined;
			const failedItems =
				extrinsicIndex !== undefined
					? events.filter(
							(e) =>
								e.phase.type === "ApplyExtrinsic" &&
								e.phase.value === extrinsicIndex &&
								e.event.type === "Utility" &&
								e.event.value.type === "ItemFailed",
						)
					: [];
			const completedCount =
				extrinsicIndex !== undefined
					? events.filter(
							(e) =>
								e.phase.type === "ApplyExtrinsic" &&
								e.phase.value === extrinsicIndex &&
								e.event.type === "Utility" &&
								e.event.value.type === "ItemCompleted",
						).length
					: 0;

			const firstFailedIndex =
				failedItems.length > 0
					? events
							.filter(
								(e) =>
									e.phase.type === "ApplyExtrinsic" &&
									e.phase.value === extrinsicIndex &&
									e.event.type === "Utility" &&
									(e.event.value.type === "ItemCompleted" ||
										e.event.value.type === "ItemFailed"),
							)
							.findIndex((e) => e.event.value.type === "ItemFailed")
					: -1;

			log.warn(
				`⚠ Batch completed with ${failedItems.length} error(s) in block ${blockNumber} (${completedCount} succeeded)`,
			);
			return {
				status: "partial_failure",
				failedAtIndex: firstFailedIndex >= 0 ? firstFailedIndex : 0,
				totalOps: completedCount + failedItems.length,
				blockNumber,
			};
		}

		if (utilityEvent.type === "BatchInterrupted") {
			const { index } = utilityEvent.value;
			// Count ItemCompleted events in the same extrinsic phase to determine total ops attempted
			const extrinsicIndex =
				record.phase.type === "ApplyExtrinsic" ? record.phase.value : undefined;
			const itemCount =
				extrinsicIndex !== undefined
					? events.filter(
							(e) =>
								e.phase.type === "ApplyExtrinsic" &&
								e.phase.value === extrinsicIndex &&
								e.event.type === "Utility" &&
								e.event.value.type === "ItemCompleted",
						).length
					: 0;

			log.warn(
				`⚠ Batch interrupted at operation ${index + 1} in block ${blockNumber} (${itemCount} succeeded before failure)`,
			);
			return {
				status: "partial_failure",
				failedAtIndex: index,
				totalOps: itemCount + 1, // completed + the failed one
				blockNumber,
			};
		}
	}

	return null;
}

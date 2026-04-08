import type { PolkadotClient } from "polkadot-api";
import { log } from "../rebalance/logger.ts";
import { isDbHistoryBlock } from "./constants.ts";
import type { HistoryDatabase } from "./db.ts";
import { fetchHistorySnapshot } from "./fetch.ts";
import type { HistorySnapshot } from "./types.ts";

/**
 * Record the current finalized block's subnet data into the shared history
 * database — if it falls on the 25-block grid.
 *
 * This is the **only** function strategies should call to populate the
 * history DB.
 *
 * - Checks the finalized block number **before** fetching snapshot data,
 *   avoiding 4 heavy RPC queries on non-grid blocks
 * - Converts all fields to the canonical format
 * - Idempotent: silently skips if the block was already recorded
 *
 * Returns the snapshot if it was recorded, or `null` if skipped (non-grid
 * block or already recorded).
 */
export async function recordCurrentBlock(
	client: PolkadotClient,
	db: HistoryDatabase,
): Promise<HistorySnapshot | null> {
	const finalizedBlock = await client.getFinalizedBlock();

	if (!isDbHistoryBlock(finalizedBlock.number)) {
		log.verbose(
			`History: skipping block #${finalizedBlock.number} (not on 25-block grid)`,
		);
		return null;
	}

	const snapshot = await fetchHistorySnapshot(client, finalizedBlock);

	const inserted = db.recordSnapshot(snapshot);
	if (inserted) {
		log.verbose(
			`History: recorded block #${snapshot.block.blockNumber} (${snapshot.subnets.length} subnets)`,
		);
	}

	return snapshot;
}

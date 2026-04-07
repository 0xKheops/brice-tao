import type { PolkadotClient } from "polkadot-api";
import { log } from "../rebalance/logger.ts";
import { isGridBlock } from "./constants.ts";
import type { HistoryDatabase } from "./db.ts";
import { fetchHistorySnapshot } from "./fetch.ts";
import type { HistorySnapshot } from "./types.ts";

/**
 * Fetch the current finalized block's subnet data and record it into the
 * shared history database. This is the **only** function strategies should
 * call to populate the history DB.
 *
 * - Fetches from the finalized block (enforcing the finalized-only invariant)
 * - **Skips non-grid blocks** (`blockNumber % 25 !== 0`) to maintain the
 *   5-minute interval grid — see `src/history/constants.ts`
 * - Converts all fields to the canonical format
 * - Idempotent: silently skips if the block was already recorded
 *
 * Returns the snapshot if it was recorded, or `null` if skipped (non-grid block
 * or already recorded).
 */
export async function recordCurrentBlock(
	client: PolkadotClient,
	db: HistoryDatabase,
): Promise<HistorySnapshot | null> {
	const snapshot = await fetchHistorySnapshot(client);

	if (!isGridBlock(snapshot.block.blockNumber)) {
		log.verbose(
			`History: skipping block #${snapshot.block.blockNumber} (not on 25-block grid)`,
		);
		return null;
	}

	const inserted = db.recordSnapshot(snapshot);
	if (inserted) {
		log.verbose(
			`History: recorded block #${snapshot.block.blockNumber} (${snapshot.subnets.length} subnets)`,
		);
	}

	return snapshot;
}

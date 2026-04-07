/**
 * History DB block-interval constant.
 *
 * Bittensor produces 1 block every ~12 s. Recording every 25th block
 * gives ≈ 5-minute granularity — a good trade-off between resolution
 * and disk usage for long-term backtesting data.
 *
 * **Invariant:** every `block_number` stored in the history DB must
 * satisfy `block_number % BLOCK_INTERVAL === 0`. The DB schema
 * enforces this with a CHECK constraint, and `recordCurrentBlock()`
 * skips non-grid blocks at the code level.
 *
 * Future backfill scripts must iterate in steps of BLOCK_INTERVAL:
 * ```ts
 * for (let b = snapToGrid(start); b <= end; b += BLOCK_INTERVAL) { … }
 * ```
 */
export const BLOCK_INTERVAL = 25;

/** Returns `true` if `blockNumber` falls on the 25-block recording grid. */
export function isGridBlock(blockNumber: number): boolean {
	return blockNumber % BLOCK_INTERVAL === 0;
}

/**
 * Snap a block number **down** to the nearest grid point.
 * Useful for backfill start/end alignment.
 */
export function snapToGrid(blockNumber: number): number {
	return blockNumber - (blockNumber % BLOCK_INTERVAL);
}

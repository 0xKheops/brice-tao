/**
 * Average block production time on Bittensor, in seconds.
 * Used to convert between wall-clock durations and block counts.
 */
export const SECONDS_PER_BLOCK = 12;

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
export const DB_HISTORY_BLOCK_INTERVAL = 25;

/**
 * Oldest block that can be backfilled from archive nodes.
 *
 * The runtime APIs used by the backfill script (e.g.
 * `SwapRuntimeApi.current_alpha_price_all`) did not exist before this block.
 * Attempting to query earlier blocks will fail, so we enforce this as a
 * hard floor for any backfill or backtest range.
 */
export const OLDEST_BACKFILL_BLOCK = 7_818_900;

/** Returns `true` if `blockNumber` falls on the 25-block recording grid. */
export function isDbHistoryBlock(blockNumber: number): boolean {
	return blockNumber % DB_HISTORY_BLOCK_INTERVAL === 0;
}

/**
 * Snap a block number **down** to the nearest grid point.
 * Useful for backfill start/end alignment.
 */
export function snapToDbHistory(blockNumber: number): number {
	return blockNumber - (blockNumber % DB_HISTORY_BLOCK_INTERVAL);
}

/**
 * Utilities for RPC call rate management.
 *
 * Bittensor public/archive RPC endpoints typically enforce a rate limit
 * (e.g. 100 req/min). These helpers let batch-oriented code (warmup,
 * backfill) stay comfortably below that ceiling.
 */

const ZERO_HASH = `0x${"0".repeat(64)}`;

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Returns `true` when the given block hash is the all-zero sentinel value,
 * which archive/full nodes return for blocks they haven't stored.
 */
export function isZeroHash(hash: string): boolean {
	return hash === ZERO_HASH;
}

/**
 * Minimum delay (ms) to insert after issuing `callCount` RPC calls,
 * given a cap of `maxPerMinute`.  Adds a 10 % safety margin.
 */
export function rpcBatchDelayMs(
	callCount: number,
	maxPerMinute: number,
): number {
	return Math.ceil((callCount / maxPerMinute) * 60_000 * 1.1);
}

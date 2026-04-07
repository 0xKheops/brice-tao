/**
 * Utilities for RPC block lookups.
 */

import type { PolkadotClient } from "polkadot-api";

const ZERO_HASH = `0x${"0".repeat(64)}`;

/**
 * Returns `true` when the given block hash is the all-zero sentinel value,
 * which archive/full nodes return for blocks they haven't stored.
 */
export function isZeroHash(hash: string): boolean {
	return hash === ZERO_HASH;
}

/**
 * Resolve a block number to its hash via the `chain_getBlockHash` legacy RPC.
 *
 * Unlike `System.BlockHash` storage (capped at the last ~2400 blocks on
 * Bittensor), this queries the node's block DB directly and works for any
 * historical block on archive nodes.
 */
export function getBlockHash(
	client: PolkadotClient,
	blockNumber: number,
): Promise<string> {
	return client._request<string>("chain_getBlockHash", [blockNumber]);
}

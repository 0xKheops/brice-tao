export const TAO = 1_000_000_000n;

/** Minimum TAO value per subnet position to justify fees */
export const MIN_POSITION_TAO = TAO / 2n; // 0.5 TAO

/** Maximum number of target subnets */
export const MAX_SUBNETS = 10;

/** Free TAO to keep unreserved for transaction fees */
export const FREE_RESERVE_TAO = TAO / 20n; // 0.05 TAO

/** Safety buffer on top of simulated price (0.3%) */
export const SLIPPAGE_BUFFER = 0.003;

/**
 * Swap-specific slippage buffer (2%).
 * Swaps within a force_batch execute sequentially against live pool state.
 * Multiple swaps from the same origin subnet compound the price impact —
 * each sell pushes the origin price down before the next swap's limit is
 * checked. This wider buffer absorbs that intra-batch drift.
 */
export const SWAP_SLIPPAGE_BUFFER = 0.02;

/** Minimum stake value — never leave a position below this (on-chain min is 0.002 TAO) */
export const MIN_STAKE_TAO = TAO / 100n; // 0.01 TAO

/** Minimum operation size — skip operations worth less than this (on-chain min is 0.002 TAO) */
export const MIN_OPERATION_TAO = TAO / 100n; // 0.01 TAO

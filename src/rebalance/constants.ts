import { parseTao } from "./tao.ts";

export { TAO } from "./tao.ts";

/** Minimum TAO value per subnet position to justify fees */
export const MIN_POSITION_TAO = parseTao(0.5);

/** Maximum number of target subnets */
export const MAX_SUBNETS = 10;

/** Free TAO to keep unreserved for transaction fees */
export const FREE_RESERVE_TAO = parseTao(0.05);

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
export const MIN_STAKE_TAO = parseTao(0.01);

/** Minimum operation size — skip operations worth less than this (on-chain min is 0.002 TAO) */
export const MIN_OPERATION_TAO = parseTao(0.01);

/** Minimum adjustment size for reductions/stakes to justify fees — exits use the lower MIN_OPERATION_TAO */
export const MIN_REBALANCE_TAO = parseTao(0.25);

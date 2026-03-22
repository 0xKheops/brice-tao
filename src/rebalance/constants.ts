export const TAO = 1_000_000_000n;

/** Minimum TAO value per subnet position to justify fees */
export const MIN_POSITION_TAO = TAO / 2n; // 0.5 TAO

/** Maximum number of target subnets */
export const MAX_SUBNETS = 10;

/** Free TAO to keep unreserved for transaction fees */
export const FREE_RESERVE_TAO = TAO / 5n; // 0.2 TAO

/** Maximum slippage on limit_price (0.2%) */
export const SLIPPAGE_FACTOR = 0.002;

/** Minimum stake value — never leave a position below this */
export const MIN_STAKE_TAO = TAO / 5n; // 0.2 TAO

/** Minimum operation size — skip operations worth less than this */
export const MIN_OPERATION_TAO = TAO / 5n; // 0.2 TAO

/** Dust threshold — never leave a position with less than this remaining */
export const DUST_THRESHOLD_TAO = TAO / 10n; // 0.1 TAO

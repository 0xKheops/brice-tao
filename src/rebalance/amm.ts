/**
 * AMM math for backtest trade simulation.
 *
 * Implements constant-product (x·y=k) swap formulas using pool reserves.
 * This is accurate for:
 * - V2 pools (direct constant product)
 * - V3 pools with only the protocol's full-range position (mathematically equivalent)
 *
 * SN0 (root network) uses the "Stable" mechanism on-chain: 1:1 TAO↔Alpha, zero fee.
 *
 * Fee is deducted from the INPUT before the swap (matching on-chain V3 behavior).
 * The fee does NOT re-enter pool reserves — it goes to the block author.
 */

/**
 * On-chain pool fee: 33 / 65535 ≈ 0.0503%.
 * Matches `FeeRate` default in pallets/swap: 33 / u16::MAX.
 */
export const POOL_FEE_NUMERATOR = 33n;
export const POOL_FEE_DENOMINATOR = 65535n; // u16::MAX

/** SN0 (root network) uses the Stable mechanism — 1:1 swap, zero fee. */
function isStableSubnet(netuid: number): boolean {
	return netuid === 0;
}

/** Ceiling division for bigints: ceil(a / b) */
function ceilDiv(a: bigint, b: bigint): bigint {
	return (a + b - 1n) / b;
}

export interface SwapResult {
	/** Amount of output token received */
	amountOut: bigint;
	/** Pool fee paid (denominated in the INPUT token) */
	poolFee: bigint;
}

/**
 * Simulate buying alpha with TAO (staking) using constant-product AMM.
 *
 * For SN0: 1:1 conversion, zero fee.
 *
 * Formula (fee on input):
 *   poolFee = taoAmount × FEE_NUM / FEE_DENOM
 *   netTao  = taoAmount − poolFee
 *   alphaOut = alphaReserve × netTao / (taoReserve + netTao)
 */
export function swapTaoForAlpha(
	taoAmount: bigint,
	taoReserve: bigint,
	alphaReserve: bigint,
	netuid: number,
): SwapResult {
	if (taoAmount <= 0n || taoReserve <= 0n || alphaReserve <= 0n) {
		return { amountOut: 0n, poolFee: 0n };
	}

	if (isStableSubnet(netuid)) {
		return { amountOut: taoAmount, poolFee: 0n };
	}

	const poolFee = (taoAmount * POOL_FEE_NUMERATOR) / POOL_FEE_DENOMINATOR;
	const netTao = taoAmount - poolFee;
	if (netTao <= 0n) {
		return { amountOut: 0n, poolFee };
	}

	const alphaOut = (alphaReserve * netTao) / (taoReserve + netTao);
	return { amountOut: alphaOut, poolFee };
}

/**
 * Simulate selling alpha for TAO (unstaking) using constant-product AMM.
 *
 * For SN0: 1:1 conversion, zero fee.
 *
 * Formula (fee on input):
 *   poolFee  = alphaAmount × FEE_NUM / FEE_DENOM   (in alpha)
 *   netAlpha = alphaAmount − poolFee
 *   taoOut   = taoReserve × netAlpha / (alphaReserve + netAlpha)
 *
 * Note: poolFee is denominated in alpha (the input token).
 */
export function swapAlphaForTao(
	alphaAmount: bigint,
	taoReserve: bigint,
	alphaReserve: bigint,
	netuid: number,
): SwapResult {
	if (alphaAmount <= 0n || taoReserve <= 0n || alphaReserve <= 0n) {
		return { amountOut: 0n, poolFee: 0n };
	}

	if (isStableSubnet(netuid)) {
		return { amountOut: alphaAmount, poolFee: 0n };
	}

	const poolFee = (alphaAmount * POOL_FEE_NUMERATOR) / POOL_FEE_DENOMINATOR;
	const netAlpha = alphaAmount - poolFee;
	if (netAlpha <= 0n) {
		return { amountOut: 0n, poolFee };
	}

	const taoOut = (taoReserve * netAlpha) / (alphaReserve + netAlpha);
	return { amountOut: taoOut, poolFee };
}

/**
 * Inverse: compute how much alpha you need to sell to receive a target TAO amount.
 *
 * For SN0: 1:1, so just returns the target amount.
 *
 * Solves the constant-product equation for alpha input:
 *   netAlpha = ceil(targetTaoOut × alphaReserve / (taoReserve − targetTaoOut))
 *   grossAlpha = ceilDiv(netAlpha × FEE_DENOM, FEE_DENOM − FEE_NUM)
 *
 * Returns `null` if targetTaoOut ≥ taoReserve (impossible — would drain the pool).
 */
export function alphaNeededForTao(
	targetTaoOut: bigint,
	taoReserve: bigint,
	alphaReserve: bigint,
	netuid: number,
): bigint | null {
	if (targetTaoOut <= 0n) return 0n;
	if (taoReserve <= 0n || alphaReserve <= 0n) return null;

	if (isStableSubnet(netuid)) {
		return targetTaoOut;
	}

	if (targetTaoOut >= taoReserve) return null;

	const netAlpha = ceilDiv(
		targetTaoOut * alphaReserve,
		taoReserve - targetTaoOut,
	);

	const grossAlpha = ceilDiv(
		netAlpha * POOL_FEE_DENOMINATOR,
		POOL_FEE_DENOMINATOR - POOL_FEE_NUMERATOR,
	);

	return grossAlpha;
}

/**
 * Compute the TAO-equivalent pool fee for an alpha→TAO swap using the output-delta
 * method: `taoOutNoFee − taoOutWithFee`.
 *
 * This avoids converting alpha fees via spot price (which would be inaccurate).
 */
export function alphaFeeInTao(
	alphaAmount: bigint,
	taoReserve: bigint,
	alphaReserve: bigint,
	netuid: number,
): bigint {
	if (isStableSubnet(netuid) || alphaAmount <= 0n) return 0n;

	const withFee = swapAlphaForTao(
		alphaAmount,
		taoReserve,
		alphaReserve,
		netuid,
	);

	// No-fee swap: full alphaAmount goes into constant product
	const taoOutNoFee =
		taoReserve > 0n && alphaReserve > 0n
			? (taoReserve * alphaAmount) / (alphaReserve + alphaAmount)
			: 0n;

	return taoOutNoFee - withFee.amountOut;
}

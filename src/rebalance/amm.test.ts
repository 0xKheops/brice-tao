import { describe, expect, test } from "bun:test";
import {
	alphaFeeInTao,
	alphaNeededForTao,
	POOL_FEE_DENOMINATOR,
	POOL_FEE_NUMERATOR,
	swapAlphaForTao,
	swapTaoForAlpha,
} from "./amm.ts";

const TAO = 1_000_000_000n;

describe("swapTaoForAlpha", () => {
	test("constant product: small trade has minimal impact", () => {
		// Pool: 1000 TAO, 10000 alpha. Buy 1 TAO worth of alpha.
		const { amountOut, poolFee } = swapTaoForAlpha(
			1n * TAO,
			1000n * TAO,
			10000n * TAO,
			1,
		);
		// At spot price (1:10), 1 TAO should give ~10 alpha.
		// With AMM: alpha = 10000 × ~1 / (1000 + ~1) ≈ 9.99 alpha (slight impact)
		expect(amountOut).toBeGreaterThan(9n * TAO);
		expect(amountOut).toBeLessThan(10n * TAO);
		// Pool fee ≈ 0.05% of 1 TAO ≈ 503,058 RAO
		expect(poolFee).toBeGreaterThan(0n);
		expect(poolFee).toBeLessThan(TAO / 1000n); // < 0.1%
	});

	test("constant product: large trade has significant impact", () => {
		// Pool: 100 TAO, 1000 alpha. Buy 50 TAO worth of alpha.
		const { amountOut } = swapTaoForAlpha(
			50n * TAO,
			100n * TAO,
			1000n * TAO,
			1,
		);
		// At spot price, 50 TAO → 500 alpha.
		// With AMM: alpha = 1000 × ~50 / (100 + ~50) ≈ 333 alpha (33% impact)
		expect(amountOut).toBeGreaterThan(300n * TAO);
		expect(amountOut).toBeLessThan(400n * TAO);
	});

	test("SN0: 1:1 conversion with zero pool fee", () => {
		const { amountOut, poolFee } = swapTaoForAlpha(
			100n * TAO,
			999n * TAO,
			999n * TAO,
			0, // SN0
		);
		expect(amountOut).toBe(100n * TAO);
		expect(poolFee).toBe(0n);
	});

	test("zero inputs return zero", () => {
		expect(swapTaoForAlpha(0n, 100n * TAO, 100n * TAO, 1).amountOut).toBe(0n);
		expect(swapTaoForAlpha(1n * TAO, 0n, 100n * TAO, 1).amountOut).toBe(0n);
		expect(swapTaoForAlpha(1n * TAO, 100n * TAO, 0n, 1).amountOut).toBe(0n);
	});

	test("dust amount where fee eats everything", () => {
		// Amount so small that fee rounds to the full amount
		const { amountOut } = swapTaoForAlpha(1n, 100n * TAO, 100n * TAO, 1);
		// Fee = 1 × 33 / 65535 = 0 (rounds down), so netTao = 1
		// alphaOut = 100e9 × 1 / (100e9 + 1) ≈ 1
		expect(amountOut).toBeLessThanOrEqual(1n);
	});

	test("fee matches expected ratio", () => {
		const amount = 1_000_000n * TAO;
		const { poolFee } = swapTaoForAlpha(amount, 1000n * TAO, 1000n * TAO, 1);
		const expectedFee = (amount * POOL_FEE_NUMERATOR) / POOL_FEE_DENOMINATOR;
		expect(poolFee).toBe(expectedFee);
	});

	test("skipFee: no fee deducted, more alpha out", () => {
		const tao = 100n * TAO;
		const taoR = 10_000n * TAO;
		const alphaR = 500_000n * TAO;
		const withFee = swapTaoForAlpha(tao, taoR, alphaR, 1);
		const noFee = swapTaoForAlpha(tao, taoR, alphaR, 1, true);
		expect(noFee.poolFee).toBe(0n);
		expect(noFee.amountOut).toBeGreaterThan(withFee.amountOut);
		// Full tao enters pool → alphaOut = alphaR * tao / (taoR + tao)
		const expected = (alphaR * tao) / (taoR + tao);
		expect(noFee.amountOut).toBe(expected);
	});
});

describe("swapAlphaForTao", () => {
	test("constant product: small trade", () => {
		// Pool: 1000 TAO, 10000 alpha. Sell 10 alpha.
		const { amountOut } = swapAlphaForTao(
			10n * TAO,
			1000n * TAO,
			10000n * TAO,
			1,
		);
		// At spot price (10:1), 10 alpha ≈ 1 TAO.
		// With AMM: tao = 1000 × ~10 / (10000 + ~10) ≈ 0.999 TAO
		expect(amountOut).toBeGreaterThan(0n);
		expect(amountOut).toBeLessThan(1n * TAO);
	});

	test("constant product: large trade has significant impact", () => {
		// Pool: 100 TAO, 100 alpha. Sell 50 alpha.
		const { amountOut } = swapAlphaForTao(50n * TAO, 100n * TAO, 100n * TAO, 1);
		// At spot (1:1), 50 alpha → 50 TAO.
		// With AMM: tao = 100 × ~50 / (100 + ~50) ≈ 33 TAO
		expect(amountOut).toBeGreaterThan(30n * TAO);
		expect(amountOut).toBeLessThan(40n * TAO);
	});

	test("SN0: 1:1 conversion with zero pool fee", () => {
		const { amountOut, poolFee } = swapAlphaForTao(
			50n * TAO,
			999n * TAO,
			999n * TAO,
			0, // SN0
		);
		expect(amountOut).toBe(50n * TAO);
		expect(poolFee).toBe(0n);
	});

	test("zero inputs return zero", () => {
		expect(swapAlphaForTao(0n, 100n * TAO, 100n * TAO, 1).amountOut).toBe(0n);
		expect(swapAlphaForTao(1n * TAO, 0n, 100n * TAO, 1).amountOut).toBe(0n);
		expect(swapAlphaForTao(1n * TAO, 100n * TAO, 0n, 1).amountOut).toBe(0n);
	});

	test("reserve invariant: k only decreases (fee removed)", () => {
		const taoRes = 500n * TAO;
		const alphaRes = 2000n * TAO;
		const sellAmount = 100n * TAO;

		const kBefore = taoRes * alphaRes;

		const result = swapAlphaForTao(sellAmount, taoRes, alphaRes, 1);
		const netAlpha =
			sellAmount - (sellAmount * POOL_FEE_NUMERATOR) / POOL_FEE_DENOMINATOR;

		const newTaoRes = taoRes - result.amountOut;
		const newAlphaRes = alphaRes + netAlpha;

		// k should stay the same or decrease (fee removed from system)
		expect(newTaoRes * newAlphaRes).toBeGreaterThanOrEqual(kBefore);
	});
});

describe("alphaNeededForTao", () => {
	test("inverse roundtrip: needed alpha produces target TAO", () => {
		const taoRes = 1000n * TAO;
		const alphaRes = 5000n * TAO;
		const targetTao = 10n * TAO;

		const needed = alphaNeededForTao(targetTao, taoRes, alphaRes, 1);
		expect(needed).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		const { amountOut } = swapAlphaForTao(needed!, taoRes, alphaRes, 1);
		// Due to ceiling division, output should be ≥ target
		expect(amountOut).toBeGreaterThanOrEqual(targetTao);
		// But not excessively more (within 1 RAO tolerance from ceiling)
		expect(amountOut - targetTao).toBeLessThan(TAO / 100n);
	});

	test("returns null when target ≥ pool reserve", () => {
		const taoRes = 100n * TAO;
		const alphaRes = 100n * TAO;
		expect(alphaNeededForTao(100n * TAO, taoRes, alphaRes, 1)).toBeNull();
		expect(alphaNeededForTao(200n * TAO, taoRes, alphaRes, 1)).toBeNull();
	});

	test("SN0: returns target amount directly", () => {
		const needed = alphaNeededForTao(50n * TAO, 100n * TAO, 100n * TAO, 0);
		expect(needed).toBe(50n * TAO);
	});

	test("returns 0 for zero target", () => {
		expect(alphaNeededForTao(0n, 100n * TAO, 100n * TAO, 1)).toBe(0n);
	});

	test("returns null for zero reserves", () => {
		expect(alphaNeededForTao(10n * TAO, 0n, 100n * TAO, 1)).toBeNull();
		expect(alphaNeededForTao(10n * TAO, 100n * TAO, 0n, 1)).toBeNull();
	});
});

describe("alphaFeeInTao", () => {
	test("fee is positive for dynamic subnets", () => {
		const fee = alphaFeeInTao(100n * TAO, 1000n * TAO, 5000n * TAO, 1);
		expect(fee).toBeGreaterThan(0n);
	});

	test("pool fee is zero for SN0", () => {
		const fee = alphaFeeInTao(100n * TAO, 1000n * TAO, 5000n * TAO, 0);
		expect(fee).toBe(0n);
	});

	test("fee is zero for zero amount", () => {
		const fee = alphaFeeInTao(0n, 1000n * TAO, 5000n * TAO, 1);
		expect(fee).toBe(0n);
	});

	test("fee is proportional to trade size", () => {
		const fee1 = alphaFeeInTao(10n * TAO, 1000n * TAO, 5000n * TAO, 1);
		const fee10 = alphaFeeInTao(100n * TAO, 1000n * TAO, 5000n * TAO, 1);
		// Larger trade → larger fee (not exactly 10× due to price impact)
		expect(fee10).toBeGreaterThan(fee1);
	});
});

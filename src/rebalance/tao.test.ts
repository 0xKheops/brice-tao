import { describe, expect, it } from "bun:test";
import { parseTao, TAO } from "./tao.ts";

describe("parseTao", () => {
	it("converts human-readable TAO values to RAO", () => {
		expect(parseTao(0)).toBe(0n);
		expect(parseTao(1)).toBe(TAO);
		expect(parseTao(0.5)).toBe(500_000_000n);
		expect(parseTao(0.05)).toBe(50_000_000n);
		expect(parseTao(1.25)).toBe(1_250_000_000n);
		expect(parseTao(0.000000001)).toBe(1n);
	});

	it("supports scientific notation within RAO precision", () => {
		expect(parseTao(1e-9)).toBe(1n);
		expect(parseTao(2.5e-1)).toBe(250_000_000n);
		expect(parseTao(1e3)).toBe(1_000n * TAO);
	});

	it("throws on more than 9 decimal places", () => {
		expect(() => parseTao(0.0000000001)).toThrow("max precision is 9");
		expect(() => parseTao(1.0000000001)).toThrow("max precision is 9");
	});

	it("throws on invalid numeric inputs", () => {
		expect(() => parseTao(Number.NaN)).toThrow("must be finite");
		expect(() => parseTao(Number.POSITIVE_INFINITY)).toThrow("must be finite");
		expect(() => parseTao(Number.NEGATIVE_INFINITY)).toThrow("must be finite");
		expect(() => parseTao(-0.1)).toThrow("must be non-negative");
	});
});

import { describe, expect, it } from "bun:test";
import {
	FREE_RESERVE_TAO,
	MAX_SUBNETS,
	MIN_OPERATION_TAO,
	MIN_POSITION_TAO,
	MIN_REBALANCE_TAO,
	MIN_STAKE_TAO,
	SLIPPAGE_BUFFER,
	SWAP_SLIPPAGE_BUFFER,
	TAO,
} from "./constants.ts";

describe("rebalance constants", () => {
	it("keeps TAO conversion and minimum thresholds consistent", () => {
		expect(TAO).toBe(1_000_000_000n);
		expect(MIN_POSITION_TAO).toBe(TAO / 2n);
		expect(FREE_RESERVE_TAO).toBe(TAO / 20n);
		expect(MIN_STAKE_TAO).toBe(TAO / 100n);
		expect(MIN_OPERATION_TAO).toBe(TAO / 100n);
		expect(MIN_REBALANCE_TAO).toBe(TAO / 4n);
	});

	it("uses safe ordering for operational amounts", () => {
		expect(MIN_POSITION_TAO).toBeGreaterThan(MIN_STAKE_TAO);
		expect(MIN_REBALANCE_TAO).toBeGreaterThanOrEqual(MIN_OPERATION_TAO);
		expect(MIN_POSITION_TAO).toBeGreaterThanOrEqual(MIN_REBALANCE_TAO);
		expect(MIN_STAKE_TAO).toBe(MIN_OPERATION_TAO);
		expect(FREE_RESERVE_TAO).toBeGreaterThan(0n);
		expect(MAX_SUBNETS).toBeGreaterThan(0);
	});

	it("defines slippage buffers in sane ranges", () => {
		expect(SLIPPAGE_BUFFER).toBeGreaterThan(0);
		expect(SWAP_SLIPPAGE_BUFFER).toBeGreaterThan(0);
		expect(SWAP_SLIPPAGE_BUFFER).toBeGreaterThan(SLIPPAGE_BUFFER);
		expect(SWAP_SLIPPAGE_BUFFER).toBeLessThan(0.1);
	});
});

import { describe, expect, it } from "bun:test";
import { loadConfig } from "../config/loadConfig.ts";
import type { AppConfig } from "../config/types.ts";
import { parseTao } from "./tao.ts";

describe("config loading and validation", () => {
	const configPath = new URL("../config.yaml", import.meta.url).pathname;
	let config: AppConfig;

	it("loads the default config.yaml successfully", () => {
		config = loadConfig(configPath);
		expect(config).toBeDefined();
		expect(config.rebalance).toBeDefined();
		expect(config.strategy).toBeDefined();
	});

	it("resolves TAO amounts to RAO bigints", () => {
		config = loadConfig(configPath);
		expect(config.rebalance.minPositionTao).toBe(parseTao(0.5));
		expect(config.rebalance.freeReserveTao).toBe(parseTao(0.05));
		expect(config.rebalance.minStakeTao).toBe(parseTao(0.01));
		expect(config.rebalance.minOperationTao).toBe(parseTao(0.01));
		expect(config.rebalance.minRebalanceTao).toBe(parseTao(0.25));
	});

	it("converts percent slippage to decimal fractions", () => {
		config = loadConfig(configPath);
		expect(config.rebalance.slippageBuffer).toBeCloseTo(0.01, 6);
		expect(config.rebalance.swapSlippageBuffer).toBeCloseTo(0.02, 6);
	});

	it("uses safe ordering for operational amounts", () => {
		config = loadConfig(configPath);
		expect(config.rebalance.minPositionTao).toBeGreaterThan(
			config.rebalance.minStakeTao,
		);
		expect(config.rebalance.minRebalanceTao).toBeGreaterThanOrEqual(
			config.rebalance.minOperationTao,
		);
		expect(config.rebalance.minPositionTao).toBeGreaterThanOrEqual(
			config.rebalance.minRebalanceTao,
		);
		expect(config.rebalance.freeReserveTao).toBeGreaterThan(0n);
		expect(config.strategy.maxSubnets).toBeGreaterThan(0);
	});

	it("keeps slippage buffers in sane ranges", () => {
		config = loadConfig(configPath);
		expect(config.rebalance.slippageBuffer).toBeGreaterThan(0);
		expect(config.rebalance.swapSlippageBuffer).toBeGreaterThan(0);
		expect(config.rebalance.swapSlippageBuffer).toBeGreaterThan(
			config.rebalance.slippageBuffer,
		);
		expect(config.rebalance.swapSlippageBuffer).toBeLessThan(0.1);
	});

	it("throws on missing config file", () => {
		expect(() => loadConfig("/nonexistent/path.yaml")).toThrow(
			/Config file not found/,
		);
	});

	it("throws on invalid YAML values", () => {
		const tmpPath = `/tmp/brice-tao-test-config-${Date.now()}.yaml`;
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		writeFileSync(
			tmpPath,
			[
				"rebalance:",
				"  minPositionTao: 0.5",
				"  freeReserveTao: 0.05",
				"  minOperationTao: 0.01",
				"  minStakeTao: 0.01",
				"  minRebalanceTao: 0.25",
				"  slippageBufferPercent: 0.3",
				"  swapSlippageBufferPercent: 2",
				"strategy:",
				"  minScore: 70",
				"  minVolumeTao: 100",
				"  minMcapTao: 0",
				"  minHolders: 500",
				"  minEmissionPct: 0",
				"  bottomPercentileCutoff: 10",
				"  incumbencyBonus: 3",
				"  maxSubnets: -1",
			].join("\n"),
		);
		expect(() => loadConfig(tmpPath)).toThrow(
			/must be (non-negative|a positive integer)/,
		);
	});
});

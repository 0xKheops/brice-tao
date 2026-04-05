import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../../errors.ts";
import { parseTao } from "../../rebalance/tao.ts";
import { loadCopyTradeConfig } from "./config.ts";

const CONFIG_PATH = new URL("./config.yaml", import.meta.url).pathname;
const VALID_LEADER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("copy-trade config loading and validation", () => {
	it("loads the default config.yaml successfully", () => {
		const config = loadCopyTradeConfig(CONFIG_PATH, VALID_LEADER);
		expect(config).toBeDefined();
		expect(config.rebalance).toBeDefined();
		expect(config.strategy).toBeDefined();
		expect(config.staleTimeoutMinutes).toBeGreaterThan(0);
	});

	it("resolves TAO amounts to RAO bigints", () => {
		const config = loadCopyTradeConfig(CONFIG_PATH, VALID_LEADER);
		expect(config.rebalance.minPositionTao).toBe(parseTao(0.5));
		expect(config.rebalance.freeReserveTao).toBe(parseTao(0.1));
		expect(config.rebalance.minStakeTao).toBe(parseTao(0.01));
		expect(config.rebalance.minOperationTao).toBe(parseTao(0.01));
		expect(config.rebalance.minRebalanceTao).toBe(parseTao(0.1));
	});

	it("converts percent slippage to decimal fractions", () => {
		const config = loadCopyTradeConfig(CONFIG_PATH, VALID_LEADER);
		expect(config.rebalance.slippageBuffer).toBeCloseTo(0.02, 6);
		expect(config.rebalance.freeReserveTaoDriftPercent).toBeCloseTo(0.05, 6);
		expect(config.rebalance.allocationDriftPercent).toBeCloseTo(0.25, 6);
	});

	it("uses env leader address override", () => {
		const override = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
		const config = loadCopyTradeConfig(CONFIG_PATH, override);
		expect(config.strategy.leaderAddress).toBe(override);
	});

	it("throws ConfigError when leader address is missing", () => {
		// config.yaml has leaderAddress: "" and no env override
		expect(() => loadCopyTradeConfig(CONFIG_PATH)).toThrow(ConfigError);
		expect(() => loadCopyTradeConfig(CONFIG_PATH)).toThrow(/leaderAddress/);
	});

	it("throws ConfigError for non-string leaderAddress in YAML", () => {
		const tmpPath = join(import.meta.dirname ?? ".", "__test_bad_leader.yaml");
		writeFileSync(
			tmpPath,
			`staleTimeoutMinutes: 10
rebalance:
  minPositionTao: 0.5
  freeReserveTao: 0.1
  freeReserveTaoDriftPercent: 5
  minOperationTao: 0.01
  minStakeTao: 0.01
  minRebalanceTao: 0.1
  slippageBufferPercent: 2
  enforceSlippage: false
  allocationDriftPercent: 25
strategy:
  leaderAddress: 12345
`,
		);
		try {
			expect(() => loadCopyTradeConfig(tmpPath)).toThrow(ConfigError);
			expect(() => loadCopyTradeConfig(tmpPath)).toThrow(/leaderAddress/);
		} finally {
			rmSync(tmpPath, { force: true });
		}
	});

	it("throws ConfigError for missing config file", () => {
		expect(() =>
			loadCopyTradeConfig("/nonexistent/path.yaml", VALID_LEADER),
		).toThrow(ConfigError);
		expect(() =>
			loadCopyTradeConfig("/nonexistent/path.yaml", VALID_LEADER),
		).toThrow(/Config file not found/);
	});
});

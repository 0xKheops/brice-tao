import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigError } from "../errors.ts";
import { parseTao } from "../rebalance/tao.ts";
import type { AppConfig, RawConfig } from "./types.ts";

export function loadConfig(path: string): AppConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		throw new ConfigError(
			`Config file not found: ${path}. A config.yaml is required to run.`,
		);
	}

	let raw: unknown;
	try {
		raw = parse(text);
	} catch (err) {
		throw new ConfigError(
			`Failed to parse YAML config: ${err instanceof Error ? err.message : err}`,
		);
	}

	return resolveConfig(validateRawConfig(raw));
}

function validateRawConfig(raw: unknown): RawConfig {
	if (!raw || typeof raw !== "object") {
		throw new ConfigError("Config must be a YAML object");
	}

	const obj = raw as Record<string, unknown>;

	const rebalance = requireSection(obj, "rebalance");
	const strategy = requireSection(obj, "strategy");

	return {
		rebalance: {
			maxSubnets: requirePositiveInt(rebalance, "maxSubnets"),
			minPositionTao: requireNonNegativeNumber(rebalance, "minPositionTao"),
			freeReserveTao: requireNonNegativeNumber(rebalance, "freeReserveTao"),
			minOperationTao: requireNonNegativeNumber(rebalance, "minOperationTao"),
			minStakeTao: requireNonNegativeNumber(rebalance, "minStakeTao"),
			minRebalanceTao: requireNonNegativeNumber(rebalance, "minRebalanceTao"),
			slippageBufferPercent: requireNonNegativeNumber(
				rebalance,
				"slippageBufferPercent",
			),
			swapSlippageBufferPercent: requireNonNegativeNumber(
				rebalance,
				"swapSlippageBufferPercent",
			),
			incumbencyBonus: requireNonNegativeNumber(rebalance, "incumbencyBonus"),
		},
		strategy: {
			minScore: requireNonNegativeNumber(strategy, "minScore"),
			minVolumeTao: requireNonNegativeNumber(strategy, "minVolumeTao"),
			minMcapTao: requireNonNegativeNumber(strategy, "minMcapTao"),
			minHolders: requireNonNegativeNumber(strategy, "minHolders"),
			minEmissionPct: requireNonNegativeNumber(strategy, "minEmissionPct"),
			bottomPercentileCutoff: requireNonNegativeNumber(
				strategy,
				"bottomPercentileCutoff",
			),
		},
	};
}

function resolveConfig(raw: RawConfig): AppConfig {
	return {
		rebalance: {
			maxSubnets: raw.rebalance.maxSubnets,
			minPositionTao: parseTao(raw.rebalance.minPositionTao),
			freeReserveTao: parseTao(raw.rebalance.freeReserveTao),
			minOperationTao: parseTao(raw.rebalance.minOperationTao),
			minStakeTao: parseTao(raw.rebalance.minStakeTao),
			minRebalanceTao: parseTao(raw.rebalance.minRebalanceTao),
			slippageBuffer: raw.rebalance.slippageBufferPercent / 100,
			swapSlippageBuffer: raw.rebalance.swapSlippageBufferPercent / 100,
			incumbencyBonus: raw.rebalance.incumbencyBonus,
		},
		strategy: { ...raw.strategy },
	};
}

// --- Validation helpers ---

function requireSection(
	obj: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	const value = obj[key];
	if (!value || typeof value !== "object") {
		throw new ConfigError(`Config missing required section: "${key}"`);
	}
	return value as Record<string, unknown>;
}

function requireNonNegativeNumber(
	section: Record<string, unknown>,
	key: string,
): number {
	const value = section[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ConfigError(
			`Config "${key}" must be a finite number, got: ${JSON.stringify(value)}`,
		);
	}
	if (value < 0) {
		throw new ConfigError(
			`Config "${key}" must be non-negative, got: ${value}`,
		);
	}
	return value;
}

function requirePositiveInt(
	section: Record<string, unknown>,
	key: string,
): number {
	const value = requireNonNegativeNumber(section, key);
	if (!Number.isInteger(value) || value < 1) {
		throw new ConfigError(
			`Config "${key}" must be a positive integer, got: ${value}`,
		);
	}
	return value;
}

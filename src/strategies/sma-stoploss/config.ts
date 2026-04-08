import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigError } from "../../errors.ts";
import { parseTao } from "../../rebalance/tao.ts";
import type { RebalanceConfig } from "../../rebalance/types.ts";
import type { BlockIntervalConfig } from "../../scheduling/types.ts";
import type {
	RawSmaStoplossConfig,
	SmaStoplossStrategyConfig,
} from "./types.ts";

export interface SmaStoplossAppConfig {
	schedule: BlockIntervalConfig;
	rebalance: RebalanceConfig;
	strategy: SmaStoplossStrategyConfig;
}

export function loadSmaStoplossConfig(path: string): SmaStoplossAppConfig {
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

function validateRawConfig(raw: unknown): RawSmaStoplossConfig {
	if (!raw || typeof raw !== "object") {
		throw new ConfigError("Config must be a YAML object");
	}

	const obj = raw as Record<string, unknown>;

	const rebalanceIntervalBlocks = requirePositiveInt(
		obj,
		"rebalanceIntervalBlocks",
	);
	const staleTimeoutBlocks = requirePositiveInt(obj, "staleTimeoutBlocks");

	const rebalance = requireSection(obj, "rebalance");
	const strategy = requireSection(obj, "strategy");

	// Scoring weights must sum to 100
	const momentumWeight = requireNonNegativeInt(strategy, "momentumWeight");
	const emissionWeight = requireNonNegativeInt(strategy, "emissionWeight");
	if (momentumWeight + emissionWeight !== 100) {
		throw new ConfigError(
			`momentumWeight (${momentumWeight}) + emissionWeight (${emissionWeight}) must equal 100`,
		);
	}

	// SMA fast must be less than slow
	const smaFastPeriod = requirePositiveInt(strategy, "smaFastPeriod");
	const smaSlowPeriod = requirePositiveInt(strategy, "smaSlowPeriod");
	if (smaFastPeriod >= smaSlowPeriod) {
		throw new ConfigError(
			`smaFastPeriod (${smaFastPeriod}) must be less than smaSlowPeriod (${smaSlowPeriod})`,
		);
	}

	// maxPriceSamples must be >= smaSlowPeriod
	const maxPriceSamples = requirePositiveInt(strategy, "maxPriceSamples");
	if (maxPriceSamples < smaSlowPeriod) {
		throw new ConfigError(
			`maxPriceSamples (${maxPriceSamples}) must be >= smaSlowPeriod (${smaSlowPeriod})`,
		);
	}

	return {
		schedule: {
			rebalanceIntervalBlocks,
			staleTimeoutBlocks,
		},
		rebalance: {
			minPositionTao: requireNonNegativeNumber(rebalance, "minPositionTao"),
			freeReserveTao: requireNonNegativeNumber(rebalance, "freeReserveTao"),
			freeReserveTaoDriftPercent: requireNonNegativeNumber(
				rebalance,
				"freeReserveTaoDriftPercent",
			),
			minOperationTao: requireNonNegativeNumber(rebalance, "minOperationTao"),
			minStakeTao: requireNonNegativeNumber(rebalance, "minStakeTao"),
			minRebalanceTao: requireNonNegativeNumber(rebalance, "minRebalanceTao"),
			slippageBufferPercent: requireNonNegativeNumber(
				rebalance,
				"slippageBufferPercent",
			),
			enforceSlippage: optionalBoolean(rebalance, "enforceSlippage", false),
			allocationDriftPercent: optionalBoundedNumber(
				rebalance,
				"allocationDriftPercent",
				25,
				0,
				50,
			),
		},
		strategy: {
			maxSubnets: requirePositiveInt(strategy, "maxSubnets"),
			minTaoIn: requireNonNegativeInt(strategy, "minTaoIn"),
			minSubnetAgeDays: requireNonNegativeInt(strategy, "minSubnetAgeDays"),
			incumbencyBonus: requireNonNegativeInt(strategy, "incumbencyBonus"),
			smaFastPeriod,
			smaSlowPeriod,
			maxPriceSamples,
			momentumWeight,
			emissionWeight,
			stopLossPercent: requirePercent(strategy, "stopLossPercent"),
			cooldownBlocks: requirePositiveInt(strategy, "cooldownBlocks"),
		},
	};
}

function resolveConfig(raw: RawSmaStoplossConfig): SmaStoplossAppConfig {
	return {
		schedule: raw.schedule,
		rebalance: {
			minPositionTao: parseTao(raw.rebalance.minPositionTao),
			freeReserveTao: parseTao(raw.rebalance.freeReserveTao),
			freeReserveTaoDriftPercent:
				raw.rebalance.freeReserveTaoDriftPercent / 100,
			minOperationTao: parseTao(raw.rebalance.minOperationTao),
			minStakeTao: parseTao(raw.rebalance.minStakeTao),
			minRebalanceTao: parseTao(raw.rebalance.minRebalanceTao),
			slippageBuffer: raw.rebalance.slippageBufferPercent / 100,
			enforceSlippage: raw.rebalance.enforceSlippage,
			allocationDriftPercent: raw.rebalance.allocationDriftPercent / 100,
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

function optionalBoundedNumber(
	section: Record<string, unknown>,
	key: string,
	defaultValue: number,
	min: number,
	max: number,
): number {
	if (section[key] === undefined) return defaultValue;
	const value = requireNonNegativeNumber(section, key);
	if (value < min || value > max) {
		throw new ConfigError(
			`Config "${key}" must be between ${min} and ${max}, got: ${value}`,
		);
	}
	return value;
}

function requireNonNegativeInt(
	section: Record<string, unknown>,
	key: string,
): number {
	const value = requireNonNegativeNumber(section, key);
	if (!Number.isInteger(value)) {
		throw new ConfigError(`Config "${key}" must be an integer, got: ${value}`);
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

function optionalBoolean(
	section: Record<string, unknown>,
	key: string,
	defaultValue: boolean,
): boolean {
	const value = section[key];
	if (value === undefined) return defaultValue;
	if (typeof value !== "boolean") {
		throw new ConfigError(
			`Config "${key}" must be a boolean, got: ${JSON.stringify(value)}`,
		);
	}
	return value;
}

function requirePercent(section: Record<string, unknown>, key: string): number {
	const value = requireNonNegativeNumber(section, key);
	if (value > 100) {
		throw new ConfigError(
			`Config "${key}" must be between 0 and 100, got: ${value}`,
		);
	}
	return value;
}

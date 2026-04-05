import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigError } from "../../errors.ts";
import { parseTao } from "../../rebalance/tao.ts";
import type { RebalanceConfig } from "../../rebalance/types.ts";
import type { CronScheduleConfig } from "../../scheduling/types.ts";
import type {
	RawRootEmissionConfig,
	RootEmissionStrategyConfig,
} from "./types.ts";

export interface RootEmissionAppConfig {
	schedule: CronScheduleConfig;
	rebalance: RebalanceConfig;
	strategy: RootEmissionStrategyConfig;
}

export function loadRootEmissionConfig(path: string): RootEmissionAppConfig {
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

function validateRawConfig(raw: unknown): RawRootEmissionConfig {
	if (!raw || typeof raw !== "object") {
		throw new ConfigError("Config must be a YAML object");
	}

	const obj = raw as Record<string, unknown>;

	const cronSchedule = requireNonEmptyString(
		obj as Record<string, unknown>,
		"cronSchedule",
	);
	const staleTimeoutMinutes = requirePositiveInt(
		obj as Record<string, unknown>,
		"staleTimeoutMinutes",
	);

	const rebalance = requireSection(obj, "rebalance");
	const strategy = requireSection(obj, "strategy");

	const rootSharePct = requireNonNegativeInt(strategy, "rootSharePct");
	if (rootSharePct < 1 || rootSharePct > 99) {
		throw new ConfigError(
			`Config "rootSharePct" must be between 1 and 99, got: ${rootSharePct}`,
		);
	}

	return {
		schedule: {
			cronSchedule,
			staleTimeoutMinutes,
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
			rootSharePct,
			minTaoIn: requireNonNegativeInt(strategy, "minTaoIn"),
			minSubnetAgeDays: requireNonNegativeInt(strategy, "minSubnetAgeDays"),
			incumbencyBonus: requireNonNegativeInt(strategy, "incumbencyBonus"),
		},
	};
}

function resolveConfig(raw: RawRootEmissionConfig): RootEmissionAppConfig {
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

function requireNonEmptyString(
	section: Record<string, unknown>,
	key: string,
): string {
	const value = section[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ConfigError(
			`Config "${key}" must be a non-empty string, got: ${JSON.stringify(value)}`,
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

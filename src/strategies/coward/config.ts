import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigError } from "../../errors.ts";
import { parseTao } from "../../rebalance/tao.ts";
import type { RebalanceConfig } from "../../rebalance/types.ts";
import type { CronScheduleConfig } from "../../scheduling/types.ts";
import type { RawCowardConfig } from "./types.ts";

export interface CowardAppConfig {
	schedule: CronScheduleConfig;
	rebalance: RebalanceConfig;
}

export function loadCowardConfig(path: string): CowardAppConfig {
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

function validateRawConfig(raw: unknown): RawCowardConfig {
	if (!raw || typeof raw !== "object") {
		throw new ConfigError("Config must be a YAML object");
	}

	const obj = raw as Record<string, unknown>;

	const cronSchedule = requireNonEmptyString(obj, "cronSchedule");
	const staleTimeoutMinutes = requirePositiveInt(obj, "staleTimeoutMinutes");

	const rebalance = requireSection(obj, "rebalance");

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
	};
}

function resolveConfig(raw: RawCowardConfig): CowardAppConfig {
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

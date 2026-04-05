import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigError } from "../../errors.ts";
import { parseTao } from "../../rebalance/tao.ts";
import type { RebalanceConfig } from "../../rebalance/types.ts";
import type { CopyTradeConfig, RawCopyTradeConfig } from "./types.ts";

export interface CopyTradeAppConfig {
	staleTimeoutMinutes: number;
	rebalance: RebalanceConfig;
	strategy: CopyTradeConfig;
}

export function loadCopyTradeConfig(
	path: string,
	envLeaderAddress?: string,
): CopyTradeAppConfig {
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

	return resolveConfig(validateRawConfig(raw, envLeaderAddress));
}

function validateRawConfig(
	raw: unknown,
	envLeaderAddress?: string,
): RawCopyTradeConfig {
	if (!raw || typeof raw !== "object") {
		throw new ConfigError("Config must be a YAML object");
	}

	const obj = raw as Record<string, unknown>;

	const staleTimeoutMinutes = requirePositiveInt(
		obj as Record<string, unknown>,
		"staleTimeoutMinutes",
	);

	const rebalance = requireSection(obj, "rebalance");
	const strategy = requireSection(obj, "strategy");

	const envTrimmed = envLeaderAddress?.trim() || undefined;
	const rawLeader = envTrimmed ?? strategy.leaderAddress ?? "";
	const leaderAddress = typeof rawLeader === "string" ? rawLeader.trim() : "";

	if (typeof leaderAddress !== "string" || leaderAddress.length === 0) {
		throw new ConfigError(
			'Config "leaderAddress" must be a non-empty string. Set via LEADER_ADDRESS env var or in config.yaml.',
		);
	}

	return {
		staleTimeoutMinutes,
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
			leaderAddress,
		},
	};
}

function resolveConfig(raw: RawCopyTradeConfig): CopyTradeAppConfig {
	return {
		staleTimeoutMinutes: raw.staleTimeoutMinutes,
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
		strategy: {
			leaderAddress: raw.strategy.leaderAddress,
		},
	};
}

// --- Validation helpers (self-contained per strategy architecture) ---

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

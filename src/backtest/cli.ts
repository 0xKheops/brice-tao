import { DB_HISTORY_BLOCK_INTERVAL } from "../history/constants.ts";
import {
	formatStrategyList,
	resolveStrategySelection,
} from "../strategies/loader.ts";
import type { BacktestSchedule, StrategyModule } from "../strategies/types.ts";

const DEFAULT_INITIAL_TAO = 10;

export interface BacktestCliOptions {
	strategyName: string;
	initialTao: number;
	days?: number;
	intervalBlocks?: number;
	cron?: string;
	observeGap?: number;
	backfill: boolean;
	exportCsv: boolean;
	exportTrades: boolean;
}

export type BacktestCliParseResult =
	| { kind: "list"; message: string }
	| { kind: "run"; options: BacktestCliOptions };

export function parseBacktestCliArgs(
	argv: string[],
	envStrategy: string | undefined,
): BacktestCliParseResult {
	const selection = resolveStrategySelection({ argv, envStrategy });
	if (selection.kind === "list") {
		return { kind: "list", message: formatStrategyList(selection.available) };
	}

	const intervalBlocks = argv.includes("--interval-blocks")
		? parseIntArg(argv, "--interval-blocks")
		: undefined;
	const cron = parseStringArg(argv, "--cron");
	if (intervalBlocks !== undefined && cron !== undefined) {
		throw new Error("Cannot specify both --interval-blocks and --cron");
	}

	return {
		kind: "run",
		options: {
			strategyName: selection.name,
			initialTao: parseIntArg(argv, "--initial-tao", DEFAULT_INITIAL_TAO),
			days: argv.includes("--days") ? parseIntArg(argv, "--days") : undefined,
			intervalBlocks,
			cron,
			observeGap: argv.includes("--observe-gap")
				? parseIntArg(argv, "--observe-gap")
				: undefined,
			backfill: argv.includes("--backfill"),
			exportCsv: argv.includes("--export-csv"),
			exportTrades: argv.includes("--export-trades"),
		},
	};
}

export function resolveBacktestSchedule(
	options: BacktestCliOptions,
	strategyModule: StrategyModule,
): BacktestSchedule {
	let schedule: BacktestSchedule;
	if (options.cron) {
		schedule = { type: "cron", cronSchedule: options.cron };
	} else if (options.intervalBlocks !== undefined) {
		schedule = {
			type: "block-interval",
			intervalBlocks: options.intervalBlocks,
		};
	} else if (strategyModule.getBacktestSchedule) {
		schedule = strategyModule.getBacktestSchedule();
	} else {
		throw new Error(
			'Strategy has no getBacktestSchedule() — provide "--interval-blocks" or "--cron"',
		);
	}

	if (
		schedule.type === "block-interval" &&
		schedule.intervalBlocks % DB_HISTORY_BLOCK_INTERVAL !== 0
	) {
		throw new Error(
			`--interval-blocks (${schedule.intervalBlocks}) must be a multiple of BLOCK_INTERVAL (${DB_HISTORY_BLOCK_INTERVAL}) for history DB alignment`,
		);
	}

	return schedule;
}

function parseIntArg(argv: string[], flag: string, fallback?: number): number {
	const raw = parseStringArg(argv, flag);
	if (raw === undefined) {
		if (fallback === undefined) {
			throw new Error(`${flag} requires a numeric value`);
		}
		return fallback;
	}

	const value = Number.parseInt(raw, 10);
	if (Number.isNaN(value) || value <= 0) {
		throw new Error(`${flag} must be a positive integer, got: ${raw}`);
	}
	return value;
}

function parseStringArg(argv: string[], flag: string): string | undefined {
	const idx = argv.indexOf(flag);
	if (idx === -1) return undefined;

	const raw = argv[idx + 1];
	if (!raw || raw.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}

	return raw;
}

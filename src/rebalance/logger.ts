import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GIT_COMMIT } from "../version.ts";
import { formatTao } from "./tao.ts";

const LOGS_ROOT = join(process.cwd(), "logs");
const ENABLE_TEST_TERMINAL_LOGS = false;
const IS_TEST_ENV =
	process.env.NODE_ENV === "test" ||
	process.env.VITEST === "true" ||
	process.env.BUN_TEST === "1";
const TERMINAL_LOGGING_ENABLED = !IS_TEST_ENV || ENABLE_TEST_TERMINAL_LOGS;
const FILE_LOGGING_ENABLED =
	process.env.NODE_ENV !== "test" &&
	process.env.VITEST !== "true" &&
	process.env.DISABLE_FILE_LOGS !== "1";

let LOG_FILE: string | undefined;

function initLogFile(subdir: string): void {
	if (!FILE_LOGGING_ENABLED) return;
	const logDir = join(LOGS_ROOT, subdir);
	mkdirSync(logDir, { recursive: true });
	LOG_FILE = join(
		logDir,
		`rebalance-${new Date().toISOString().replace(/[:.]/g, "-")}-${GIT_COMMIT}.log`,
	);
}

interface LogData {
	[key: string]: unknown;
}

interface JsonLogEntry {
	timestamp: string;
	level: string;
	commit: string;
	message: string;
	data?: LogData;
	error?: { name: string; message: string; stack?: string; code?: string };
}

function writeToFile(
	level: string,
	message: string,
	data?: LogData,
	err?: unknown,
): void {
	if (!FILE_LOGGING_ENABLED || !LOG_FILE) {
		return;
	}
	const entry: JsonLogEntry = {
		timestamp: new Date().toISOString(),
		level,
		commit: GIT_COMMIT,
		message,
	};
	if (data && Object.keys(data).length > 0) {
		entry.data = data;
	}
	if (err instanceof Error) {
		entry.error = {
			name: err.name,
			message: err.message,
			stack: err.stack,
			...("code" in err ? { code: String(err.code) } : {}),
		};
	} else if (err !== undefined) {
		entry.error = {
			name: "UnknownError",
			message: typeof err === "string" ? err : JSON.stringify(err),
		};
	}
	appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
}

export function initLog(options: { dryRun: boolean }): void {
	initLogFile(options.dryRun ? "rebalance-dryrun" : "rebalance");
}

export const log = {
	/** Minimal terminal output + structured JSON file log */
	info(message: string, data?: LogData): void {
		if (TERMINAL_LOGGING_ENABLED) {
			console.log(message);
		}
		writeToFile("INFO", message, data);
	},

	/** Terminal only — not written to log file */
	console(message: string): void {
		if (TERMINAL_LOGGING_ENABLED) {
			console.log(message);
		}
	},

	/** Verbose: file only (JSON structured) */
	verbose(message: string, data?: LogData): void {
		writeToFile("VERBOSE", message, data);
	},

	/** Warning: both terminal and file */
	warn(message: string, data?: LogData): void {
		if (TERMINAL_LOGGING_ENABLED) {
			console.warn(`⚠ ${message}`);
		}
		writeToFile("WARN", message, data);
	},

	/** Error: both terminal and file */
	error(message: string, err?: unknown, data?: LogData): void {
		if (TERMINAL_LOGGING_ENABLED) {
			if (err instanceof Error) {
				console.error(`✗ ${message}: ${err.message}`);
			} else if (err !== undefined) {
				console.error(
					`✗ ${message}: ${typeof err === "string" ? err : JSON.stringify(err)}`,
				);
			} else {
				console.error(`✗ ${message}`);
			}
		}
		writeToFile("ERROR", message, data, err);
	},

	/** Returns the path of the current log file */
	filePath(): string {
		return LOG_FILE ?? "file-logging-disabled";
	},
};

export function logBalancesDetail(
	label: string,
	address: string,
	balances: {
		free: bigint;
		reserved: bigint;
		stakes: ReadonlyArray<{
			netuid: number;
			hotkey: string;
			stake: bigint;
			alphaPrice: bigint;
			taoValue: bigint;
		}>;
		totalTaoValue: bigint;
	},
): void {
	log.verbose(`=== Balances ${label} (${address}) ===`);
	log.verbose(`  Free:      ${formatTao(balances.free)} τ`);
	log.verbose(`  Reserved:  ${formatTao(balances.reserved)} τ`);
	log.verbose(`  Stakes (${balances.stakes.length}):`);
	for (const s of balances.stakes) {
		log.verbose(
			`    SN${s.netuid.toString().padStart(3)} | hotkey=${s.hotkey} | alpha=${s.stake} | price=${s.alphaPrice} | ~${formatTao(s.taoValue)} τ`,
		);
	}
	const stakesTotal = balances.stakes.reduce((sum, s) => sum + s.taoValue, 0n);
	log.verbose(`  Stakes total: ${formatTao(stakesTotal)} τ`);
	log.verbose(`  Total value:  ${formatTao(balances.totalTaoValue)} τ`);
	log.verbose(`=== End ${label} ===`);
}

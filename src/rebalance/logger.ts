import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
		`rebalance-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
	);
}

interface LogData {
	[key: string]: unknown;
}

interface JsonLogEntry {
	timestamp: string;
	level: string;
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
			console.error(`✗ ${message}`);
		}
		writeToFile("ERROR", message, data, err);
	},

	/** Returns the path of the current log file */
	filePath(): string {
		return LOG_FILE ?? "file-logging-disabled";
	},
};

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

function timestamp(): string {
	return new Date().toISOString();
}

function writeToFile(level: string, message: string): void {
	if (!FILE_LOGGING_ENABLED || !LOG_FILE) {
		return;
	}
	appendFileSync(LOG_FILE, `[${timestamp()}] [${level}] ${message}\n`);
}

export function initLog(options: { dryRun: boolean }): void {
	initLogFile(options.dryRun ? "rebalance-dryrun" : "rebalance");
}

export const log = {
	/** Minimal terminal output + verbose file log */
	info(message: string): void {
		if (TERMINAL_LOGGING_ENABLED) {
			console.log(message);
		}
		writeToFile("INFO", message);
	},

	/** Terminal only — not written to log file */
	console(message: string): void {
		if (TERMINAL_LOGGING_ENABLED) {
			console.log(message);
		}
	},

	/** Verbose: file only */
	verbose(message: string): void {
		writeToFile("VERBOSE", message);
	},

	/** Warning: both terminal and file */
	warn(message: string): void {
		if (TERMINAL_LOGGING_ENABLED) {
			console.warn(`⚠ ${message}`);
		}
		writeToFile("WARN", message);
	},

	/** Error: both terminal and file */
	error(message: string, err?: unknown): void {
		if (TERMINAL_LOGGING_ENABLED) {
			console.error(`✗ ${message}`);
		}
		writeToFile("ERROR", message);
		if (err instanceof Error) {
			writeToFile("ERROR", `  ${err.stack ?? err.message}`);
		}
	},

	/** Returns the path of the current log file */
	filePath(): string {
		return LOG_FILE ?? "file-logging-disabled";
	},
};

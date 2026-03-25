import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(import.meta.dirname, "../../logs");
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
const LOG_FILE = FILE_LOGGING_ENABLED
	? join(
			LOG_DIR,
			`rebalance-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
		)
	: undefined;

if (FILE_LOGGING_ENABLED) {
	mkdirSync(LOG_DIR, { recursive: true });
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

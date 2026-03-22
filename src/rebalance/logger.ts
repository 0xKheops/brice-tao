import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(import.meta.dirname, "../../logs");
const LOG_FILE = join(
	LOG_DIR,
	`rebalance-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
);

mkdirSync(LOG_DIR, { recursive: true });

function timestamp(): string {
	return new Date().toISOString();
}

function writeToFile(level: string, message: string): void {
	appendFileSync(LOG_FILE, `[${timestamp()}] [${level}] ${message}\n`);
}

export const log = {
	/** Minimal terminal output + verbose file log */
	info(message: string): void {
		console.log(message);
		writeToFile("INFO", message);
	},

	/** Terminal only — not written to log file */
	console(message: string): void {
		console.log(message);
	},

	/** Verbose: file only */
	verbose(message: string): void {
		writeToFile("VERBOSE", message);
	},

	/** Warning: both terminal and file */
	warn(message: string): void {
		console.warn(`⚠ ${message}`);
		writeToFile("WARN", message);
	},

	/** Error: both terminal and file */
	error(message: string, err?: unknown): void {
		console.error(`✗ ${message}`);
		writeToFile("ERROR", message);
		if (err instanceof Error) {
			writeToFile("ERROR", `  ${err.stack ?? err.message}`);
		}
	},

	/** Returns the path of the current log file */
	filePath(): string {
		return LOG_FILE;
	},
};

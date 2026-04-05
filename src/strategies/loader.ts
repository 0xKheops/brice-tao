import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getStrategyTargets as copyTrade } from "./copy-trade/index.ts";
import { createRunner as copyTradeRunner } from "./copy-trade/runner.ts";
import { getStrategyTargets as rootEmission } from "./root-emission/index.ts";
import { createRunner as rootEmissionRunner } from "./root-emission/runner.ts";
import { getStrategyTargets as smaStoploss } from "./sma-stoploss/index.ts";
import { createRunner as smaStoplossRunner } from "./sma-stoploss/runner.ts";
import type { StrategyModule } from "./types.ts";

// In compiled binaries, import.meta.url points to /$bunfs/root/ (virtual FS).
// Fall back to process.execPath to find the real strategies directory on disk.
const metaDir = new URL(".", import.meta.url).pathname;
const STRATEGIES_DIR = metaDir.startsWith("/$bunfs")
	? join(dirname(process.execPath), "src", "strategies")
	: metaDir;

// Static registry so Bun can bundle strategy code into the compiled binary.
// Dynamic import() resolves against /$bunfs/ in compiled mode and fails.
const strategyRegistry: Record<string, StrategyModule> = {
	"copy-trade": {
		getStrategyTargets: copyTrade,
		createRunner: copyTradeRunner,
	},
	"root-emission": {
		getStrategyTargets: rootEmission,
		createRunner: rootEmissionRunner,
	},
	"sma-stoploss": {
		getStrategyTargets: smaStoploss,
		createRunner: smaStoplossRunner,
	},
};

/** List all available strategy folder names by scanning src/strategies/ */
function listStrategies(): string[] {
	return readdirSync(STRATEGIES_DIR)
		.filter((name) => {
			if (name.startsWith(".")) return false;
			try {
				return statSync(join(STRATEGIES_DIR, name)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();
}

/**
 * Load a strategy module by name.
 * Throws with a helpful message listing available strategies if the name is invalid.
 */
export async function loadStrategy(name: string): Promise<StrategyModule> {
	const available = listStrategies();

	if (!available.includes(name)) {
		throw new Error(
			`Unknown strategy "${name}". Available strategies:\n${available.map((s) => `  - ${s}`).join("\n")}`,
		);
	}

	const mod = strategyRegistry[name];
	if (!mod) {
		throw new Error(
			`Strategy "${name}" exists on disk but is not registered in the strategy registry (loader.ts). Add it to strategyRegistry.`,
		);
	}

	return mod;
}

/** Parse --strategy flag from process.argv; returns undefined if not present. */
function parseStrategyArg(): string | undefined {
	const idx = process.argv.indexOf("--strategy");
	if (idx === -1) return undefined;
	const value = process.argv[idx + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(
			"--strategy requires a value (e.g. --strategy root-emission)",
		);
	}
	return value;
}

const DEFAULT_STRATEGY = "root-emission";

/**
 * Resolve strategy name from CLI flag → env var → default (root-emission).
 * If --list-strategies is present, prints available strategies and exits.
 */
export function resolveStrategyName(envStrategy: string | undefined): string {
	if (process.argv.includes("--list-strategies")) {
		const available = listStrategies();
		console.log("Available strategies:");
		for (const s of available) {
			console.log(`  - ${s}`);
		}
		process.exit(0);
	}

	const fromArg = parseStrategyArg();
	const name = fromArg ?? envStrategy;

	if (!name) {
		console.warn(
			`[strategy] No --strategy flag or STRATEGY env var — defaulting to "${DEFAULT_STRATEGY}"`,
		);
		return DEFAULT_STRATEGY;
	}

	return name;
}

import { strategyModule as copyTrade } from "./copy-trade/module.ts";
import { strategyModule as coward } from "./coward/module.ts";
import { strategyModule as rootEmission } from "./root-emission/module.ts";
import { strategyModule as smaStoploss } from "./sma-stoploss/module.ts";
import type { StrategyModule } from "./types.ts";

const DEFAULT_STRATEGY = "root-emission";

const strategyRegistry: Record<string, StrategyModule> = {
	"copy-trade": copyTrade,
	coward,
	"root-emission": rootEmission,
	"sma-stoploss": smaStoploss,
};

export interface StrategySelectionOptions {
	argv?: string[];
	envStrategy?: string;
}

export type StrategySelection =
	| { kind: "list"; available: string[] }
	| { kind: "selected"; name: string };

function listStrategies(): string[] {
	return Object.keys(strategyRegistry).sort();
}

export function formatStrategyList(available = listStrategies()): string {
	return [
		"Available strategies:",
		...available.map((name) => `  - ${name}`),
	].join("\n");
}

export function loadStrategy(name: string): StrategyModule {
	const mod = strategyRegistry[name];
	if (mod) return mod;

	const available = listStrategies();
	throw new Error(
		`Unknown strategy "${name}". ${formatStrategyList(available)}`,
	);
}

export function resolveStrategySelection({
	argv = process.argv.slice(2),
	envStrategy,
}: StrategySelectionOptions): StrategySelection {
	if (argv.includes("--list-strategies")) {
		return { kind: "list", available: listStrategies() };
	}

	const fromArg = parseStrategyArg(argv);
	const name = fromArg ?? envStrategy;

	if (!name) {
		console.warn(
			`[strategy] No --strategy flag or STRATEGY env var — defaulting to "${DEFAULT_STRATEGY}"`,
		);
		return { kind: "selected", name: DEFAULT_STRATEGY };
	}

	return { kind: "selected", name };
}

function parseStrategyArg(argv: string[]): string | undefined {
	const idx = argv.indexOf("--strategy");
	if (idx === -1) return undefined;

	const value = argv[idx + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(
			"--strategy requires a value (e.g. --strategy root-emission)",
		);
	}

	return value;
}

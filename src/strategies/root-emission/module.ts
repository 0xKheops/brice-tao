import type { BacktestSchedule, StrategyModule } from "../types.ts";
import { createBacktest } from "./backtest.ts";
import { loadRootEmissionConfig } from "./config.ts";
import { getStrategyTargets } from "./index.ts";
import { createRunner } from "./runner.ts";

function getBacktestSchedule(): BacktestSchedule {
	const configPath = new URL("./config.yaml", import.meta.url).pathname;
	const config = loadRootEmissionConfig(configPath);
	return { type: "cron", cronSchedule: config.schedule.cronSchedule };
}

export const strategyModule: StrategyModule = {
	getStrategyTargets,
	createRunner,
	createBacktest,
	getBacktestSchedule,
};

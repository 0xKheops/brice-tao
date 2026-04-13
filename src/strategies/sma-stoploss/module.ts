import type { BacktestSchedule, StrategyModule } from "../types.ts";
import { createBacktest } from "./backtest.ts";
import { loadSmaStoplossConfig } from "./config.ts";
import { getStrategyTargets, preparePreview, warmup } from "./index.ts";
import { createRunner } from "./runner.ts";

function getBacktestSchedule(): BacktestSchedule {
	const configPath = new URL("./config.yaml", import.meta.url).pathname;
	const config = loadSmaStoplossConfig(configPath);
	return {
		type: "block-interval",
		intervalBlocks: config.schedule.rebalanceIntervalBlocks,
	};
}

export const strategyModule: StrategyModule = {
	getStrategyTargets,
	createRunner,
	preparePreview,
	warmup,
	createBacktest,
	getBacktestSchedule,
};

import type { StrategyModule } from "../types.ts";
import { getStrategyTargets } from "./index.ts";
import { createRunner } from "./runner.ts";

export const strategyModule: StrategyModule = {
	getStrategyTargets,
	createRunner,
};

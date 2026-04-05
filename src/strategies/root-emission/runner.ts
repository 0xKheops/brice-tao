import { dirname, join } from "node:path";
import { createCronRunner } from "../../scheduling/cron.ts";
import type { RunnerContext, StrategyRunner } from "../../scheduling/types.ts";
import { loadRootEmissionConfig } from "./config.ts";

const metaDir = new URL(".", import.meta.url).pathname;
const CONFIG_PATH = metaDir.startsWith("/$bunfs")
	? join(
			dirname(process.execPath),
			"src",
			"strategies",
			"root-emission",
			"config.yaml",
		)
	: new URL("./config.yaml", import.meta.url).pathname;

export function createRunner(ctx: RunnerContext): StrategyRunner {
	const { schedule } = loadRootEmissionConfig(CONFIG_PATH);
	return createCronRunner({
		schedule,
		onTick: () => ctx.runRebalanceCycle(),
		label: `scheduler:${ctx.strategyName}`,
	});
}

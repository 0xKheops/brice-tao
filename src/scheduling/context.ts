import type { BittensorClient } from "../api/createClient.ts";
import type { Env } from "../config/env.ts";
import type { CycleOptions } from "../rebalance/cycle.ts";
import { executeRebalanceCycle } from "../rebalance/cycle.ts";
import type { StrategyFn } from "../strategies/types.ts";
import type { RunnerContext } from "./types.ts";

/**
 * Build a RunnerContext suitable for both the long-running scheduler
 * and the one-shot CLI. Binds `runRebalanceCycle` to the given strategy.
 */
export function buildRunnerContext(
	bittensorClient: BittensorClient,
	env: Env,
	strategyName: string,
	getStrategyTargets: StrategyFn,
	cycleOptions: CycleOptions,
): RunnerContext {
	return {
		client: bittensorClient.client,
		env,
		strategyName,
		runRebalanceCycle: () =>
			executeRebalanceCycle(
				bittensorClient,
				env,
				getStrategyTargets,
				cycleOptions,
			),
	};
}

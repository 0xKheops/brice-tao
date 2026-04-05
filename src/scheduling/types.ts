import type { PolkadotClient } from "polkadot-api";
import type { Env } from "../config/env.ts";

/** Schedule config for cron-based strategies — parsed from config.yaml top-level fields */
export interface CronScheduleConfig {
	cronSchedule: string;
	staleTimeoutMinutes: number;
}

export interface RebalanceCycleResult {
	exitCode: number;
}

/**
 * Context provided to a strategy's runner factory.
 * Contains everything the runner needs to trigger rebalance cycles and
 * (for always-online strategies) interact with the chain.
 */
export interface RunnerContext {
	client: PolkadotClient;
	env: Env;
	strategyName: string;
	/** Execute a full rebalance cycle: fetch balances → compute targets → execute → notify */
	runRebalanceCycle(): Promise<RebalanceCycleResult>;
}

/**
 * Strategy runner — owns the scheduling lifecycle.
 * Cron strategies set up a periodic job; always-online strategies
 * may subscribe to blocks or other on-chain events.
 */
export interface StrategyRunner {
	/** Start the scheduling loop (cron job, block subscription, etc.) */
	start(): Promise<void>;
	/** Graceful shutdown — waits for any in-flight cycle to finish */
	stop(): Promise<void>;
}

/** Factory that each strategy exports to create its runner */
export type CreateRunnerFn = (context: RunnerContext) => StrategyRunner;

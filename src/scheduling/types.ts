import type { PolkadotClient } from "polkadot-api";
import type { Env } from "../config/env.ts";
import type { HistoryDatabase } from "../history/db.ts";
import type { BatchResult, RebalancePlan } from "../rebalance/types.ts";

/** Schedule config for cron-based strategies — parsed from config.yaml top-level fields */
export interface CronScheduleConfig {
	cronSchedule: string;
	staleTimeoutMinutes: number;
}

/** Schedule config for block-interval strategies — parsed from config.yaml top-level fields */
export interface BlockIntervalConfig {
	rebalanceIntervalBlocks: number;
	staleTimeoutBlocks: number;
}

export type RebalanceCycleOutcome =
	| "skipped"
	| "no_ops"
	| "completed"
	| "partial_failure"
	| "timeout"
	| "error";

export interface RebalanceCycleResult {
	exitCode: number;
	outcome: RebalanceCycleOutcome;
	reason?: string;
	plan: RebalancePlan | null;
	batchResult: BatchResult | null;
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
	/** Shared history database for recording subnet snapshots */
	historyDb: HistoryDatabase;
	/** Execute a full rebalance cycle: fetch balances → compute targets → execute → notify */
	runRebalanceCycle(): Promise<RebalanceCycleResult>;
}

/**
 * Strategy runner — owns the scheduling lifecycle.
 * Cron strategies set up a periodic job; block-interval strategies subscribe to
 * finalized blocks and fire on modulo-aligned block numbers; always-online strategies
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

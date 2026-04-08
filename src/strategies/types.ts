import type { PolkadotClient } from "polkadot-api";
import type { Balances } from "../balances/getBalances.ts";
import type { Env } from "../config/env.ts";
import type { SubnetSnapshot } from "../history/types.ts";
import type { RebalanceConfig, StrategyTarget } from "../rebalance/types.ts";
import type { CreateRunnerFn } from "../scheduling/types.ts";

export type { RebalanceConfig, StrategyTarget };

export type StrategyFn = (
	client: PolkadotClient,
	env: Env,
	balances: Balances,
) => Promise<StrategyResult>;

export interface AuditSections {
	/** Lines printed to the terminal during preview and dry-run */
	terminalLines: string[];
	/** Markdown string injected into the preview report file */
	reportMarkdown: string;
}

export interface StrategyResult {
	targets: StrategyTarget[];
	skipped: Array<{ netuid: number; reason: string }>;
	rebalanceConfig: RebalanceConfig;
	audit?: AuditSections;
}

// ---------------------------------------------------------------------------
// Backtest types
// ---------------------------------------------------------------------------

/** Result of a single backtest step */
export interface BacktestStep {
	targets: StrategyTarget[];
}

/** Result of an observe() call — signals whether an immediate rebalance is needed */
export interface ObserveResult {
	needsRebalance: boolean;
}

/**
 * Stateful backtest strategy that can be stepped through historical snapshots.
 * Created by a strategy's `createBacktest()` factory.
 *
 * Observation and rebalance are separated so stateful strategies (e.g.
 * SMA-stoploss) can update indicators at every available snapshot while
 * rebalancing only at configured intervals.
 */
export interface BacktestStrategy {
	/**
	 * Update internal state (price samples, stop-losses) without generating
	 * targets. Called at every DB snapshot between rebalance ticks.
	 * Stateless strategies can return `{ needsRebalance: false }`.
	 *
	 * Return `{ needsRebalance: true }` when an immediate rebalance is needed
	 * (e.g. a stop-loss triggered). The backtest loop will call `step()` on
	 * the same snapshot to execute the rebalance.
	 */
	observe(
		snapshots: SubnetSnapshot[],
		blockNumber: number,
		timestamp: number,
		heldNetuids: Set<number>,
	): ObserveResult;

	/**
	 * Observe the current snapshot and generate rebalance targets.
	 * Called at rebalance intervals. Implementations should call
	 * observe() internally so callers don't need to double-call.
	 */
	step(
		snapshots: SubnetSnapshot[],
		blockNumber: number,
		timestamp: number,
		heldNetuids: Set<number>,
	): BacktestStep;

	/**
	 * Optional hook called after the backtest loop executes trades for a
	 * rebalance step. Use this to initialize state for newly opened
	 * positions (e.g. seed stop-losses at entry price).
	 * Stateless strategies can omit this.
	 */
	afterRebalance?(
		snapshots: SubnetSnapshot[],
		blockNumber: number,
		newHeldNetuids: Set<number>,
	): void;
}

// ---------------------------------------------------------------------------
// Backtest schedule types
// ---------------------------------------------------------------------------

/** Cron-based schedule for backtesting — evaluated in UTC */
export interface CronBacktestSchedule {
	type: "cron";
	cronSchedule: string;
}

/** Block-modulo schedule for backtesting */
export interface BlockIntervalBacktestSchedule {
	type: "block-interval";
	intervalBlocks: number;
}

export type BacktestSchedule =
	| CronBacktestSchedule
	| BlockIntervalBacktestSchedule;

/** Full strategy module: what to allocate + how to schedule */
export interface StrategyModule {
	getStrategyTargets: StrategyFn;
	createRunner: CreateRunnerFn;
	/**
	 * Optional hook called by the preview script to hydrate shared state
	 * (e.g. load indicator histories from the DB) before running the strategy.
	 * Strategies that don't need this can omit it.
	 */
	preparePreview?: () => Promise<void>;
	/**
	 * Optional factory for creating a backtest-compatible strategy instance.
	 * Returns a stateful BacktestStrategy that can be stepped through
	 * historical snapshots without a live RPC connection.
	 */
	createBacktest?: () => BacktestStrategy;
	/**
	 * Optional schedule descriptor for backtesting.
	 * Tells the backtest script when to trigger rebalances — either at
	 * block-modulo intervals or by evaluating a cron expression (UTC)
	 * against historical block timestamps.
	 */
	getBacktestSchedule?: () => BacktestSchedule;
}

import type { PolkadotClient } from "polkadot-api";
import type { Balances } from "../balances/getBalances.ts";
import type { Env } from "../config/env.ts";
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
}

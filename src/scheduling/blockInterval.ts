import type { PolkadotClient } from "polkadot-api";
import type { Subscription } from "rxjs";
import {
	DB_HISTORY_BLOCK_INTERVAL,
	SECONDS_PER_BLOCK,
} from "../history/constants.ts";
import { writeHeartbeat } from "./heartbeat.ts";
import type { RebalanceCycleResult, StrategyRunner } from "./types.ts";

/** Block info passed to the tick callback — use this for queries instead of re-fetching */
export interface BlockInfo {
	number: number;
	hash: string;
}

export interface BlockIntervalRunnerOptions {
	client: PolkadotClient;
	intervalBlocks: number;
	staleTimeoutBlocks: number;
	observeIntervalBlocks?: number;
	onObserve?: (block: BlockInfo) => Promise<void>;
	onTick: (block: BlockInfo) => Promise<RebalanceCycleResult>;
	label: string;
}

/**
 * Create a block-interval strategy runner that subscribes to finalized blocks
 * and fires `onTick` on every block where `blockNumber % intervalBlocks === 0`.
 *
 * This replaces cron-based scheduling with deterministic block-modulo intervals,
 * ensuring live trading and backtesting use identical trigger points.
 *
 * The interval must be a multiple of `BLOCK_INTERVAL` (25) so that every
 * trigger block aligns with the history DB grid — a prerequisite for exact
 * backtest replay.
 */
export function createBlockIntervalRunner({
	client,
	intervalBlocks,
	staleTimeoutBlocks,
	observeIntervalBlocks,
	onObserve,
	onTick,
	label,
}: BlockIntervalRunnerOptions): StrategyRunner {
	if (intervalBlocks % DB_HISTORY_BLOCK_INTERVAL !== 0) {
		throw new Error(
			`[${label}] rebalanceIntervalBlocks (${intervalBlocks}) must be a multiple of BLOCK_INTERVAL (${DB_HISTORY_BLOCK_INTERVAL}) for history DB / backtest alignment`,
		);
	}
	if (
		observeIntervalBlocks !== undefined &&
		observeIntervalBlocks % DB_HISTORY_BLOCK_INTERVAL !== 0
	) {
		throw new Error(
			`[${label}] observeIntervalBlocks (${observeIntervalBlocks}) must be a multiple of BLOCK_INTERVAL (${DB_HISTORY_BLOCK_INTERVAL})`,
		);
	}
	if (
		observeIntervalBlocks !== undefined &&
		intervalBlocks % observeIntervalBlocks !== 0
	) {
		throw new Error(
			`[${label}] rebalanceIntervalBlocks (${intervalBlocks}) must be a multiple of observeIntervalBlocks (${observeIntervalBlocks})`,
		);
	}

	let sub: Subscription | undefined;
	let inflightRun: Promise<void> | null = null;
	let observeChain: Promise<void> = Promise.resolve();
	let stopped = false;
	let consecutiveStaleTimeouts = 0;
	const MAX_CONSECUTIVE_STALE = 3;

	const staleTimeoutMs = staleTimeoutBlocks * SECONDS_PER_BLOCK * 1000;
	// Deadline covers the next interval + stale timeout margin
	const heartbeatWindowSeconds =
		(intervalBlocks + staleTimeoutBlocks) * SECONDS_PER_BLOCK;

	async function runTick(block: BlockInfo): Promise<void> {
		if (inflightRun) {
			console.warn(
				`[${label}] Skipping block #${block.number} — previous run still in progress`,
			);
			return;
		}

		const run = async (): Promise<void> => {
			const staleTimer = setTimeout(() => {
				consecutiveStaleTimeouts++;
				console.error(
					`[${label}] Run exceeded stale timeout of ${staleTimeoutBlocks} blocks (~${Math.round(staleTimeoutMs / 1000)}s) — will NOT interrupt; next tick will still be skipped until this run completes (consecutive: ${consecutiveStaleTimeouts}/${MAX_CONSECUTIVE_STALE})`,
				);
				if (consecutiveStaleTimeouts >= MAX_CONSECUTIVE_STALE) {
					console.error(
						`[${label}] ${MAX_CONSECUTIVE_STALE} consecutive stale timeouts — stopping runner for container restart`,
					);
					stopped = true;
					sub?.unsubscribe();
					sub = undefined;
				}
			}, staleTimeoutMs);

			try {
				console.log(`[${label}] Starting run at block #${block.number}...`);
				const result = await onTick(block);
				consecutiveStaleTimeouts = 0;
				if (result.exitCode === 0) {
					console.log(
						`[${label}] Run finished successfully at block #${block.number} (${result.outcome})`,
					);
				} else {
					console.error(
						`[${label}] Run finished with exit code ${result.exitCode} at block #${block.number} (${result.outcome})`,
					);
				}
			} catch (err) {
				console.error(`[${label}] Unexpected error in run:`, err);
			} finally {
				clearTimeout(staleTimer);
				writeHeartbeat(Date.now() / 1000 + heartbeatWindowSeconds);
			}
		};

		inflightRun = run();
		try {
			await inflightRun;
		} finally {
			inflightRun = null;
		}
	}

	function enqueueObserve(block: BlockInfo): Promise<void> {
		if (!onObserve) return observeChain;

		const nextObserve = observeChain
			.then(async () => {
				await onObserve(block);
			})
			.catch((err) => {
				console.error(
					`[${label}] Unexpected error during observe at block #${block.number}:`,
					err,
				);
			});

		observeChain = nextObserve;
		return nextObserve;
	}

	return {
		async start() {
			console.log(
				`[${label}] Subscribing to finalized blocks — interval: every ${intervalBlocks} blocks (~${Math.round((intervalBlocks * SECONDS_PER_BLOCK) / 3600)}h)`,
			);
			writeHeartbeat(Date.now() / 1000 + heartbeatWindowSeconds);

			sub = client.finalizedBlock$.subscribe({
				next: (block) => {
					if (stopped) return;
					const blockInfo = { number: block.number, hash: block.hash };
					const shouldObserve =
						onObserve !== undefined &&
						observeIntervalBlocks !== undefined &&
						block.number % observeIntervalBlocks === 0;
					const shouldTick = block.number % intervalBlocks === 0;
					if (!shouldObserve && !shouldTick) return;

					void (async () => {
						if (shouldObserve) {
							await enqueueObserve(blockInfo);
						} else {
							await observeChain;
						}

						if (shouldTick) {
							await runTick(blockInfo);
						}
					})();
				},
				error: (err) => {
					console.error(
						`[${label}] Block subscription error — stopping runner:`,
						err,
					);
					stopped = true;
					sub?.unsubscribe();
					sub = undefined;
				},
			});
		},

		async stop() {
			stopped = true;
			sub?.unsubscribe();
			sub = undefined;
			await observeChain;
			if (inflightRun) await inflightRun;
		},
	};
}

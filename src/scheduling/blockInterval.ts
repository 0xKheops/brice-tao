import { writeFileSync } from "node:fs";
import type { PolkadotClient } from "polkadot-api";
import type { Subscription } from "rxjs";
import {
	DB_HISTORY_BLOCK_INTERVAL,
	SECONDS_PER_BLOCK,
} from "../history/constants.ts";
import type { RebalanceCycleResult, StrategyRunner } from "./types.ts";

/**
 * Write a heartbeat deadline (epoch seconds) to `data/heartbeat`.
 * Docker healthcheck verifies the deadline is still in the future.
 */
function writeHeartbeat(deadlineSeconds: number): void {
	try {
		writeFileSync("data/heartbeat", String(Math.round(deadlineSeconds)));
	} catch {
		// Non-critical — don't fail the run
	}
}

/** Block info passed to the tick callback — use this for queries instead of re-fetching */
export interface BlockInfo {
	number: number;
	hash: string;
}

export interface BlockIntervalRunnerOptions {
	client: PolkadotClient;
	intervalBlocks: number;
	staleTimeoutBlocks: number;
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
	onTick,
	label,
}: BlockIntervalRunnerOptions): StrategyRunner {
	if (intervalBlocks % DB_HISTORY_BLOCK_INTERVAL !== 0) {
		throw new Error(
			`[${label}] rebalanceIntervalBlocks (${intervalBlocks}) must be a multiple of BLOCK_INTERVAL (${DB_HISTORY_BLOCK_INTERVAL}) for history DB / backtest alignment`,
		);
	}

	let sub: Subscription | undefined;
	let inflightRun: Promise<void> | null = null;
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
				const { exitCode } = await onTick(block);
				consecutiveStaleTimeouts = 0;
				if (exitCode === 0) {
					console.log(
						`[${label}] Run finished successfully at block #${block.number}`,
					);
				} else {
					console.error(
						`[${label}] Run finished with exit code ${exitCode} at block #${block.number}`,
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

	return {
		async start() {
			console.log(
				`[${label}] Subscribing to finalized blocks — interval: every ${intervalBlocks} blocks (~${Math.round((intervalBlocks * SECONDS_PER_BLOCK) / 3600)}h)`,
			);
			writeHeartbeat(Date.now() / 1000 + heartbeatWindowSeconds);

			sub = client.finalizedBlock$.subscribe({
				next: (block) => {
					if (stopped) return;
					if (block.number % intervalBlocks !== 0) return;

					void runTick({ number: block.number, hash: block.hash });
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
			if (inflightRun) await inflightRun;
		},
	};
}

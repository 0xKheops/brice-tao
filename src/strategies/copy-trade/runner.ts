import { dirname, join } from "node:path";
import { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import type { Subscription } from "rxjs";
import type { RunnerContext, StrategyRunner } from "../../scheduling/types.ts";
import { loadCopyTradeConfig } from "./config.ts";

type Api = TypedApi<typeof bittensor>;

// In compiled binaries, import.meta.url → /$bunfs/; use process.execPath instead.
const metaDir = new URL(".", import.meta.url).pathname;
const CONFIG_PATH = metaDir.startsWith("/$bunfs")
	? join(
			dirname(process.execPath),
			"src",
			"strategies",
			"copy-trade",
			"config.yaml",
		)
	: new URL("./config.yaml", import.meta.url).pathname;

export function createRunner(ctx: RunnerContext): StrategyRunner {
	const config = loadCopyTradeConfig(CONFIG_PATH, ctx.env.leaderAddress);
	const leaderAddress = config.strategy.leaderAddress;
	const label = `copy-trade:${ctx.strategyName}`;
	const staleTimeoutMs = config.staleTimeoutMinutes * 60_000;

	let sub: Subscription | undefined;
	let inflightRun: Promise<void> | null = null;
	let stopped = false;
	let pendingRerun = false;

	const run = async (): Promise<void> => {
		const staleTimer = setTimeout(() => {
			console.error(
				`[${label}] Run exceeded stale timeout — events will be skipped until this run completes`,
			);
		}, staleTimeoutMs);

		try {
			console.log(`[${label}] Starting rebalance cycle...`);
			const { exitCode } = await ctx.runRebalanceCycle();
			if (exitCode === 0) {
				console.log(`[${label}] Cycle finished successfully`);
			} else {
				console.error(`[${label}] Cycle finished with exit code ${exitCode}`);
			}
		} catch (err) {
			console.error(`[${label}] Unexpected error in cycle:`, err);
		} finally {
			clearTimeout(staleTimer);
			inflightRun = null;
			if (pendingRerun && !stopped) {
				pendingRerun = false;
				console.log(
					`[${label}] Processing pending event that arrived during previous cycle`,
				);
				inflightRun = run();
				await inflightRun;
			}
		}
	};

	return {
		async start() {
			const api: Api = ctx.client.getTypedApi(bittensor);

			// Start initial sync first — inflightRun is assigned synchronously
			// so the subscribe handler below always sees it as non-null during startup.
			console.log(`[${label}] Running initial sync...`);
			inflightRun = run();

			console.log(
				`[${label}] Subscribing to finalized blocks — watching leader ${leaderAddress.slice(0, 8)}…`,
			);
			sub = ctx.client.finalizedBlock$.subscribe({
				next: (block) => {
					void (async () => {
						try {
							if (stopped) return;

							const events = await api.query.System.Events.getValue({
								at: block.hash,
							});

							if (stopped) return;

							const hasLeaderEvent = events.some((e) =>
								isLeaderStakingEvent(e, leaderAddress),
							);
							if (!hasLeaderEvent) return;

							console.log(
								`[${label}] Leader staking event detected in block #${block.number}`,
							);

							if (inflightRun) {
								pendingRerun = true;
								console.warn(
									`[${label}] Cycle in progress — queued pending rerun`,
								);
								return;
							}

							inflightRun = run();
							await inflightRun;
						} catch (err) {
							console.error(
								`[${label}] Error processing block #${block.number}:`,
								err,
							);
						}
					})();
				},
				error: (err) => {
					console.error(`[${label}] Block subscription error:`, err);
					process.exit(1);
				},
			});

			// Do NOT await inflightRun here — return immediately so the
			// scheduler can install signal handlers for graceful shutdown.
			// The initial sync continues in the background; stop() awaits it.
		},

		async stop() {
			stopped = true;
			sub?.unsubscribe();
			sub = undefined;
			if (inflightRun) await inflightRun;
		},
	};
}

const LEADER_EVENT_TYPES = new Set([
	"StakeAdded",
	"StakeRemoved",
	"StakeMoved",
	"StakeSwapped",
	"StakeTransferred",
]);

function isLeaderStakingEvent(event: unknown, leaderAddress: string): boolean {
	// Events from polkadot-api have shape:
	// { event: { type: "SubtensorModule", value: { type: "StakeAdded", value: [...] } } }
	// The coldkey is the first tuple element for all matched event types.
	const e = event as {
		event?: { type?: string; value?: { type?: string; value?: unknown[] } };
	};
	if (e.event?.type !== "SubtensorModule") return false;
	const v = e.event.value;
	if (!v || !v.type || !LEADER_EVENT_TYPES.has(v.type)) return false;

	const coldkey = Array.isArray(v.value) ? v.value[0] : undefined;
	if (coldkey === leaderAddress) return true;

	// StakeTransferred has destination coldkey at index 1
	if (v.type === "StakeTransferred" && Array.isArray(v.value)) {
		return v.value[1] === leaderAddress;
	}

	return false;
}

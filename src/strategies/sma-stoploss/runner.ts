import { join } from "node:path";
import { bittensor } from "@polkadot-api/descriptors";
import { Cron } from "croner";
import type { TypedApi } from "polkadot-api";
import { log } from "../../rebalance/logger.ts";
import { formatTao } from "../../rebalance/tao.ts";
import type { RunnerContext, StrategyRunner } from "../../scheduling/types.ts";
import { loadSmaStoplossConfig } from "./config.ts";
import { openPriceDatabase, type PriceDatabase } from "./db.ts";
import { fetchAllSubnetData } from "./fetchSubnetData.ts";
import { CONFIG_PATH, setSharedState } from "./index.ts";
import type { SharedState, StopLossEntry, StopOutRecord } from "./types.ts";
import { warmupPriceHistory } from "./warmup.ts";

type Api = TypedApi<typeof bittensor>;

const DB_PATH = join("data", "sma-stoploss.sqlite");

/**
 * Create a custom cron runner that owns all state mutations:
 * - Startup: open DB, archive warmup, restore persisted state
 * - Per tick: sample prices, update stop-losses, then rebalance
 * - Shutdown: close DB
 */
export function createRunner(ctx: RunnerContext): StrategyRunner {
	const config = loadSmaStoplossConfig(CONFIG_PATH);
	const label = `sma-stoploss:${ctx.strategyName}`;

	// Persistent state
	let db: PriceDatabase | undefined;
	let job: Cron | undefined;
	let inflightRun: Promise<void> | null = null;
	let stopped = false;

	// In-memory stop-loss state (persisted to DB after each tick)
	const stopLosses = new Map<number, StopLossEntry>();
	const stoppedOut = new Map<number, StopOutRecord>();

	/** Compute the stop price for a given high-water mark */
	function computeStopPrice(highWaterMark: bigint): bigint {
		const percentScaled = BigInt(
			Math.round(config.strategy.stopLossPercent * 100),
		);
		const stopDistance = (highWaterMark * percentScaled) / 10000n;
		const stop = highWaterMark - stopDistance;
		return stop > 0n ? stop : 0n;
	}

	/**
	 * Per-tick state update: sample prices, manage stop-losses, then rebalance.
	 * All DB mutations happen here — getStrategyTargets only reads shared state.
	 */
	async function tick(): Promise<void> {
		if (stopped || !db) return;

		if (inflightRun) {
			console.warn(`[${label}] Skipping tick — previous run still in progress`);
			return;
		}

		const run = async (): Promise<void> => {
			const database = db;
			if (!database) return;

			const staleTimer = setTimeout(() => {
				console.error(
					`[${label}] Run exceeded stale timeout of ${config.schedule.staleTimeoutMinutes} minutes`,
				);
			}, config.schedule.staleTimeoutMinutes * 60_000);

			try {
				console.log(`[${label}] Starting tick...`);
				const api: Api = ctx.client.getTypedApi(bittensor);

				// 1. Fetch current subnet data (with spot prices)
				const subnets = await fetchAllSubnetData(api);

				// Estimate current block number
				let currentBlock = 0n;
				for (const sn of subnets) {
					const estimate = sn.networkRegisteredAt + sn.blocksSinceLastStep;
					if (estimate > currentBlock) currentBlock = estimate;
				}
				const blockNumber = Number(currentBlock);

				// 2. Insert price samples into DB
				let newSamples = 0;
				for (const sn of subnets) {
					if (sn.netuid === 0) continue;
					if (sn.spotPrice <= 0n) continue;
					if (
						database.insertPriceSample(
							sn.netuid,
							blockNumber,
							sn.spotPrice,
							config.strategy.maxPriceSamples,
						)
					) {
						newSamples++;
					}
				}
				if (newSamples > 0) {
					log.verbose(
						`Sampled prices for ${newSamples} subnets at block ${blockNumber}`,
					);
				}

				// 3. Expire old cooldowns
				const cooldownBlocks = BigInt(config.strategy.cooldownBlocks);
				for (const [netuid, record] of stoppedOut) {
					if (
						currentBlock - BigInt(record.triggeredAtBlock) >=
						cooldownBlocks
					) {
						stoppedOut.delete(netuid);
						database.deleteStoppedOut(netuid);
						log.verbose(`Cooldown expired for SN${netuid}`);
					}
				}

				// 4. Update stop-losses for held positions
				// Build a set of currently held netuids from current balances
				const stakeInfos =
					await api.apis.StakeInfoRuntimeApi.get_stake_info_for_coldkey(
						ctx.env.coldkey,
					);
				const heldNetuids = new Set(stakeInfos.map((s) => s.netuid));
				const subnetMap = new Map(subnets.map((s) => [s.netuid, s]));

				// Remove stop-losses for subnets we no longer hold
				for (const netuid of stopLosses.keys()) {
					if (!heldNetuids.has(netuid)) {
						stopLosses.delete(netuid);
						database.deleteStopLoss(netuid);
					}
				}

				// Initialize or update stop-losses for held subnets
				const triggeredNetuids: number[] = [];
				for (const netuid of heldNetuids) {
					if (netuid === 0) continue;
					const sn = subnetMap.get(netuid);
					if (!sn || sn.spotPrice <= 0n) continue;

					const existing = stopLosses.get(netuid);

					if (existing) {
						if (sn.spotPrice > existing.highWaterMark) {
							// Ratchet up HWM
							existing.highWaterMark = sn.spotPrice;
							existing.stopPrice = computeStopPrice(sn.spotPrice);
							database.saveStopLoss(existing);
						} else if (sn.spotPrice < existing.stopPrice) {
							// Stop triggered!
							log.warn(
								`Stop-loss TRIGGERED for SN${netuid}: price=${formatI96F32(sn.spotPrice)} < stop=${formatI96F32(existing.stopPrice)}`,
							);
							triggeredNetuids.push(netuid);
						}
					} else {
						// New position — initialize stop-loss from current price
						const entry: StopLossEntry = {
							netuid,
							highWaterMark: sn.spotPrice,
							stopPrice: computeStopPrice(sn.spotPrice),
						};
						stopLosses.set(netuid, entry);
						database.saveStopLoss(entry);
						log.verbose(
							`Initialized stop-loss for SN${netuid}: HWM=${formatI96F32(sn.spotPrice)}, stop=${formatI96F32(entry.stopPrice)}`,
						);
					}
				}

				// Mark triggered subnets as stopped out
				for (const netuid of triggeredNetuids) {
					const sn = subnetMap.get(netuid);
					const exitPrice = sn?.spotPrice ?? 0n;
					const record: StopOutRecord = {
						netuid,
						triggeredAtBlock: blockNumber,
						exitPrice,
					};
					stoppedOut.set(netuid, record);
					stopLosses.delete(netuid);
					database.saveStoppedOut(record);
					database.deleteStopLoss(netuid);
					log.info(
						`Stopped out of SN${netuid} at price ${formatI96F32(exitPrice)}`,
					);
				}

				// 5. Update shared state for getStrategyTargets
				const priceHistories = database.getAllPriceHistories();
				const state: SharedState = {
					priceHistories,
					stoppedOut: new Map(stoppedOut),
				};
				setSharedState(state);

				// 6. Run rebalance cycle
				const { exitCode } = await ctx.runRebalanceCycle();
				if (exitCode === 0) {
					console.log(`[${label}] Tick finished successfully`);
				} else {
					console.error(`[${label}] Tick finished with exit code ${exitCode}`);
				}

				// Refresh stop-loss state after rebalance (positions may have changed)
				const postStakeInfos =
					await api.apis.StakeInfoRuntimeApi.get_stake_info_for_coldkey(
						ctx.env.coldkey,
					);
				const postHeldNetuids = new Set(postStakeInfos.map((s) => s.netuid));
				// Remove stop-losses for exited positions
				for (const netuid of stopLosses.keys()) {
					if (!postHeldNetuids.has(netuid)) {
						stopLosses.delete(netuid);
						database.deleteStopLoss(netuid);
					}
				}
				// Initialize stop-losses for any new positions
				const postSubnets = await fetchAllSubnetData(api);
				const postSubnetMap = new Map(postSubnets.map((s) => [s.netuid, s]));
				for (const netuid of postHeldNetuids) {
					if (netuid === 0 || stopLosses.has(netuid)) continue;
					const sn = postSubnetMap.get(netuid);
					if (!sn || sn.spotPrice <= 0n) continue;
					const entry: StopLossEntry = {
						netuid,
						highWaterMark: sn.spotPrice,
						stopPrice: computeStopPrice(sn.spotPrice),
					};
					stopLosses.set(netuid, entry);
					database.saveStopLoss(entry);
					log.verbose(
						`Post-rebalance: initialized stop-loss for new position SN${netuid}`,
					);
				}

				// Update shared state again with final state
				const finalHistories = database.getAllPriceHistories();
				setSharedState({
					priceHistories: finalHistories,
					stoppedOut: new Map(stoppedOut),
				});
			} catch (err) {
				console.error(`[${label}] Unexpected error in tick:`, err);
			} finally {
				clearTimeout(staleTimer);
				inflightRun = null;
			}
		};

		inflightRun = run();
		await inflightRun;
	}

	return {
		async start() {
			// Open persistent DB handle
			db = openPriceDatabase(DB_PATH);

			// Warmup from archive node if configured and DB lacks data
			if (ctx.env.archiveWsEndpoints.length > 0) {
				try {
					await warmupPriceHistory(
						db,
						ctx.env.archiveWsEndpoints,
						config.strategy.maxPriceSamples,
						// ~1200 blocks per 4h at 12s/block
						1200,
					);
				} catch (err) {
					log.warn(
						`Archive warmup failed, continuing with cold start: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			// Restore persisted stop-loss state
			const persistedStopLosses = db.getAllStopLosses();
			for (const entry of persistedStopLosses) {
				stopLosses.set(entry.netuid, entry);
			}
			const persistedStoppedOut = db.getAllStoppedOut();
			for (const record of persistedStoppedOut) {
				stoppedOut.set(record.netuid, record);
			}

			if (stopLosses.size > 0 || stoppedOut.size > 0) {
				log.info(
					`Restored ${stopLosses.size} stop-losses, ${stoppedOut.size} stopped-out records from DB`,
				);
			}

			// Set initial shared state
			const priceHistories = db.getAllPriceHistories();
			setSharedState({
				priceHistories,
				stoppedOut: new Map(stoppedOut),
			});

			// Run initial tick
			console.log(`[${label}] Running initial tick...`);
			await tick();

			// Start cron schedule
			job = new Cron(config.schedule.cronSchedule, tick);
			const nextRun = job.nextRun();
			console.log(
				`[${label}] Started — schedule: ${config.schedule.cronSchedule}`,
			);
			console.log(
				`[${label}] Next run: ${nextRun ? nextRun.toISOString() : "unknown"}`,
			);
		},

		async stop() {
			stopped = true;
			job?.stop();
			job = undefined;
			// Wait for any in-flight tick
			if (inflightRun) {
				await inflightRun;
			}
			if (db) {
				db.close();
				db = undefined;
			}
		},
	};
}

// --- Helpers ---

/** Format I96F32 price as a human-readable string */
function formatI96F32(value: bigint): string {
	const F32 = 1n << 32n;
	const whole = value / F32;
	return `${formatTao(whole * 1_000_000_000n)}`;
}

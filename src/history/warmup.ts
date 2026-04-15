import type { bittensor } from "@polkadot-api/descriptors";
import type { PolkadotClient } from "polkadot-api";
import { createBittensorClient } from "../api/createClient.ts";
import { RpcRateLimiter } from "../api/rateLimiter.ts";
import { getBlockHash, isZeroHash } from "../api/rpcThrottle.ts";
import { log } from "../rebalance/logger.ts";
import {
	DB_HISTORY_BLOCK_INTERVAL,
	OLDEST_BACKFILL_BLOCK,
	snapToDbHistory,
} from "./constants.ts";
import type { HistoryDatabase } from "./db.ts";
import { fetchAlphaPricesWithFallback } from "./priceFallback.ts";
import type { HistorySnapshot, SubnetSnapshot } from "./types.ts";

/** Blocks fetched concurrently — kept at 1 to avoid polkadot-api ws-middleware crash */
const BATCH_SIZE = 1;
const BLOCK_FETCH_TIMEOUT_MS = 30_000;
/** Estimated RPC calls per block fetch */
const RPC_CALLS_PER_BLOCK = 6;

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			reject(new Error(`Timeout fetching ${label} (${ms}ms)`));
		}, ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
		// When the timeout wins the race, the original promise is still in-flight.
		// Suppress its eventual rejection (e.g. DestroyedError when the archive
		// client is torn down) so it doesn't surface as an unhandled rejection.
		if (timedOut) {
			promise.catch(() => {});
		}
	}
}

/**
 * Warm up the shared history DB by fetching historical subnet snapshots
 * from an archive node.
 *
 * Fetches up to `windowSamples` historical data points at 25-block intervals,
 * going backwards from the current finalized block. Skips blocks already
 * present in the DB (idempotent & resumable).
 *
 * No-op if:
 * - `archiveEndpoints` is empty (ARCHIVE_WS_ENDPOINT not configured)
 * - The DB already has >= `windowSamples` block metas
 *
 * Disconnects the archive client after use.
 */
export async function warmupHistoryDb(
	db: HistoryDatabase,
	archiveEndpoints: string[],
	windowSamples: number,
): Promise<void> {
	if (archiveEndpoints.length === 0) return;

	let archiveClient: PolkadotClient | undefined;

	try {
		const { client, api } = createBittensorClient(archiveEndpoints);
		archiveClient = client;

		const finalizedBlock = await client.getFinalizedBlock();
		const currentBlock = finalizedBlock.number;

		// Compute the grid-aligned block range we need for the full window.
		// Check coverage of THIS range — not total row count — so that a DB
		// full of old samples doesn't trick us into skipping.
		const rawStart = currentBlock - windowSamples * DB_HISTORY_BLOCK_INTERVAL;
		const alignedStart = Math.max(
			snapToDbHistory(Math.max(rawStart, 0)),
			snapToDbHistory(OLDEST_BACKFILL_BLOCK),
		);
		const alignedEnd = snapToDbHistory(currentBlock);

		const allGridBlocks: number[] = [];
		for (
			let b = alignedStart;
			b <= alignedEnd;
			b += DB_HISTORY_BLOCK_INTERVAL
		) {
			allGridBlocks.push(b);
		}

		// Skip blocks already in DB (idempotent & resumable)
		const existingSet = new Set(db.getBlockMetas().map((m) => m.blockNumber));
		const missingBlocks = allGridBlocks.filter((b) => !existingSet.has(b));

		if (missingBlocks.length === 0) {
			log.info(
				`History warmup: recent ${allGridBlocks.length}-block window fully covered, skipping`,
			);
			return;
		}

		log.info(
			`History warmup: fetching ${missingBlocks.length} blocks (${allGridBlocks.length - missingBlocks.length} already in DB)`,
		);

		const limiter = new RpcRateLimiter({ concurrency: BATCH_SIZE });
		let fetched = 0;

		for (let i = 0; i < missingBlocks.length; i += BATCH_SIZE) {
			const batch = missingBlocks.slice(i, i + BATCH_SIZE);

			const results = await Promise.all(
				batch.map((blockNum) =>
					limiter.run(
						() =>
							withTimeout(
								fetchBlockSnapshot(client, api, blockNum),
								BLOCK_FETCH_TIMEOUT_MS,
								`block ${blockNum}`,
							).catch((err) => {
								log.warn(
									`History warmup: skipping block ${blockNum}: ${err instanceof Error ? err.message : String(err)}`,
								);
								return null;
							}),
						RPC_CALLS_PER_BLOCK,
					),
				),
			);

			for (const snapshot of results) {
				if (!snapshot) continue;
				db.recordSnapshot(snapshot);
				fetched++;
			}

			if (fetched > 0 && fetched % 50 === 0) {
				log.verbose(
					`History warmup: ${fetched}/${missingBlocks.length} blocks fetched`,
				);
			}
		}

		log.info(`History warmup complete: ${fetched} blocks added to DB`);
	} catch (err) {
		log.warn(
			`History warmup failed, continuing with cold start: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		if (archiveClient) {
			try {
				archiveClient.destroy();
			} catch {
				// Best-effort cleanup
			}
		}
	}
}

/**
 * Fetch a full HistorySnapshot for a single historical block from an
 * archive node. Same data shape as the backfill script produces.
 */
async function fetchBlockSnapshot(
	client: PolkadotClient,
	api: ReturnType<typeof client.getTypedApi<typeof bittensor>>,
	blockNum: number,
): Promise<HistorySnapshot | null> {
	const blockHash = await getBlockHash(client, blockNum);
	if (!blockHash || isZeroHash(blockHash)) return null;

	const atOptions = { at: blockHash };

	// Sequential queries: concurrent archive requests trigger a polkadot-api
	// ws-middleware bug when the RPC rate-limits responses.
	const dynamicInfos =
		await api.apis.SubnetInfoRuntimeApi.get_all_dynamic_info(atOptions);
	const immunityPeriod =
		await api.query.SubtensorModule.NetworkImmunityPeriod.getValue(atOptions);
	const subnetToPrune =
		await api.apis.SubnetInfoRuntimeApi.get_subnet_to_prune(atOptions);
	const priceMap = await fetchAlphaPricesWithFallback(api, atOptions);
	const timestamp = await api.query.Timestamp.Now.getValue(atOptions);

	const decoder = new TextDecoder();
	const subnets: SubnetSnapshot[] = [];

	for (const info of dynamicInfos) {
		if (info === undefined) continue;
		const name = decoder.decode(new Uint8Array(info.subnet_name)).trim();
		subnets.push({
			netuid: info.netuid,
			name,
			taoIn: info.tao_in,
			alphaIn: info.alpha_in,
			alphaOut: info.alpha_out,
			taoInEmission: info.tao_in_emission,
			alphaOutEmission: info.alpha_out_emission,
			alphaInEmission: info.alpha_in_emission,
			pendingAlphaEmission: info.pending_alpha_emission,
			pendingRootEmission: info.pending_root_emission,
			spotPrice: priceMap.get(info.netuid) ?? 0n,
			movingPrice: info.moving_price,
			subnetVolume: info.subnet_volume,
			tempo: info.tempo,
			blocksSinceLastStep: info.blocks_since_last_step,
			networkRegisteredAt: info.network_registered_at,
			immunityPeriod: Number(immunityPeriod),
			subnetToPrune: subnetToPrune ?? null,
		});
	}

	return {
		block: {
			blockHash,
			blockNumber: blockNum,
			timestamp: Number(timestamp),
		},
		subnets,
	};
}

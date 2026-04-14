import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createBittensorClient } from "../src/api/createClient.ts";
import { RpcRateLimiter } from "../src/api/rateLimiter.ts";
import { getBlockHash, isZeroHash } from "../src/api/rpcThrottle.ts";
import {
	BLOCK_INTERVAL,
	OLDEST_BACKFILL_BLOCK,
	openHistoryDatabase,
	snapToGrid,
} from "../src/history/index.ts";
import {
	fetchAlphaPricesWithFallback,
	resetRuntimeApiFlag,
} from "../src/history/priceFallback.ts";
import type { HistorySnapshot, SubnetSnapshot } from "../src/history/types.ts";

const BLOCKS_PER_DAY = 7200;

/** Format seconds as "Xh Ym Zs", omitting zero-valued leading units */
function formatDuration(totalSeconds: number): string {
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = Math.floor(totalSeconds % 60);
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

const PROGRESS_EVERY = 50;

/** Per-block fetch timeout — prevents hanging on unresponsive archive nodes */
const BLOCK_FETCH_TIMEOUT_MS = 30_000;

/** Maximum retry attempts per block before skipping */
const MAX_RETRIES = 3;

/** Base delay (ms) for exponential backoff between retries */
const RETRY_BASE_DELAY_MS = 2_000;

/** Estimated RPC calls per block fetch (hash + 5 sequential queries) */
const RPC_CALLS_PER_BLOCK = 6;

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Timeout fetching ${label} (${ms}ms)`)),
			ms,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseIntFlag(flag: string): number | undefined {
	const idx = process.argv.indexOf(flag);
	if (idx === -1) return undefined;
	const raw = process.argv[idx + 1];
	if (!raw) {
		console.error(`Error: ${flag} requires a value`);
		process.exit(1);
	}
	const val = Number.parseInt(raw, 10);
	if (Number.isNaN(val)) {
		console.error(`Error: ${flag} must be an integer`);
		process.exit(1);
	}
	return val;
}

const days = parseIntFlag("--days");
const fromBlock = parseIntFlag("--from");
const concurrency = parseIntFlag("--concurrency") ?? 1;
const rpm = parseIntFlag("--rpm") ?? 0;

if (days === undefined && fromBlock === undefined) {
	console.error(
		"Usage: bun backfill -- --days <number> [--from <block_number>] [--concurrency <n>] [--rpm <n>]",
	);
	process.exit(1);
}

if (days !== undefined && days <= 0) {
	console.error("Error: --days must be a positive integer");
	process.exit(1);
}
if (fromBlock !== undefined && fromBlock < 0) {
	console.error("Error: --from must be a non-negative integer");
	process.exit(1);
}
if (concurrency < 1) {
	console.error("Error: --concurrency must be >= 1");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const archiveEndpoints = process.env.ARCHIVE_WS_ENDPOINT?.split(",") ?? [];

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!archiveEndpoints.length) {
	console.warn(
		"ARCHIVE_WS_ENDPOINT is not set — cannot backfill without an archive node.",
	);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Get current finalized block from regular endpoint
// ---------------------------------------------------------------------------
const { client: regularClient } = createBittensorClient(wsEndpoints);
const finalizedBlock = await regularClient.getFinalizedBlock();
const currentBlock = finalizedBlock.number;
regularClient.destroy();

// ---------------------------------------------------------------------------
// Compute block range
// ---------------------------------------------------------------------------
const rawStart = snapToGrid(
	fromBlock ?? Math.max(0, currentBlock - (days ?? 0) * BLOCKS_PER_DAY),
);
const rangeStart = Math.max(rawStart, snapToGrid(OLDEST_BACKFILL_BLOCK));
const rangeEnd = snapToGrid(currentBlock);

if (rawStart < rangeStart) {
	console.warn(
		`⚠ Requested start block ${rawStart} is before the oldest backfillable block ${OLDEST_BACKFILL_BLOCK} ` +
			`(runtime APIs did not exist before this). Clamping to ${rangeStart}.`,
	);
}

const allGridBlocks: number[] = [];
for (let b = rangeStart; b <= rangeEnd; b += BLOCK_INTERVAL) {
	allGridBlocks.push(b);
}

// ---------------------------------------------------------------------------
// Check which blocks already exist in DB (auto-resume)
// ---------------------------------------------------------------------------
const DB_PATH = join("data", "history.sqlite");
const existingSet = new Set<number>();

try {
	const rawDb = new Database(DB_PATH, { readonly: true });
	const rows = rawDb
		.prepare(
			"SELECT block_number FROM blocks WHERE block_number BETWEEN ? AND ?",
		)
		.all(rangeStart, rangeEnd) as Array<{ block_number: number }>;
	for (const row of rows) existingSet.add(row.block_number);
	rawDb.close();
} catch {
	// DB doesn't exist yet — all blocks are missing
}

const missingBlocks = allGridBlocks.filter((b) => !existingSet.has(b));

const rangeLabel =
	fromBlock !== undefined ? `from block ${fromBlock}` : `${days} days`;
console.log(
	`Range: block ${rangeStart} → ${rangeEnd} (${rangeLabel}, ${allGridBlocks.length} grid blocks)`,
);
console.log(
	`Already in DB: ${existingSet.size} | Missing: ${missingBlocks.length}`,
);

if (missingBlocks.length === 0) {
	console.log("Nothing to backfill — all blocks already present.");
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Connect to archive node and open history DB
// ---------------------------------------------------------------------------
const { client: archiveClient, api } = createBittensorClient(archiveEndpoints);
const historyDb = openHistoryDatabase(DB_PATH);

const startTime = Date.now();
let backfilled = 0;

try {
	let skipped = 0;

	/** Fetch a single block with retries. Returns snapshot or null on failure. */
	async function fetchBlock(blockNum: number): Promise<HistorySnapshot | null> {
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				return await withTimeout(
					(async () => {
						const blockHash = await getBlockHash(archiveClient, blockNum);
						if (!blockHash || isZeroHash(blockHash)) {
							throw new Error(
								`Archive node returned zero/empty hash for block ${blockNum}`,
							);
						}

						const atOptions = { at: blockHash };

						// Sequential queries: concurrent archive requests trigger a
						// polkadot-api ws-middleware bug when the RPC rate-limits
						// responses (manifests as "Cannot destructure 'subscription'").
						const dynamicInfos =
							await api.apis.SubnetInfoRuntimeApi.get_all_dynamic_info(
								atOptions,
							);
						const immunityPeriod =
							await api.query.SubtensorModule.NetworkImmunityPeriod.getValue(
								atOptions,
							);
						const subnetToPrune =
							await api.apis.SubnetInfoRuntimeApi.get_subnet_to_prune(
								atOptions,
							);
						const priceMap = await fetchAlphaPricesWithFallback(api, atOptions);
						const timestamp = await api.query.Timestamp.Now.getValue(atOptions);

						const decoder = new TextDecoder();
						const subnets: SubnetSnapshot[] = [];

						for (const info of dynamicInfos) {
							if (info === undefined) continue;
							const name = decoder
								.decode(new Uint8Array(info.subnet_name))
								.trim();
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
						} satisfies HistorySnapshot;
					})(),
					BLOCK_FETCH_TIMEOUT_MS,
					`block ${blockNum}`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (attempt < MAX_RETRIES) {
					const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
					console.warn(
						`⚠ Block ${blockNum} attempt ${attempt}/${MAX_RETRIES} failed: ${msg} — retrying in ${(delay / 1000).toFixed(0)}s`,
					);
					await sleep(delay);
				} else {
					console.warn(
						`⚠ Skipping block ${blockNum} after ${MAX_RETRIES} attempts: ${msg}`,
					);
				}
			}
		}
		return null;
	}

	const limiter = new RpcRateLimiter({ concurrency, rpm });
	const rpmLabel = rpm > 0 ? `${rpm} rpm` : "unlimited";
	console.log(`Rate limits: concurrency=${concurrency}, rpm=${rpmLabel}`);

	for (let i = 0; i < missingBlocks.length; i += concurrency) {
		// Re-check the runtime API periodically as we move into newer blocks
		// where the API may have been deployed (blocks are processed ascending).
		if (i % 500 === 0) resetRuntimeApiFlag();

		const batch = missingBlocks.slice(i, i + concurrency);

		const results = await Promise.all(
			batch.map((b) => limiter.run(() => fetchBlock(b), RPC_CALLS_PER_BLOCK)),
		);

		for (const snapshot of results) {
			if (snapshot) {
				historyDb.recordSnapshot(snapshot);
				backfilled++;
			} else {
				skipped++;
			}
		}

		// Progress logging
		const done = Math.min(i + concurrency, missingBlocks.length);
		if (done % PROGRESS_EVERY < concurrency || done === missingBlocks.length) {
			const elapsed = (Date.now() - startTime) / 1000;
			const rate = done / elapsed;
			const remaining = (missingBlocks.length - done) / rate;
			console.log(
				`Progress: ${done}/${missingBlocks.length} (${((done / missingBlocks.length) * 100).toFixed(1)}%) — ` +
					`${formatDuration(elapsed)} elapsed, ~${formatDuration(remaining)} remaining`,
			);
		}
	}

	const elapsed = (Date.now() - startTime) / 1000;
	const skipMsg = skipped > 0 ? ` (${skipped} skipped after retries)` : "";
	console.log(
		`\nBackfill complete: ${backfilled} blocks in ${formatDuration(elapsed)}${skipMsg}`,
	);
} catch (err) {
	const elapsed = (Date.now() - startTime) / 1000;
	console.error(
		`\nBackfill failed after ${backfilled} blocks (${formatDuration(elapsed)}): ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exitCode = 1;
} finally {
	historyDb.close();
	archiveClient.destroy();
	process.exit();
}

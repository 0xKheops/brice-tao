import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createBittensorClient } from "../src/api/createClient.ts";
import { getBlockHash, isZeroHash } from "../src/api/rpcThrottle.ts";
import {
	BLOCK_INTERVAL,
	openHistoryDatabase,
	snapToGrid,
} from "../src/history/index.ts";
import type { HistorySnapshot, SubnetSnapshot } from "../src/history/types.ts";

/** Conversion factor from ×1e9 runtime API prices to I96F32 fixed-point */
const F32 = 1n << 32n;
const PRICE_SCALE = 1_000_000_000n;
const BLOCKS_PER_DAY = 7200;

const BATCH_SIZE = 5;
const PROGRESS_EVERY = 50;

/** Per-block fetch timeout — prevents hanging on unresponsive archive nodes */
const BLOCK_FETCH_TIMEOUT_MS = 30_000;

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

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const daysIdx = process.argv.indexOf("--days");
if (daysIdx === -1 || !process.argv[daysIdx + 1]) {
	console.error("Usage: bun backfill -- --days <number>");
	process.exit(1);
}
const days = Number.parseInt(process.argv[daysIdx + 1] as string, 10);
if (Number.isNaN(days) || days <= 0) {
	console.error("Error: --days must be a positive integer");
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
const rangeStart = snapToGrid(
	Math.max(0, currentBlock - days * BLOCKS_PER_DAY),
);
const rangeEnd = snapToGrid(currentBlock);

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

console.log(
	`Range: block ${rangeStart} → ${rangeEnd} (${days} days, ${allGridBlocks.length} grid blocks)`,
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
	for (let i = 0; i < missingBlocks.length; i += BATCH_SIZE) {
		const batch = missingBlocks.slice(i, i + BATCH_SIZE);

		const results = await Promise.all(
			batch.map(async (blockNum) => {
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

							const [
								dynamicInfos,
								immunityPeriod,
								subnetToPrune,
								alphaPrices,
								timestamp,
							] = await Promise.all([
								api.apis.SubnetInfoRuntimeApi.get_all_dynamic_info(atOptions),
								api.query.SubtensorModule.NetworkImmunityPeriod.getValue(
									atOptions,
								),
								api.apis.SubnetInfoRuntimeApi.get_subnet_to_prune(atOptions),
								api.apis.SwapRuntimeApi.current_alpha_price_all(atOptions),
								api.query.Timestamp.Now.getValue(atOptions),
							]);

							const priceMap = new Map<number, bigint>();
							for (const entry of alphaPrices) {
								priceMap.set(entry.netuid, (entry.price * F32) / PRICE_SCALE);
							}

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
					console.warn(
						`⚠ Skipping block ${blockNum}: ${err instanceof Error ? err.message : String(err)}`,
					);
					return null;
				}
			}),
		);

		for (const snapshot of results) {
			if (!snapshot) continue;
			historyDb.recordSnapshot(snapshot);
			backfilled++;
		}

		// Progress logging
		const done = Math.min(i + batch.length, missingBlocks.length);
		if (
			backfilled % PROGRESS_EVERY < BATCH_SIZE ||
			done === missingBlocks.length
		) {
			const elapsed = (Date.now() - startTime) / 1000;
			const rate = done / elapsed;
			const remaining = (missingBlocks.length - done) / rate;
			console.log(
				`Progress: ${done}/${missingBlocks.length} (${((done / missingBlocks.length) * 100).toFixed(1)}%) — ` +
					`${elapsed.toFixed(0)}s elapsed, ~${remaining.toFixed(0)}s remaining`,
			);
		}
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	console.log(`\nBackfill complete: ${backfilled} blocks in ${elapsed}s`);
} catch (err) {
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	console.error(
		`\nBackfill failed after ${backfilled} blocks (${elapsed}s): ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exitCode = 1;
} finally {
	historyDb.close();
	archiveClient.destroy();
	process.exit();
}

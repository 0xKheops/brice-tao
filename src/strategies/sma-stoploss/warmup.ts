import type { PolkadotClient } from "polkadot-api";
import { createBittensorClient } from "../../api/createClient.ts";
import { getBlockHash, isZeroHash } from "../../api/rpcThrottle.ts";
import { log } from "../../rebalance/logger.ts";
import type { PriceDatabase } from "./db.ts";

/** Conversion factor from ×1e9 runtime API prices to I96F32 fixed-point */
const F32 = 1n << 32n;
const PRICE_SCALE = 1_000_000_000n;

/**
 * Warm up price histories by fetching historical subnet spot prices
 * from an archive node and inserting into the price database.
 *
 * Fetches `maxSamples` historical data points at modulo-aligned `sampleInterval`
 * block intervals, going backwards from the current finalized block.
 *
 * Skips warmup if the database already has sufficient data.
 * Disconnects the archive client after use.
 */
export async function warmupPriceHistory(
	db: PriceDatabase,
	archiveEndpoints: string[],
	maxSamples: number,
	sampleInterval: number,
): Promise<void> {
	if (archiveEndpoints.length === 0) {
		return;
	}

	// Skip if DB already has data
	if (db.getPriceHistorySubnetCount() > 0) {
		log.info("Price history already populated in DB, skipping warmup");
		return;
	}

	let archiveClient: PolkadotClient | undefined;

	try {
		log.info(
			`Warming up SMA history from archive node (${maxSamples} samples × ${sampleInterval} blocks)...`,
		);

		const { client, api } = createBittensorClient(archiveEndpoints);
		archiveClient = client;

		// Get current finalized block
		const finalizedBlock = await client.getFinalizedBlock();
		const currentBlock = finalizedBlock.number;

		// Calculate modulo-aligned historical block numbers (oldest first)
		const rawStart = currentBlock - maxSamples * sampleInterval;
		const alignedStart =
			Math.ceil(Math.max(rawStart, sampleInterval) / sampleInterval) *
			sampleInterval;
		const alignedEnd =
			Math.floor(currentBlock / sampleInterval) * sampleInterval;

		const blockNumbers: number[] = [];
		for (let b = alignedStart; b <= alignedEnd; b += sampleInterval) {
			blockNumbers.push(b);
		}

		log.info(
			`Fetching ${blockNumbers.length} historical snapshots from block ${blockNumbers[0]} to ${alignedEnd}...`,
		);

		const BATCH_SIZE = 5;
		let fetched = 0;

		for (let i = 0; i < blockNumbers.length; i += BATCH_SIZE) {
			const batch = blockNumbers.slice(i, i + BATCH_SIZE);

			const results = await Promise.all(
				batch.map(async (blockNum) => {
					try {
						const blockHash = await getBlockHash(client, blockNum);
						if (!blockHash || isZeroHash(blockHash)) return null;

						const alphaPrices =
							await api.apis.SwapRuntimeApi.current_alpha_price_all({
								at: blockHash,
							});

						return { blockNum, alphaPrices };
					} catch {
						return null;
					}
				}),
			);

			for (const result of results) {
				if (!result) continue;

				for (const entry of result.alphaPrices) {
					if (entry.price <= 0n) continue;

					const spotPrice = (entry.price * F32) / PRICE_SCALE;
					db.insertPriceSample(
						entry.netuid,
						result.blockNum,
						spotPrice,
						maxSamples,
					);
				}

				fetched++;
			}

			if (fetched > 0 && fetched % 20 === 0) {
				log.verbose(
					`Warmup progress: ${fetched}/${blockNumbers.length} snapshots fetched`,
				);
			}
		}

		const subnetCount = db.getPriceHistorySubnetCount();
		log.info(`Warmup complete: ${subnetCount} subnets populated in DB`);
	} catch (err) {
		log.warn(
			`Archive warmup failed, starting with cold indicators: ${err instanceof Error ? err.message : String(err)}`,
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

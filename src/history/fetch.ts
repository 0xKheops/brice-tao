import { bittensor } from "@polkadot-api/descriptors";
import type { PolkadotClient } from "polkadot-api";
import type { HistorySnapshot, SubnetSnapshot } from "./types.ts";

/** Conversion factor from ×1e9 runtime API prices to I96F32 fixed-point */
const F32 = 1n << 32n;
const PRICE_SCALE = 1_000_000_000n;

/**
 * Fetch a complete history snapshot at the current finalized block.
 *
 * This is the **single source of truth** for populating the shared history DB.
 * All strategies must use this function (not their own fetch) to record history,
 * ensuring data consistency and predictability.
 *
 * Invariant: only finalized blocks are fetched (via client.getFinalizedBlock()).
 *
 * @param preFetchedBlock — optional pre-fetched finalized block to avoid a
 *   redundant RPC call when the caller already has it (e.g., recordCurrentBlock
 *   checks the grid before fetching snapshot data).
 */
export async function fetchHistorySnapshot(
	client: PolkadotClient,
	preFetchedBlock?: { hash: string; number: number },
): Promise<HistorySnapshot> {
	const api = client.getTypedApi(bittensor);
	const finalizedBlock = preFetchedBlock ?? (await client.getFinalizedBlock());

	const atOptions = { at: finalizedBlock.hash };

	const [dynamicInfos, immunityPeriod, subnetToPrune, alphaPrices] =
		await Promise.all([
			api.apis.SubnetInfoRuntimeApi.get_all_dynamic_info(atOptions),
			api.query.SubtensorModule.NetworkImmunityPeriod.getValue(atOptions),
			api.apis.SubnetInfoRuntimeApi.get_subnet_to_prune(atOptions),
			api.apis.SwapRuntimeApi.current_alpha_price_all(atOptions),
		]);

	// Build price lookup: netuid → I96F32 spot price
	const priceMap = new Map<number, bigint>();
	for (const entry of alphaPrices) {
		priceMap.set(entry.netuid, (entry.price * F32) / PRICE_SCALE);
	}

	const subnets: SubnetSnapshot[] = [];
	const decoder = new TextDecoder();

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
			blockHash: finalizedBlock.hash,
			blockNumber: finalizedBlock.number,
			timestamp: Date.now(),
		},
		subnets,
	};
}

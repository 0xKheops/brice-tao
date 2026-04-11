import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";

/**
 * Conversion factor from ×1e9 runtime API prices to I96F32 fixed-point.
 * Duplicated here to avoid circular imports with fetch.ts / warmup.ts.
 */
const F32 = 1n << 32n;
const PRICE_SCALE = 1_000_000_000n;

/**
 * Once the runtime API fails for a block, all earlier blocks will also lack it.
 * We remember the failure to skip the RPC attempt on subsequent calls.
 */
let runtimeApiAvailable = true;

/**
 * Fetch spot prices for all subnets, with fallback to storage-based
 * computation when `SwapRuntimeApi.current_alpha_price_all` is unavailable
 * (blocks before the runtime API was deployed).
 *
 * **Primary path**: runtime API → same result the on-chain `current_price()` returns.
 * **Fallback path**: reads `SubnetTAO` + `SubnetAlphaIn` storage entries and
 * computes `price = taoIn / alphaIn` (V2 constant-product formula). This is
 * correct for pre-V3 blocks because `SwapV3` was introduced at the same time
 * as the runtime API. SN0 is hardcoded to 1.0 (Stable mechanism).
 *
 * After the first runtime API failure, all subsequent calls go directly to the
 * storage fallback (the API is absent for an entire runtime version range).
 * Call {@link resetRuntimeApiFlag} when switching to a newer block range where
 * the API may exist.
 *
 * @returns Map from netuid → I96F32 spot price (bigint, ×2³²).
 */
export async function fetchAlphaPricesWithFallback(
	api: TypedApi<typeof bittensor>,
	atOptions: { at: string },
): Promise<Map<number, bigint>> {
	if (runtimeApiAvailable) {
		try {
			const alphaPrices =
				await api.apis.SwapRuntimeApi.current_alpha_price_all(atOptions);

			const priceMap = new Map<number, bigint>();
			for (const entry of alphaPrices) {
				// SN0 (Stable mechanism) is always 1:1 — normalize to avoid
				// reserve-ratio drift (matching the storage fallback below).
				priceMap.set(
					entry.netuid,
					entry.netuid === 0 ? F32 : (entry.price * F32) / PRICE_SCALE,
				);
			}
			return priceMap;
		} catch {
			// Runtime API not available at this block — remember and fall through
			runtimeApiAvailable = false;
		}
	}

	return computePricesFromStorage(api, atOptions);
}

/** Re-enable the runtime API attempt (e.g., when moving to a newer block range). */
export function resetRuntimeApiFlag(): void {
	runtimeApiAvailable = true;
}

/**
 * Compute spot prices from raw storage for all subnets.
 *
 * Uses the V2 constant-product formula: `price = taoIn / alphaIn`.
 * SN0 (root / Stable mechanism) is always 1.0.
 */
async function computePricesFromStorage(
	api: TypedApi<typeof bittensor>,
	atOptions: { at: string },
): Promise<Map<number, bigint>> {
	const [taoEntries, alphaEntries] = await Promise.all([
		api.query.SubtensorModule.SubnetTAO.getEntries(atOptions),
		api.query.SubtensorModule.SubnetAlphaIn.getEntries(atOptions),
	]);

	const taoMap = new Map<number, bigint>();
	for (const entry of taoEntries) {
		taoMap.set(entry.keyArgs[0], entry.value);
	}

	const alphaMap = new Map<number, bigint>();
	for (const entry of alphaEntries) {
		alphaMap.set(entry.keyArgs[0], entry.value);
	}

	const priceMap = new Map<number, bigint>();

	for (const [netuid, taoIn] of taoMap) {
		if (netuid === 0) {
			// SN0 (Stable mechanism): 1:1 TAO ↔ Alpha
			priceMap.set(0, F32);
			continue;
		}

		const alphaIn = alphaMap.get(netuid) ?? 0n;
		if (alphaIn <= 0n) continue;

		// V2 spot price: taoIn / alphaIn in I96F32 fixed-point
		priceMap.set(netuid, (taoIn * F32) / alphaIn);
	}

	return priceMap;
}

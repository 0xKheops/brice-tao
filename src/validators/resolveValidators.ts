import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import type { StakeEntry } from "../balances/getBalances.ts";
import { log } from "../rebalance/logger.ts";
import { pickBestValidatorByYield } from "./pickBestValidator.ts";

type Api = TypedApi<typeof bittensor>;

export interface ValidatorResolution {
	hotkeysByTarget: Map<number, string>;
	skipped: Array<{ netuid: number; reason: string }>;
}

/**
 * Resolve the validator hotkey for each target subnet.
 *
 * This is a **default fallback** for strategies that don't have their own
 * validator selection logic. It provides a reasonable baseline (reuse existing
 * positions, then pick by yield), but strategies should ideally implement
 * custom resolution that considers take rate, uptime, reputation, or
 * external data sources.
 *
 * ## Algorithm (per subnet)
 *
 * 1. **Reuse existing position** — If the coldkey already has stake on this
 *    subnet, pick the hotkey with the largest TAO-value position. This avoids
 *    unnecessary validator changes (which cost a `move_stake` call).
 * 2. **Yield-based selection** — If no existing position, call
 *    {@link pickBestValidatorByYield} to find the validator with the highest
 *    last-epoch alpha yield.
 * 3. **Fallback** — If yield selection fails (e.g., no eligible validators),
 *    use the optional `fallbackValidatorHotkey` (typically from the
 *    `VALIDATOR_HOTKEY` env var). If no fallback is set, the subnet is skipped.
 *
 * @param api - Typed Bittensor chain API
 * @param stakes - Current portfolio positions (used to detect existing hotkeys)
 * @param targetNetuids - Subnets that need a validator assigned
 * @param fallbackValidatorHotkey - Optional hotkey to use when yield selection fails
 */
export async function resolveValidators(
	api: Api,
	stakes: StakeEntry[],
	targetNetuids: number[],
	fallbackValidatorHotkey?: string,
): Promise<ValidatorResolution> {
	const hotkeysByTarget = new Map<number, string>();
	const skipped: ValidatorResolution["skipped"] = [];

	// Phase 1: Resolve from existing positions (no RPC needed)
	const needsRpcLookup: number[] = [];
	for (const netuid of targetNetuids) {
		const existing = stakes.filter((s) => s.netuid === netuid);
		if (existing.length > 0) {
			const bestExisting = [...existing].sort((a, b) => {
				if (b.taoValue !== a.taoValue) return b.taoValue > a.taoValue ? 1 : -1;
				if (b.stake !== a.stake) return b.stake > a.stake ? 1 : -1;
				return a.hotkey.localeCompare(b.hotkey);
			})[0];
			if (!bestExisting) {
				continue;
			}
			hotkeysByTarget.set(netuid, bestExisting.hotkey);
			log.verbose(
				`  Validator SN${netuid}: existing ${bestExisting.hotkey.slice(0, 8)}… (largest position)`,
			);
		} else {
			needsRpcLookup.push(netuid);
		}
	}

	// Phase 2: Parallel yield-based lookups for remaining subnets
	const results = await Promise.all(
		needsRpcLookup.map(async (netuid) => {
			try {
				const best = await pickBestValidatorByYield(api, netuid);
				return {
					netuid,
					hotkey: best.hotkey,
					uid: best.candidate.uid,
				} as const;
			} catch (err) {
				return { netuid, error: err } as const;
			}
		}),
	);

	for (const result of results) {
		if ("hotkey" in result && result.hotkey !== undefined) {
			hotkeysByTarget.set(result.netuid, result.hotkey);
			log.verbose(
				`  Validator SN${result.netuid}: yield-picked ${result.hotkey.slice(0, 8)}… (UID ${result.uid})`,
			);
		} else if (fallbackValidatorHotkey) {
			hotkeysByTarget.set(result.netuid, fallbackValidatorHotkey);
			log.warn(
				`Validator selection failed for SN${result.netuid}; falling back to VALIDATOR_HOTKEY (${fallbackValidatorHotkey.slice(0, 8)}…): ${String(result.error)}`,
			);
		} else {
			const reason =
				result.error instanceof Error
					? result.error.message
					: "unknown validator selection error";
			skipped.push({
				netuid: result.netuid,
				reason: `No validator selected for SN${result.netuid}: ${reason}`,
			});
			log.warn(
				`Skipping SN${result.netuid} destination: no yield candidate and VALIDATOR_HOTKEY not set`,
			);
		}
	}

	return { hotkeysByTarget, skipped };
}

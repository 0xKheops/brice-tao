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
			continue;
		}

		try {
			const best = await pickBestValidatorByYield(api, netuid);
			hotkeysByTarget.set(netuid, best.hotkey);
			log.verbose(
				`  Validator SN${netuid}: yield-picked ${best.hotkey.slice(0, 8)}… (UID ${best.candidate.uid})`,
			);
		} catch (err) {
			if (fallbackValidatorHotkey) {
				hotkeysByTarget.set(netuid, fallbackValidatorHotkey);
				log.warn(
					`Validator selection failed for SN${netuid}; falling back to VALIDATOR_HOTKEY (${fallbackValidatorHotkey.slice(0, 8)}…): ${String(err)}`,
				);
			} else {
				const reason =
					err instanceof Error
						? err.message
						: "unknown validator selection error";
				skipped.push({
					netuid,
					reason: `No validator selected for SN${netuid}: ${reason}`,
				});
				log.warn(
					`Skipping SN${netuid} destination: no yield candidate and VALIDATOR_HOTKEY not set`,
				);
			}
		}
	}

	return { hotkeysByTarget, skipped };
}

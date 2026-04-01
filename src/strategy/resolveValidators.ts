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
 * For each target subnet, resolve the validator hotkey to stake with.
 * Strategy: reuse the largest existing position's hotkey if present,
 * otherwise pick the best validator by alpha yield, falling back to
 * an optional default hotkey.
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

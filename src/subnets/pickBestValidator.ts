import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";

type Api = TypedApi<typeof bittensor>;

export interface ValidatorYieldCandidate {
	uid: number;
	hotkey: string;
	alphaStake: bigint;
	alphaDividends: bigint;
	yieldPerAlpha: number;
}

export interface BestValidatorResult {
	hotkey: string;
	candidate: ValidatorYieldCandidate;
}

/**
 * Pick best validator on a subnet from last-epoch realized alpha yield.
 * Strategy mirrors scripts/pick-validator-by-yield.ts.
 */
export async function pickBestValidatorByYield(
	api: Api,
	netuid: number,
): Promise<BestValidatorResult> {
	// Fetch selective metagraph with specific field property indexes:
	// [52] = hotkeys
	// [57] = validator_permit
	// [67] = alpha_stake
	// [71] = alpha_dividends_per_hotkey
	// [72] = validators
	const meta = await api.apis.SubnetInfoRuntimeApi.get_selective_metagraph(
		netuid,
		[52, 57, 67, 71, 72],
	);
	if (!meta) {
		throw new Error(`Subnet ${netuid} not found`);
	}

	const hotkeys = meta.hotkeys ?? [];
	const validatorPermit = meta.validator_permit ?? [];
	const alphaStake = meta.alpha_stake ?? [];
	const alphaDividendsPerHotkey = meta.alpha_dividends_per_hotkey ?? [];
	const validatorUids = new Set(meta.validators ?? []);

	const divsByHotkey = new Map<string, bigint>();
	for (const [hotkey, amount] of alphaDividendsPerHotkey) {
		divsByHotkey.set(hotkey, (divsByHotkey.get(hotkey) ?? 0n) + amount);
	}

	const candidates: ValidatorYieldCandidate[] = [];
	for (const uid of validatorUids) {
		if (!validatorPermit[uid]) continue;

		const hotkey = hotkeys[uid];
		if (!hotkey) continue;

		const stake = alphaStake[uid] ?? 0n;
		if (stake <= 0n) continue;

		const divs = divsByHotkey.get(hotkey) ?? 0n;
		const yieldPerAlpha = Number(divs) / Number(stake);

		candidates.push({
			uid,
			hotkey,
			alphaStake: stake,
			alphaDividends: divs,
			yieldPerAlpha,
		});
	}

	if (candidates.length === 0) {
		throw new Error(
			`No permitted validator candidate with non-zero stake on SN${netuid}`,
		);
	}

	candidates.sort((a, b) => {
		if (b.yieldPerAlpha !== a.yieldPerAlpha)
			return b.yieldPerAlpha - a.yieldPerAlpha;
		if (b.alphaStake !== a.alphaStake)
			return b.alphaStake > a.alphaStake ? 1 : -1;
		return a.uid - b.uid;
	});

	const best = candidates[0];
	if (!best) {
		throw new Error(`No validator candidate selected on SN${netuid}`);
	}
	return { hotkey: best.hotkey, candidate: best };
}

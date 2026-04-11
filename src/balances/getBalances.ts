import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { TAO } from "../rebalance/tao.ts";

export interface StakeEntry {
	hotkey: string;
	netuid: number;
	/** Alpha amount (in RAO-equivalent units) */
	stake: bigint;
	/** Alpha price: TAO per 1 whole alpha (RAO precision) */
	alphaPrice: bigint;
	/** Estimated TAO value of this stake */
	taoValue: bigint;
}

export interface Balances {
	/** Free TAO balance in RAO */
	free: bigint;
	/** Reserved TAO balance in RAO */
	reserved: bigint;
	/** Alpha stakes with TAO valuations */
	stakes: StakeEntry[];
	/** Total estimated value in RAO (free + reserved + all stakes in TAO) */
	totalTaoValue: bigint;
}

export async function getBalances(
	api: TypedApi<typeof bittensor>,
	address: string,
): Promise<Balances> {
	const [account, stakeInfos, alphaPrices] = await Promise.all([
		api.query.System.Account.getValue(address),
		api.apis.StakeInfoRuntimeApi.get_stake_info_for_coldkey(address),
		api.apis.SwapRuntimeApi.current_alpha_price_all(),
	]);

	const prices = new Map<number, bigint>();
	for (const entry of alphaPrices) {
		// SN0 (Stable mechanism) is always 1:1 — the runtime API returns a
		// reserve ratio that drifts, but actual trades are 1:1 with TAO.
		prices.set(entry.netuid, entry.netuid === 0 ? TAO : entry.price);
	}

	const stakes: StakeEntry[] = stakeInfos.map((s) => {
		const alphaPrice = prices.get(s.netuid) ?? 0n;
		const taoValue = (s.stake * alphaPrice) / TAO;
		return {
			hotkey: s.hotkey,
			netuid: s.netuid,
			stake: s.stake,
			alphaPrice,
			taoValue,
		};
	});

	const stakesTotalTao = stakes.reduce((sum, s) => sum + s.taoValue, 0n);
	const totalTaoValue =
		account.data.free + account.data.reserved + stakesTotalTao;

	return {
		free: account.data.free,
		reserved: account.data.reserved,
		stakes,
		totalTaoValue,
	};
}

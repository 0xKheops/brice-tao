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

function formatAmount(rao: bigint, symbol: string): string {
	const whole = rao / TAO;
	const frac = rao % TAO;
	return `${whole}.${frac.toString().padStart(9, "0")} ${symbol}`;
}

export async function getBalances(
	api: TypedApi<typeof bittensor>,
	address: string,
): Promise<Balances> {
	const [account, stakeInfos] = await Promise.all([
		api.query.System.Account.getValue(address),
		api.apis.StakeInfoRuntimeApi.get_stake_info_for_coldkey(address),
	]);

	// Collect unique netuids to fetch alpha prices
	const netuids = [...new Set(stakeInfos.map((s) => s.netuid))];
	const prices = new Map<number, bigint>();
	await Promise.all(
		netuids.map(async (netuid) => {
			const price = await api.apis.SwapRuntimeApi.current_alpha_price(netuid);
			prices.set(netuid, price);
		}),
	);

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

function _printBalances(address: string, balances: Balances): void {
	console.log(`\nBalances for ${address}`);
	console.log(`  Free:     ${formatAmount(balances.free, "τ")}`);
	console.log(`  Reserved: ${formatAmount(balances.reserved, "τ")}`);

	if (balances.stakes.length === 0) {
		console.log("  Stakes:   (none)");
	} else {
		console.log("  Stakes:");
		for (const s of balances.stakes) {
			console.log(
				`    SN${s.netuid.toString().padStart(3, " ")} | ${s.hotkey.slice(0, 8)}… | ${formatAmount(s.stake, "α")} ≈ ${formatAmount(s.taoValue, "τ")}`,
			);
		}
	}

	console.log(
		`\n  Total estimated value: ${formatAmount(balances.totalTaoValue, "τ")}`,
	);
}

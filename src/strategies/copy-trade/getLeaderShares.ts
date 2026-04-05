import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import type { Balances } from "../../balances/getBalances.ts";
import { getBalances } from "../../balances/getBalances.ts";
import { log } from "../../rebalance/logger.ts";
import { formatTao, TAO } from "../../rebalance/tao.ts";

type Api = TypedApi<typeof bittensor>;

export interface LeaderShare {
	netuid: number;
	/** Fraction of portfolio, e.g. 0.4 = 40% */
	share: number;
}

export interface LeaderSharesResult {
	shares: LeaderShare[];
	leaderBalances: Balances;
	/** Subnets dropped during dust filtering */
	filtered: Array<{ netuid: number; reason: string }>;
}

export async function getLeaderShares(
	api: Api,
	leaderAddress: string,
	followerTotalTaoValue: bigint,
	minPositionTao: bigint,
): Promise<LeaderSharesResult> {
	const leaderBalances = await getBalances(api, leaderAddress);

	// Aggregate stakes by netuid (leader may stake to multiple validators per subnet)
	const subnetTaoMap = new Map<number, bigint>();
	for (const entry of leaderBalances.stakes) {
		const current = subnetTaoMap.get(entry.netuid) ?? 0n;
		subnetTaoMap.set(entry.netuid, current + entry.taoValue);
	}

	const totalStakedTao = [...subnetTaoMap.values()].reduce(
		(sum, v) => sum + v,
		0n,
	);

	// SN0 safety fallback: if leader has no staked positions, allocate 100% to SN0
	if (totalStakedTao === 0n) {
		log.warn("leader has no staked positions — falling back to 100% SN0");
		return {
			shares: [{ netuid: 0, share: 1.0 }],
			leaderBalances,
			filtered: [],
		};
	}

	log.verbose("leader portfolio", {
		totalStakedTao: formatTao(totalStakedTao),
		subnets: subnetTaoMap.size,
	});

	// Compute raw shares and apply dust filter
	const followerTotalFloat = Number(followerTotalTaoValue) / Number(TAO);
	const minPositionFloat = Number(minPositionTao) / Number(TAO);

	const rawShares: LeaderShare[] = [];
	const filtered: Array<{ netuid: number; reason: string }> = [];

	for (const [netuid, taoValue] of subnetTaoMap) {
		const share = Number(taoValue) / Number(totalStakedTao);
		const estimatedPositionTao = share * followerTotalFloat;

		if (estimatedPositionTao < minPositionFloat) {
			filtered.push({
				netuid,
				reason: `position too small (${estimatedPositionTao.toFixed(2)} τ < minPositionTao ${minPositionFloat.toFixed(2)} τ)`,
			});
			continue;
		}

		rawShares.push({ netuid, share });
	}

	// Re-normalize after filtering so shares sum to 1.0
	const rawSum = rawShares.reduce((sum, s) => sum + s.share, 0);
	const shares =
		rawSum > 0
			? rawShares.map((s) => ({ netuid: s.netuid, share: s.share / rawSum }))
			: [];

	// Sort by netuid for deterministic output
	shares.sort((a, b) => a.netuid - b.netuid);
	filtered.sort((a, b) => a.netuid - b.netuid);

	if (filtered.length > 0) {
		log.info(`filtered ${filtered.length} dust subnets from leader portfolio`);
	}

	return { shares, leaderBalances, filtered };
}

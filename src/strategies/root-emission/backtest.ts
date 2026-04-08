import type { SubnetSnapshot } from "../../history/types.ts";
import type { StrategyTarget } from "../../rebalance/types.ts";
import type { BacktestStep, BacktestStrategy } from "../types.ts";
import { loadRootEmissionConfig } from "./config.ts";
import type { SubnetOnChainData } from "./fetchSubnetData.ts";
import { scoreSubnets } from "./scoreSubnets.ts";

const DUMMY_HOTKEY = "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM";

const CONFIG_PATH = new URL("./config.yaml", import.meta.url).pathname;

function snapshotToOnChainData(
	s: SubnetSnapshot,
	blockNumber: number,
): SubnetOnChainData {
	return {
		netuid: s.netuid,
		name: s.name,
		taoIn: s.taoIn,
		alphaIn: s.alphaIn,
		alphaOut: s.alphaOut,
		taoInEmission: s.taoInEmission,
		subnetVolume: s.subnetVolume,
		movingPrice: s.movingPrice,
		tempo: s.tempo,
		blocksSinceLastStep: s.blocksSinceLastStep,
		networkRegisteredAt: s.networkRegisteredAt,
		isImmune:
			BigInt(blockNumber) - s.networkRegisteredAt < BigInt(s.immunityPeriod),
		isPruneTarget: s.subnetToPrune === s.netuid,
	};
}

export function createBacktest(): BacktestStrategy {
	const config = loadRootEmissionConfig(CONFIG_PATH);
	const rootShare = config.strategy.rootSharePct / 100;
	const alphaShare = 1 - rootShare;

	return {
		observe() {
			// Stateless strategy — nothing to update between rebalances
			return { needsRebalance: false };
		},

		step(
			snapshots: SubnetSnapshot[],
			blockNumber: number,
			_timestamp: number,
			heldNetuids: Set<number>,
		): BacktestStep {
			const subnets = snapshots.map((s) =>
				snapshotToOnChainData(s, blockNumber),
			);
			const { winner } = scoreSubnets(
				subnets,
				config.strategy,
				heldNetuids,
				BigInt(blockNumber),
			);

			const targets: StrategyTarget[] = [];

			targets.push({
				netuid: 0,
				hotkey: DUMMY_HOTKEY,
				share: winner ? rootShare : 1,
			});

			if (winner) {
				targets.push({
					netuid: winner.netuid,
					hotkey: DUMMY_HOTKEY,
					share: alphaShare,
				});
			}

			return { targets };
		},
	};
}

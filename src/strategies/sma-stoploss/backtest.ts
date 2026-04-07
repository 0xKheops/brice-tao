import type { SubnetSnapshot } from "../../history/types.ts";
import type { StrategyTarget } from "../../rebalance/types.ts";
import type { BacktestStep, BacktestStrategy } from "../types.ts";
import { loadSmaStoplossConfig } from "./config.ts";
import type { SubnetOnChainData } from "./fetchSubnetData.ts";
import { scoreSubnets } from "./scoreSubnets.ts";
import type {
	PriceSample,
	StopOutRecord,
	SubnetPriceHistory,
} from "./types.ts";

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
		spotPrice: s.spotPrice,
		blocksSinceLastStep: s.blocksSinceLastStep,
		networkRegisteredAt: s.networkRegisteredAt,
		isImmune:
			BigInt(blockNumber) - s.networkRegisteredAt < BigInt(s.immunityPeriod),
		isPruneTarget: s.subnetToPrune === s.netuid,
	};
}

export function createBacktest(): BacktestStrategy {
	const config = loadSmaStoplossConfig(CONFIG_PATH);
	const maxSlots = config.strategy.maxSubnets;
	const slotShare = 1 / maxSlots;

	// Internal state — mirrors runner.ts
	const priceHistories: Map<number, SubnetPriceHistory> = new Map();
	const stopLosses: Map<number, { highWaterMark: bigint; stopPrice: bigint }> =
		new Map();
	const stoppedOut: Map<number, StopOutRecord> = new Map();

	function samplePrices(snapshots: SubnetSnapshot[], blockNumber: number) {
		for (const s of snapshots) {
			if (s.netuid === 0 || s.spotPrice <= 0n) continue;

			let history = priceHistories.get(s.netuid);
			if (!history) {
				history = { netuid: s.netuid, samples: [] };
				priceHistories.set(s.netuid, history);
			}

			history.samples.push({
				blockNumber,
				price: s.spotPrice,
			} satisfies PriceSample);

			if (history.samples.length > config.strategy.maxPriceSamples) {
				history.samples = history.samples.slice(
					-config.strategy.maxPriceSamples,
				);
			}
		}
	}

	function expireCooldowns(currentBlock: number) {
		const cooldownBlocks = BigInt(config.strategy.cooldownBlocks);
		for (const [netuid, record] of stoppedOut) {
			if (
				BigInt(currentBlock) - BigInt(record.triggeredAtBlock) >=
				cooldownBlocks
			) {
				stoppedOut.delete(netuid);
			}
		}
	}

	function updateStopLosses(
		snapshots: SubnetSnapshot[],
		blockNumber: number,
		heldNetuids: Set<number>,
	) {
		const priceMap = new Map(
			snapshots
				.filter((s) => s.spotPrice > 0n)
				.map((s) => [s.netuid, s.spotPrice]),
		);

		// Remove stop-losses for subnets no longer held
		for (const netuid of stopLosses.keys()) {
			if (!heldNetuids.has(netuid)) {
				stopLosses.delete(netuid);
			}
		}

		for (const netuid of heldNetuids) {
			if (netuid === 0) continue;
			const currentPrice = priceMap.get(netuid);
			if (!currentPrice || currentPrice <= 0n) continue;

			const existing = stopLosses.get(netuid);
			if (!existing) {
				// Initialize stop-loss for new/existing position
				const stopPrice =
					(currentPrice * BigInt(100 - config.strategy.stopLossPercent)) / 100n;
				stopLosses.set(netuid, {
					highWaterMark: currentPrice,
					stopPrice,
				});
				continue;
			}

			if (currentPrice > existing.highWaterMark) {
				const newStop =
					(currentPrice * BigInt(100 - config.strategy.stopLossPercent)) / 100n;
				existing.highWaterMark = currentPrice;
				existing.stopPrice = newStop;
			} else if (currentPrice < existing.stopPrice) {
				// Stop triggered
				stoppedOut.set(netuid, {
					netuid,
					triggeredAtBlock: blockNumber,
					exitPrice: currentPrice,
				});
				stopLosses.delete(netuid);
			}
		}
	}

	function doObserve(
		snapshots: SubnetSnapshot[],
		blockNumber: number,
		heldNetuids: Set<number>,
	) {
		samplePrices(snapshots, blockNumber);
		expireCooldowns(blockNumber);
		updateStopLosses(snapshots, blockNumber, heldNetuids);
	}

	return {
		observe(
			snapshots: SubnetSnapshot[],
			blockNumber: number,
			_timestamp: number,
			heldNetuids: Set<number>,
		): void {
			doObserve(snapshots, blockNumber, heldNetuids);
		},

		step(
			snapshots: SubnetSnapshot[],
			blockNumber: number,
			_timestamp: number,
			heldNetuids: Set<number>,
		): BacktestStep {
			// Observe first (updates indicators + stops)
			doObserve(snapshots, blockNumber, heldNetuids);

			// Score subnets
			const subnets = snapshots.map((s) =>
				snapshotToOnChainData(s, blockNumber),
			);
			const { winners } = scoreSubnets(
				subnets,
				config.strategy,
				heldNetuids,
				BigInt(blockNumber),
				priceHistories,
				stoppedOut,
			);

			// Build targets: each winner gets 1/maxSlots, remainder → SN0
			const targets: StrategyTarget[] = [];
			for (const w of winners) {
				targets.push({
					netuid: w.netuid,
					hotkey: DUMMY_HOTKEY,
					share: slotShare,
				});
			}

			const usedShare = targets.length * slotShare;
			const sn0Share = 1 - usedShare;
			if (sn0Share > 0.001) {
				targets.push({
					netuid: 0,
					hotkey: DUMMY_HOTKEY,
					share: sn0Share,
				});
			}

			return { targets };
		},
	};
}

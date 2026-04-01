import type { Balances, StakeEntry } from "../balances/getBalances.ts";
import type { AppConfig } from "../config/types.ts";
import { TAO } from "./constants.ts";
import { log } from "./logger.ts";
import type {
	MoveOperation,
	RebalanceOperation,
	RebalancePlan,
	StrategyTarget,
} from "./types.ts";

/** u64::MAX — used with move_stake to sweep all alpha for a hotkey on a subnet */
const U64_MAX = 18_446_744_073_709_551_615n;

interface ClassifiedPosition extends StakeEntry {
	classification: "keep" | "exit";
}

interface ResolvedTarget extends StrategyTarget {
	targetTaoValue: bigint;
}

/**
 * Compute the rebalance plan: given current balances and strategy targets
 * (with shares), convert shares to absolute TAO values and produce a list
 * of operations to reach the target allocation.
 */
export function computeRebalance(
	balances: Balances,
	targets: StrategyTarget[],
	config: AppConfig["rebalance"],
): RebalancePlan {
	if (targets.length === 0) {
		return { targets: [], operations: [], skipped: [] };
	}

	// 1. Reserve replenishment: if free balance is below the configured
	//    reserve, unstake the deficit from the biggest position first
	const targetSet = new Set(targets.map((t) => t.netuid));
	const classified = classifyPositions(balances.stakes, targetSet);
	const {
		operations: replenishOps,
		adjustedFree,
		adjustedPositions,
	} = replenishReserve(balances.free, classified, config);

	// 2. Compute available portfolio and per-target allocation
	const available = balances.totalTaoValue - config.freeReserveTao;
	if (available <= 0n) {
		return { targets, operations: replenishOps, skipped: [] };
	}

	const resolved: ResolvedTarget[] = targets.map((t) => ({
		...t,
		targetTaoValue:
			(available * BigInt(Math.round(t.share * 1e9))) / 1_000_000_000n,
	}));

	log.verbose(
		`Target allocation: ${resolved.length} subnets, ${formatTao(resolved[0]?.targetTaoValue ?? 0n)} τ each`,
	);
	for (const t of resolved) {
		log.verbose(
			`  Target SN${t.netuid}: ${formatTao(t.targetTaoValue)} τ (${t.hotkey.slice(0, 8)}…)`,
		);
	}

	for (const pos of adjustedPositions) {
		log.verbose(
			`  Position SN${pos.netuid} (${pos.hotkey.slice(0, 8)}…): ${formatTao(pos.taoValue)} τ → ${pos.classification}`,
		);
	}

	// 3. Generate rebalance operations from adjusted positions
	const plan = generateOperations(
		adjustedPositions,
		resolved,
		adjustedFree,
		config,
	);
	return {
		targets,
		operations: [...replenishOps, ...plan.operations],
		skipped: plan.skipped,
	};
}

function classifyPositions(
	currentPositions: StakeEntry[],
	targetPositions: Set<number>,
): ClassifiedPosition[] {
	return currentPositions.map((s) => {
		const classification: ClassifiedPosition["classification"] =
			targetPositions.has(s.netuid) ? "keep" : "exit";
		return { ...s, classification };
	});
}

/**
 * If free balance is below the reserve threshold, generate an unstake_partial
 * to replenish it. Prefers the biggest exit position; falls back to the
 * biggest overall position. Skips entirely if the source position cannot
 * cover the deficit without dropping below minStakeTao.
 */
function replenishReserve(
	freeBalance: bigint,
	positions: ClassifiedPosition[],
	config: AppConfig["rebalance"],
): {
	operations: RebalanceOperation[];
	adjustedFree: bigint;
	adjustedPositions: ClassifiedPosition[];
} {
	const noChange = {
		operations: [] as RebalanceOperation[],
		adjustedFree: freeBalance,
		adjustedPositions: positions,
	};

	const deficit = config.freeReserveTao - freeBalance;
	const driftMargin =
		(config.freeReserveTao *
			BigInt(Math.round(config.freeReserveTaoDriftPercent * 1e9))) /
		1_000_000_000n;
	if (
		deficit <= 0n ||
		deficit < config.minOperationTao ||
		deficit <= driftMargin
	)
		return noChange;

	const byValueDesc = (a: ClassifiedPosition, b: ClassifiedPosition) =>
		Number(b.taoValue - a.taoValue);
	const exits = positions
		.filter((p) => p.classification === "exit")
		.sort(byValueDesc);
	const source = exits[0] ?? [...positions].sort(byValueDesc)[0];

	if (!source || source.taoValue - deficit < config.minStakeTao)
		return noChange;

	const alphaToUnstake =
		source.alphaPrice > 0n ? (deficit * TAO) / source.alphaPrice : 0n;
	if (alphaToUnstake <= 0n) return noChange;

	log.info(
		`Reserve replenishment: unstaking ~${formatTao(deficit)} τ from SN${source.netuid} ` +
			`(free ${formatTao(freeBalance)} τ < reserve ${formatTao(config.freeReserveTao)} τ)`,
	);

	const operation: RebalanceOperation = {
		kind: "unstake_partial",
		netuid: source.netuid,
		hotkey: source.hotkey,
		alphaAmount: alphaToUnstake,
		estimatedTaoValue: deficit,
		limitPrice: 0n,
	};

	const adjustedPositions = positions.map((p) =>
		p === source
			? {
					...p,
					stake: p.stake - alphaToUnstake,
					taoValue: p.taoValue - deficit,
				}
			: p,
	);

	return {
		operations: [operation],
		adjustedFree: freeBalance + deficit,
		adjustedPositions,
	};
}

function generateOperations(
	positions: ClassifiedPosition[],
	targets: ResolvedTarget[],
	freeBalance: bigint,
	config: AppConfig["rebalance"],
): { operations: RebalanceOperation[]; skipped: RebalancePlan["skipped"] } {
	const operations: RebalanceOperation[] = [];
	const skipped: RebalancePlan["skipped"] = [];

	// Track how much TAO value is fulfilled per target subnet
	const fulfilled = new Map<number, bigint>();
	for (const t of targets) {
		const existing = positions
			.filter((p) => p.netuid === t.netuid)
			.reduce((sum, p) => sum + p.taoValue, 0n);
		fulfilled.set(t.netuid, existing);
	}

	// 1. Full exits — swap to underweight target, moving hotkey on origin subnet first if needed.
	for (const pos of positions) {
		if (pos.classification !== "exit") continue;
		if (pos.taoValue < config.minOperationTao) {
			skipped.push({
				netuid: pos.netuid,
				reason: `Position too small to exit (${formatTao(pos.taoValue)} τ)`,
			});
			continue;
		}

		const bestSwapTarget = targets
			.filter((t) => {
				const currentFulfilled = fulfilled.get(t.netuid) ?? 0n;
				const deficit = t.targetTaoValue - currentFulfilled;
				if (deficit <= 0n) return false;
				return currentFulfilled + pos.taoValue <= 2n * t.targetTaoValue;
			})
			.sort((a, b) =>
				Number(
					b.targetTaoValue -
						(fulfilled.get(b.netuid) ?? 0n) -
						(a.targetTaoValue - (fulfilled.get(a.netuid) ?? 0n)),
				),
			)[0];

		if (bestSwapTarget) {
			const needsHotkeyChange = bestSwapTarget.hotkey !== pos.hotkey;
			if (needsHotkeyChange) {
				operations.push(moveOp(pos.netuid, pos.hotkey, bestSwapTarget.hotkey));
			}
			operations.push({
				kind: "swap",
				originNetuid: pos.netuid,
				destinationNetuid: bestSwapTarget.netuid,
				hotkey: needsHotkeyChange ? bestSwapTarget.hotkey : pos.hotkey,
				alphaAmount: pos.stake,
				estimatedTaoValue: pos.taoValue,
				limitPrice: 0n,
			});
			if (needsHotkeyChange) {
				log.verbose(
					`  OP: move hotkey SN${pos.netuid} + swap SN${pos.netuid}→SN${bestSwapTarget.netuid}: ~${formatTao(pos.taoValue)} τ`,
				);
			} else {
				log.verbose(
					`  OP: swap SN${pos.netuid}→SN${bestSwapTarget.netuid}: ~${formatTao(pos.taoValue)} τ (matching hotkey)`,
				);
			}
			fulfilled.set(
				bestSwapTarget.netuid,
				(fulfilled.get(bestSwapTarget.netuid) ?? 0n) + pos.taoValue,
			);
			continue;
		}

		operations.push({
			kind: "unstake",
			netuid: pos.netuid,
			hotkey: pos.hotkey,
			alphaAmount: pos.stake,
			limitPrice: 0n,
			estimatedTaoValue: pos.taoValue,
		});
		log.verbose(
			`  OP: unstake SN${pos.netuid}: ~${formatTao(pos.taoValue)} τ (no swap target within overfill cap)`,
		);
	}

	// 2. Overweight reductions — swap excess to underweight target.
	for (const target of targets) {
		const keepPositions = positions.filter(
			(p) => p.netuid === target.netuid && p.classification === "keep",
		);
		for (const pos of keepPositions) {
			const excess = pos.taoValue - target.targetTaoValue;
			if (excess < config.minRebalanceTao) continue;

			const maxReducible = pos.taoValue - config.minStakeTao;
			const reduceAmount = excess < maxReducible ? excess : maxReducible;
			if (reduceAmount < config.minRebalanceTao) {
				skipped.push({
					netuid: pos.netuid,
					reason: `Cannot reduce: would leave position below minimum (${formatTao(pos.taoValue - reduceAmount)} τ)`,
				});
				continue;
			}

			const reduceAlpha =
				pos.alphaPrice > 0n ? (reduceAmount * TAO) / pos.alphaPrice : 0n;
			if (reduceAlpha <= 0n) continue;

			const fullSwapTarget = targets
				.filter((destTarget) => {
					const destFulfilled = fulfilled.get(destTarget.netuid) ?? 0n;
					const destDeficit = destTarget.targetTaoValue - destFulfilled;
					if (destDeficit <= 0n) return false;
					return destFulfilled + reduceAmount <= 2n * destTarget.targetTaoValue;
				})
				.sort((a, b) =>
					Number(
						b.targetTaoValue -
							(fulfilled.get(b.netuid) ?? 0n) -
							(a.targetTaoValue - (fulfilled.get(a.netuid) ?? 0n)),
					),
				)[0];

			if (fullSwapTarget) {
				const destFulfilled = fulfilled.get(fullSwapTarget.netuid) ?? 0n;
				const needsHotkeyChange = fullSwapTarget.hotkey !== pos.hotkey;
				if (needsHotkeyChange) {
					operations.push(
						moveOp(pos.netuid, pos.hotkey, fullSwapTarget.hotkey, reduceAlpha),
					);
				}
				operations.push({
					kind: "swap",
					originNetuid: pos.netuid,
					destinationNetuid: fullSwapTarget.netuid,
					hotkey: needsHotkeyChange ? fullSwapTarget.hotkey : pos.hotkey,
					alphaAmount: reduceAlpha,
					estimatedTaoValue: reduceAmount,
					limitPrice: 0n,
				});
				if (needsHotkeyChange) {
					log.verbose(
						`  OP: move hotkey SN${pos.netuid} + swap overweight SN${pos.netuid}→SN${fullSwapTarget.netuid}: ~${formatTao(reduceAmount)} τ`,
					);
				} else {
					log.verbose(
						`  OP: swap overweight SN${pos.netuid}→SN${fullSwapTarget.netuid}: ~${formatTao(reduceAmount)} τ (matching hotkey)`,
					);
				}
				fulfilled.set(fullSwapTarget.netuid, destFulfilled + reduceAmount);
			} else {
				operations.push({
					kind: "unstake_partial",
					netuid: pos.netuid,
					hotkey: pos.hotkey,
					alphaAmount: reduceAlpha,
					limitPrice: 0n,
					estimatedTaoValue: reduceAmount,
				});
				log.verbose(
					`  OP: unstake overweight SN${pos.netuid}: ~${formatTao(reduceAmount)} τ`,
				);
			}
		}
	}

	// 3. Stake from free balance — remaining underweight targets
	let availableFree = freeBalance - config.freeReserveTao;

	for (const op of operations) {
		if (op.kind === "unstake" || op.kind === "unstake_partial") {
			availableFree += op.estimatedTaoValue;
		}
	}

	if (availableFree < 0n) availableFree = 0n;

	for (const target of targets) {
		const currentFulfilled = fulfilled.get(target.netuid) ?? 0n;
		const deficit = target.targetTaoValue - currentFulfilled;
		if (deficit < config.minRebalanceTao) continue;

		const stakeAmount = deficit < availableFree ? deficit : availableFree;
		if (stakeAmount < config.minRebalanceTao) {
			skipped.push({
				netuid: target.netuid,
				reason: `Insufficient free balance for target (need ${formatTao(deficit)} τ, have ${formatTao(availableFree)} τ)`,
			});
			continue;
		}

		operations.push({
			kind: "stake",
			netuid: target.netuid,
			hotkey: target.hotkey,
			taoAmount: stakeAmount,
			limitPrice: 0n,
		});

		fulfilled.set(target.netuid, currentFulfilled + stakeAmount);
		availableFree -= stakeAmount;

		log.verbose(
			`  OP: stake SN${target.netuid} with ${target.hotkey.slice(0, 8)}…: ${formatTao(stakeAmount)} τ`,
		);
	}

	return { operations, skipped };
}

function formatTao(rao: bigint): string {
	const whole = rao / TAO;
	const frac = ((rao % TAO) * 1000n) / TAO;
	return `${whole}.${frac.toString().padStart(3, "0")}`;
}

function moveOp(
	netuid: number,
	originHotkey: string,
	destinationHotkey: string,
	alphaAmount: bigint = U64_MAX,
): MoveOperation {
	return {
		kind: "move",
		netuid,
		originHotkey,
		destinationHotkey,
		alphaAmount,
	};
}

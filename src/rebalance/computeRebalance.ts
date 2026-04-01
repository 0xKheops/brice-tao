import type { Balances, StakeEntry } from "../balances/getBalances.ts";
import type { AppConfig } from "../config/types.ts";
import type { SubnetScore } from "../subnets/getBestSubnets.ts";
import { TAO } from "./constants.ts";
import { log } from "./logger.ts";
import type {
	MoveOperation,
	RebalanceOperation,
	RebalancePlan,
	TargetSubnet,
} from "./types.ts";

/** u64::MAX — used with move_stake to sweep all alpha for a hotkey on a subnet */
const U64_MAX = 18_446_744_073_709_551_615n;

interface ClassifiedPosition extends StakeEntry {
	classification: "keep" | "exit";
}

/**
 * Determine the target subnets and per-subnet allocation from the portfolio
 * and eligible list. This is execution sizing: how many subnets and how much each.
 */
export function selectTargets(
	balances: Balances,
	eligibleSubnets: SubnetScore[],
	config: AppConfig["rebalance"],
): { targets: TargetSubnet[] } {
	const available = balances.totalTaoValue - config.freeReserveTao;
	if (available <= 0n) {
		log.warn("Portfolio too small to rebalance (below free reserve)");
		return { targets: [] };
	}

	const x = Math.min(
		config.maxSubnets,
		Math.max(Number(balances.totalTaoValue / config.minPositionTao), 1),
		Math.max(eligibleSubnets.length, 1),
	);

	if (x < 1) {
		log.warn("Not enough TAO for even one position");
		return { targets: [] };
	}

	const targetNetuids = eligibleSubnets.slice(0, x).map((s) => s.netuid);
	while (targetNetuids.length < x) {
		if (!targetNetuids.includes(0)) {
			targetNetuids.push(0);
		} else {
			break;
		}
	}

	const targetTaoPerSubnet = available / BigInt(targetNetuids.length);
	const targets: TargetSubnet[] = targetNetuids.map((netuid) => ({
		netuid,
		targetTaoValue: targetTaoPerSubnet,
	}));

	log.verbose(
		`Target allocation: ${targetNetuids.length} subnets, ${formatTao(targetTaoPerSubnet)} τ each`,
	);
	for (const t of targets) {
		log.verbose(`  Target SN${t.netuid}: ${formatTao(t.targetTaoValue)} τ`);
	}

	return { targets };
}

/**
 * Compute the rebalance plan: given current balances, pre-selected targets,
 * and pre-resolved validator hotkeys, produce a list of operations to reach
 * equal-weight allocation across the target subnets.
 */
export function computeRebalance(
	balances: Balances,
	targets: TargetSubnet[],
	hotkeysByTarget: Map<number, string>,
	config: AppConfig["rebalance"],
): RebalancePlan {
	if (targets.length === 0) {
		return { targets: [], operations: [], skipped: [] };
	}

	const targetSet = new Set(targets.map((t) => t.netuid));
	const classified = classifyPositions(balances.stakes, targetSet);

	for (const pos of classified) {
		log.verbose(
			`  Position SN${pos.netuid} (${pos.hotkey.slice(0, 8)}…): ${formatTao(pos.taoValue)} τ → ${pos.classification}`,
		);
	}

	return generateOperations(
		classified,
		targets,
		hotkeysByTarget,
		balances.free,
		config,
	);
}

function classifyPositions(
	stakes: StakeEntry[],
	targetSet: Set<number>,
): ClassifiedPosition[] {
	return stakes.map((s) => {
		const classification: ClassifiedPosition["classification"] = targetSet.has(
			s.netuid,
		)
			? "keep"
			: "exit";
		return { ...s, classification };
	});
}

function generateOperations(
	positions: ClassifiedPosition[],
	targets: TargetSubnet[],
	targetHotkeys: Map<number, string>,
	freeBalance: bigint,
	config: AppConfig["rebalance"],
): RebalancePlan {
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
				// Allow overfilling up to 2× target allocation (prefer exact-fit via sort)
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
			const targetHotkey = targetHotkeys.get(bestSwapTarget.netuid);
			const needsHotkeyChange = targetHotkey && targetHotkey !== pos.hotkey;
			// When the destination validator differs from the current hotkey, we must
			// reassign the hotkey BEFORE swapping. Doing it after would hit the
			// per-block StakingOperationRateLimitExceeded error because both the swap
			// (via stake_into_subnet) and the move (via validate_stake_transition)
			// touch the same (hotkey, coldkey, dest_netuid) rate-limit key.
			//
			// By moving the hotkey on the ORIGIN subnet first (same-subnet moves
			// don't set the rate limiter), then swapping under the new hotkey, each
			// operation uses a different rate-limit key and both succeed.
			if (needsHotkeyChange) {
				operations.push(moveOp(pos.netuid, pos.hotkey, targetHotkey));
			}
			operations.push({
				kind: "swap",
				originNetuid: pos.netuid,
				destinationNetuid: bestSwapTarget.netuid,
				hotkey: needsHotkeyChange ? targetHotkey : pos.hotkey,
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

	// 2. Overweight reductions — swap excess to underweight target, then move hotkey if needed.
	for (const target of targets) {
		const keepPositions = positions.filter(
			(p) => p.netuid === target.netuid && p.classification === "keep",
		);
		for (const pos of keepPositions) {
			const excess = pos.taoValue - target.targetTaoValue;
			if (excess < config.minRebalanceTao) continue;

			// Ensure remaining position stays above minStakeTao
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
				const targetHotkey = targetHotkeys.get(fullSwapTarget.netuid);
				const needsHotkeyChange = targetHotkey && targetHotkey !== pos.hotkey;
				// Same rate-limit avoidance as Phase 1: move hotkey on origin subnet
				// first, then swap under the new hotkey to avoid conflicting
				// (hotkey, coldkey, netuid) rate-limit keys within the same block.
				// Only move the partial reduceAlpha amount so the retained position
				// stays on its original hotkey.
				if (needsHotkeyChange) {
					operations.push(
						moveOp(pos.netuid, pos.hotkey, targetHotkey, reduceAlpha),
					);
				}
				operations.push({
					kind: "swap",
					originNetuid: pos.netuid,
					destinationNetuid: fullSwapTarget.netuid,
					hotkey: needsHotkeyChange ? targetHotkey : pos.hotkey,
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

	// Clamp after unstake proceeds so the reserve "debt" is repaid first
	if (availableFree < 0n) availableFree = 0n;

	for (const target of targets) {
		const currentFulfilled = fulfilled.get(target.netuid) ?? 0n;
		const deficit = target.targetTaoValue - currentFulfilled;
		if (deficit < config.minRebalanceTao) continue;

		const targetHotkey = targetHotkeys.get(target.netuid);
		if (!targetHotkey) {
			skipped.push({
				netuid: target.netuid,
				reason: "No validator hotkey resolved for target subnet",
			});
			continue;
		}

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
			hotkey: targetHotkey,
			taoAmount: stakeAmount,
			limitPrice: 0n,
		});

		fulfilled.set(target.netuid, currentFulfilled + stakeAmount);
		availableFree -= stakeAmount;

		log.verbose(
			`  OP: stake SN${target.netuid} with ${targetHotkey.slice(0, 8)}…: ${formatTao(stakeAmount)} τ`,
		);
	}

	return { targets, operations, skipped };
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
	/**
	 * Amount of alpha to move. Defaults to the maximum value via U64_MAX.
	 * For full move, it's recommended to use the default value (it will not cost more fee as it's using fixed-width encoding, and fixed weight).
	 * For partial reductions, calculate the alpha amount corresponding to the TAO reduction to avoid unnecessarily moving more stake than needed.
	 */
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

import type { Balances, StakeEntry } from "../getBalances.ts";
import type { SubnetMomentum } from "../getMostProfitableSubnets.ts";
import {
	FREE_RESERVE_TAO,
	MAX_SUBNETS,
	MIN_OPERATION_TAO,
	MIN_POSITION_TAO,
	MIN_STAKE_TAO,
	SLIPPAGE_FACTOR,
	TAO,
} from "./constants.ts";
import { log } from "./logger.ts";
import type {
	ClassifiedPosition,
	RebalanceOperation,
	RebalancePlan,
	TargetSubnet,
} from "./types.ts";

/**
 * Compute the rebalance plan: given current balances and profitable subnets,
 * produce a list of operations to reach equal-weight allocation across the top X subnets.
 */
export function computeRebalance(
	balances: Balances,
	profitable: SubnetMomentum[],
	validatorHotkey: string,
): RebalancePlan {
	const available = balances.totalTaoValue - FREE_RESERVE_TAO;
	if (available <= 0n) {
		log.warn("Portfolio too small to rebalance (below free reserve)");
		return { targets: [], operations: [], skipped: [] };
	}

	// Determine X: how many subnets to target
	const x = Math.min(
		MAX_SUBNETS,
		Number(available / MIN_POSITION_TAO),
		Math.max(profitable.length, 1), // at least 1 target (netuid 0)
	);

	if (x < 1) {
		log.warn("Not enough TAO for even one position");
		return { targets: [], operations: [], skipped: [] };
	}

	// Select target subnets — fill with netuid 0 if fewer profitable than X
	const targetNetuids = profitable.slice(0, x).map((s) => s.netuid);
	while (targetNetuids.length < x) {
		if (!targetNetuids.includes(0)) {
			targetNetuids.push(0);
		} else {
			break; // already have netuid 0, can't fill further
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

	// Classify existing positions
	const targetSet = new Set(targetNetuids);
	const classified = classifyPositions(
		balances.stakes,
		targetSet,
		validatorHotkey,
	);

	for (const pos of classified) {
		log.verbose(
			`  Position SN${pos.netuid} (${pos.hotkey.slice(0, 8)}…): ${formatTao(pos.taoValue)} τ → ${pos.classification}`,
		);
	}

	// Generate operations
	return generateOperations(
		classified,
		targets,
		balances.free,
		validatorHotkey,
	);
}

function classifyPositions(
	stakes: StakeEntry[],
	targetSet: Set<number>,
	validatorHotkey: string,
): ClassifiedPosition[] {
	return stakes.map((s) => {
		const isTarget = targetSet.has(s.netuid);
		const isCorrectHotkey = s.hotkey === validatorHotkey;

		let classification: ClassifiedPosition["classification"];
		if (isTarget && isCorrectHotkey) {
			classification = "keep";
		} else if (isTarget && !isCorrectHotkey) {
			classification = "mismatch_in_target";
		} else if (!isTarget && isCorrectHotkey) {
			classification = "exit_swap";
		} else {
			classification = "exit_unstake";
		}

		return { ...s, classification };
	});
}

function generateOperations(
	positions: ClassifiedPosition[],
	targets: TargetSubnet[],
	freeBalance: bigint,
	validatorHotkey: string,
): RebalancePlan {
	const operations: RebalanceOperation[] = [];
	const skipped: RebalancePlan["skipped"] = [];

	// Track how much TAO value is fulfilled per target subnet
	const fulfilled = new Map<number, bigint>();
	for (const t of targets) {
		const existing = positions
			.filter((p) => p.netuid === t.netuid && p.classification === "keep")
			.reduce((sum, p) => sum + p.taoValue, 0n);
		fulfilled.set(t.netuid, existing);
	}

	// 1. Full exits — wrong hotkey (mismatch in target or exit_unstake)
	for (const pos of positions) {
		if (
			pos.classification === "exit_unstake" ||
			pos.classification === "mismatch_in_target"
		) {
			if (pos.taoValue < MIN_OPERATION_TAO) {
				skipped.push({
					netuid: pos.netuid,
					reason: `Position too small to unstake (${formatTao(pos.taoValue)} τ)`,
				});
				continue;
			}
			const limitPrice = applySlippageSell(pos.alphaPrice);
			operations.push({
				kind: "unstake",
				netuid: pos.netuid,
				hotkey: pos.hotkey,
				limitPrice,
				estimatedTaoValue: pos.taoValue,
			});
			log.verbose(
				`  OP: unstake SN${pos.netuid} (${pos.classification}): ~${formatTao(pos.taoValue)} τ`,
			);
		}
	}

	// 2. Swaps — exit positions with correct hotkey → underweight targets
	const swappable = positions.filter((p) => p.classification === "exit_swap");
	const underweightTargets = targets
		.filter((t) => {
			const f = fulfilled.get(t.netuid) ?? 0n;
			return f < t.targetTaoValue;
		})
		.sort((a, b) =>
			// Fill most underweight first
			Number(
				a.targetTaoValue -
					(fulfilled.get(a.netuid) ?? 0n) -
					(b.targetTaoValue - (fulfilled.get(b.netuid) ?? 0n)),
			),
		);

	for (const exitPos of swappable) {
		let remainingAlpha = exitPos.stake;
		let remainingTaoValue = exitPos.taoValue;

		for (const target of underweightTargets) {
			if (remainingTaoValue < MIN_OPERATION_TAO) break;

			const currentFulfilled = fulfilled.get(target.netuid) ?? 0n;
			const deficit = target.targetTaoValue - currentFulfilled;
			if (deficit < MIN_OPERATION_TAO) continue;

			// Swap min(remaining, deficit) TAO worth
			const swapTaoValue =
				remainingTaoValue < deficit ? remainingTaoValue : deficit;
			const swapAlpha =
				exitPos.alphaPrice > 0n
					? (swapTaoValue * TAO) / exitPos.alphaPrice
					: 0n;

			if (swapAlpha <= 0n) continue;

			// Find the destination alpha price for limit_price
			const destAlphaPrice = getAlphaPriceForNetuid(target.netuid, positions);
			const limitPrice = applySlippageBuy(destAlphaPrice);

			operations.push({
				kind: "swap",
				originNetuid: exitPos.netuid,
				destinationNetuid: target.netuid,
				hotkey: validatorHotkey,
				alphaAmount: swapAlpha,
				estimatedTaoValue: swapTaoValue,
				limitPrice,
			});

			fulfilled.set(target.netuid, currentFulfilled + swapTaoValue);
			remainingAlpha -= swapAlpha;
			remainingTaoValue -= swapTaoValue;

			log.verbose(
				`  OP: swap SN${exitPos.netuid}→SN${target.netuid}: ~${formatTao(swapTaoValue)} τ`,
			);
		}

		// If there's remaining alpha from this exit position, unstake it
		if (remainingTaoValue >= MIN_OPERATION_TAO && remainingAlpha > 0n) {
			const limitPrice = applySlippageSell(exitPos.alphaPrice);
			if (remainingTaoValue === exitPos.taoValue) {
				// Full unstake
				operations.push({
					kind: "unstake",
					netuid: exitPos.netuid,
					hotkey: exitPos.hotkey,
					limitPrice,
					estimatedTaoValue: remainingTaoValue,
				});
			} else {
				operations.push({
					kind: "unstake_partial",
					netuid: exitPos.netuid,
					hotkey: exitPos.hotkey,
					alphaAmount: remainingAlpha,
					limitPrice,
					estimatedTaoValue: remainingTaoValue,
				});
			}
			log.verbose(
				`  OP: unstake remainder SN${exitPos.netuid}: ~${formatTao(remainingTaoValue)} τ`,
			);
		}
	}

	// 3. Overweight reductions — "keep" positions above target
	for (const target of targets) {
		const keepPositions = positions.filter(
			(p) => p.netuid === target.netuid && p.classification === "keep",
		);
		for (const pos of keepPositions) {
			const excess = pos.taoValue - target.targetTaoValue;
			if (excess < MIN_OPERATION_TAO) continue;

			// Ensure remaining position stays above MIN_STAKE_TAO
			const maxReducible = pos.taoValue - MIN_STAKE_TAO;
			const reduceAmount = excess < maxReducible ? excess : maxReducible;
			if (reduceAmount < MIN_OPERATION_TAO) {
				skipped.push({
					netuid: pos.netuid,
					reason: `Cannot reduce: would leave position below minimum (${formatTao(pos.taoValue - reduceAmount)} τ)`,
				});
				continue;
			}

			const reduceAlpha =
				pos.alphaPrice > 0n ? (reduceAmount * TAO) / pos.alphaPrice : 0n;
			if (reduceAlpha <= 0n) continue;

			// Try to swap excess to an underweight target
			let swapped = false;
			for (const destTarget of underweightTargets) {
				const destFulfilled = fulfilled.get(destTarget.netuid) ?? 0n;
				const destDeficit = destTarget.targetTaoValue - destFulfilled;
				if (destDeficit < MIN_OPERATION_TAO) continue;

				const swapTaoValue =
					reduceAmount < destDeficit ? reduceAmount : destDeficit;
				const swapAlpha =
					pos.alphaPrice > 0n ? (swapTaoValue * TAO) / pos.alphaPrice : 0n;
				if (swapAlpha <= 0n) continue;

				const destAlphaPrice = getAlphaPriceForNetuid(
					destTarget.netuid,
					positions,
				);
				const limitPrice = applySlippageBuy(destAlphaPrice);

				operations.push({
					kind: "swap",
					originNetuid: pos.netuid,
					destinationNetuid: destTarget.netuid,
					hotkey: validatorHotkey,
					alphaAmount: swapAlpha,
					estimatedTaoValue: swapTaoValue,
					limitPrice,
				});
				fulfilled.set(destTarget.netuid, destFulfilled + swapTaoValue);
				swapped = true;

				log.verbose(
					`  OP: swap overweight SN${pos.netuid}→SN${destTarget.netuid}: ~${formatTao(swapTaoValue)} τ`,
				);
				break;
			}

			if (!swapped) {
				// Unstake partial if no swap target available
				const limitPrice = applySlippageSell(pos.alphaPrice);
				operations.push({
					kind: "unstake_partial",
					netuid: pos.netuid,
					hotkey: pos.hotkey,
					alphaAmount: reduceAlpha,
					limitPrice,
					estimatedTaoValue: reduceAmount,
				});
				log.verbose(
					`  OP: unstake overweight SN${pos.netuid}: ~${formatTao(reduceAmount)} τ`,
				);
			}
		}
	}

	// 4. Stake from free balance — remaining underweight targets
	// Calculate available free balance (existing + will-be-freed from unstakes)
	let availableFree = freeBalance - FREE_RESERVE_TAO;
	if (availableFree < 0n) availableFree = 0n;

	// Add estimated TAO from unstake operations
	for (const op of operations) {
		if (op.kind === "unstake" || op.kind === "unstake_partial") {
			availableFree += op.estimatedTaoValue;
		}
	}

	for (const target of targets) {
		const currentFulfilled = fulfilled.get(target.netuid) ?? 0n;
		const deficit = target.targetTaoValue - currentFulfilled;
		if (deficit < MIN_OPERATION_TAO) continue;

		const stakeAmount = deficit < availableFree ? deficit : availableFree;
		if (stakeAmount < MIN_OPERATION_TAO) {
			skipped.push({
				netuid: target.netuid,
				reason: `Insufficient free balance for target (need ${formatTao(deficit)} τ, have ${formatTao(availableFree)} τ)`,
			});
			continue;
		}

		const destAlphaPrice = getAlphaPriceForNetuid(target.netuid, positions);
		const limitPrice = applySlippageBuy(destAlphaPrice);

		operations.push({
			kind: "stake",
			netuid: target.netuid,
			hotkey: validatorHotkey,
			taoAmount: stakeAmount,
			limitPrice,
		});

		fulfilled.set(target.netuid, currentFulfilled + stakeAmount);
		availableFree -= stakeAmount;

		log.verbose(`  OP: stake SN${target.netuid}: ${formatTao(stakeAmount)} τ`);
	}

	return { targets, operations, skipped };
}

/** Apply slippage buffer for buying alpha (higher price = pay more TAO per alpha) */
function applySlippageBuy(alphaPrice: bigint): bigint {
	// limit_price = price * (1 + slippage)
	const slippageBps = BigInt(Math.round(SLIPPAGE_FACTOR * 10_000));
	return alphaPrice + (alphaPrice * slippageBps) / 10_000n;
}

/** Apply slippage buffer for selling alpha (lower price = receive less TAO per alpha) */
function applySlippageSell(alphaPrice: bigint): bigint {
	// limit_price = price * (1 - slippage)
	const slippageBps = BigInt(Math.round(SLIPPAGE_FACTOR * 10_000));
	return alphaPrice - (alphaPrice * slippageBps) / 10_000n;
}

/** Look up alpha price for a target netuid from existing positions, fallback to TAO (1:1) */
function getAlphaPriceForNetuid(
	netuid: number,
	positions: ClassifiedPosition[],
): bigint {
	const pos = positions.find((p) => p.netuid === netuid);
	// If we have no existing position, default to 1:1 (root subnet or new subnet)
	return pos?.alphaPrice ?? TAO;
}

function formatTao(rao: bigint): string {
	const whole = rao / TAO;
	const frac = ((rao % TAO) * 1000n) / TAO;
	return `${whole}.${frac.toString().padStart(3, "0")}`;
}

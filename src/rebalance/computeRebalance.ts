import type { Balances, StakeEntry } from "../balances/getBalances.ts";
import { TAO } from "./constants.ts";
import { formatTao } from "./tao.ts";
import type {
	MoveOperation,
	RebalanceConfig,
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

export interface RebalanceDiagnostic {
	level: "info" | "verbose";
	message: string;
}

export interface ComputeRebalanceOptions {
	useLimits?: boolean;
	onDiagnostic?: (diagnostic: RebalanceDiagnostic) => void;
}

/**
 * Compute the rebalance plan: given current balances and strategy targets
 * (with shares), convert shares to absolute TAO values and produce a list
 * of operations to reach the target allocation.
 */
export function computeRebalance(
	balances: Balances,
	targets: StrategyTarget[],
	config: RebalanceConfig,
	options: ComputeRebalanceOptions = {},
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
	} = replenishReserve(balances.free, classified, config, options.onDiagnostic);

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
	resolved.sort((a, b) => a.netuid - b.netuid);

	emitDiagnostic(
		options.onDiagnostic,
		"verbose",
		`Target allocation: ${resolved.length} subnets, ${formatTao(resolved[0]?.targetTaoValue ?? 0n)} τ each`,
	);
	for (const t of resolved) {
		emitDiagnostic(
			options.onDiagnostic,
			"verbose",
			`  Target SN${t.netuid}: ${formatTao(t.targetTaoValue)} τ (${t.hotkey.slice(0, 8)}…)`,
		);
	}

	for (const pos of adjustedPositions) {
		emitDiagnostic(
			options.onDiagnostic,
			"verbose",
			`  Position SN${pos.netuid} (${pos.hotkey.slice(0, 8)}…): ${formatTao(pos.taoValue)} τ → ${pos.classification}`,
		);
	}

	// 3. Generate rebalance operations from adjusted positions
	const plan = generateOperations(
		adjustedPositions,
		resolved,
		adjustedFree,
		config,
		options?.useLimits ?? true,
		options.onDiagnostic,
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
	config: RebalanceConfig,
	onDiagnostic?: (diagnostic: RebalanceDiagnostic) => void,
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

	emitDiagnostic(
		onDiagnostic,
		"info",
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

function emitDiagnostic(
	onDiagnostic: ComputeRebalanceOptions["onDiagnostic"],
	level: RebalanceDiagnostic["level"],
	message: string,
): void {
	onDiagnostic?.({ level, message });
}

function generateOperations(
	positions: ClassifiedPosition[],
	targets: ResolvedTarget[],
	freeBalance: bigint,
	config: RebalanceConfig,
	useLimits: boolean,
	onDiagnostic?: ComputeRebalanceOptions["onDiagnostic"],
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

	// 1. Full exits — swap to underweight targets, splitting across multiple when needed.
	for (const pos of positions) {
		if (pos.classification !== "exit") continue;
		if (pos.taoValue < config.minOperationTao) {
			skipped.push({
				netuid: pos.netuid,
				reason: `Position too small to exit (${formatTao(pos.taoValue)} τ)`,
			});
			continue;
		}

		// Collect eligible targets with remaining deficit, sorted by deficit descending
		const eligible = targets
			.map((t) => {
				const currentFulfilled = fulfilled.get(t.netuid) ?? 0n;
				return {
					target: t,
					deficit: t.targetTaoValue - currentFulfilled,
					currentFulfilled,
				};
			})
			.filter((e) => e.deficit > 0n)
			.sort((a, b) => Number(b.deficit - a.deficit));

		if (eligible.length === 0) {
			operations.push({
				kind: "unstake",
				netuid: pos.netuid,
				hotkey: pos.hotkey,
				alphaAmount: pos.stake,
				limitPrice: 0n,
				estimatedTaoValue: pos.taoValue,
			});
			emitDiagnostic(
				onDiagnostic,
				"verbose",
				`  OP: unstake SN${pos.netuid}: ~${formatTao(pos.taoValue)} τ (no swap target with deficit)`,
			);
			continue;
		}

		// Single-target fast path: position fits within one target's deficit,
		// only one target has deficit, or position fits within one target's
		// drift tolerance — send the whole position as one swap.
		const topTarget = eligible[0];
		const singleTarget = topTarget
			? eligible.length === 1 || pos.taoValue <= topTarget.deficit
				? topTarget
				: findBestSingleTarget(
						eligible,
						pos.taoValue,
						config.allocationDriftPercent,
					)
			: undefined;
		if (singleTarget) {
			const best = singleTarget;
			// Overfill guard: don't overshoot beyond 2× allocation
			if (
				best.currentFulfilled + pos.taoValue >
				2n * best.target.targetTaoValue
			) {
				operations.push({
					kind: "unstake",
					netuid: pos.netuid,
					hotkey: pos.hotkey,
					alphaAmount: pos.stake,
					limitPrice: 0n,
					estimatedTaoValue: pos.taoValue,
				});
				emitDiagnostic(
					onDiagnostic,
					"verbose",
					`  OP: unstake SN${pos.netuid}: ~${formatTao(pos.taoValue)} τ (no swap target within overfill cap)`,
				);
				continue;
			}

			const needsHotkeyChange = best.target.hotkey !== pos.hotkey;
			if (needsHotkeyChange && useLimits) {
				operations.push(moveOp(pos.netuid, pos.hotkey, best.target.hotkey));
			}
			operations.push({
				kind: "swap",
				originNetuid: pos.netuid,
				destinationNetuid: best.target.netuid,
				hotkey: needsHotkeyChange ? best.target.hotkey : pos.hotkey,
				alphaAmount: pos.stake,
				estimatedTaoValue: pos.taoValue,
				limitPrice: 0n,
				originHotkey: needsHotkeyChange && !useLimits ? pos.hotkey : undefined,
			});
			if (needsHotkeyChange) {
				emitDiagnostic(
					onDiagnostic,
					"verbose",
					`  OP: move hotkey SN${pos.netuid} + swap SN${pos.netuid}→SN${best.target.netuid}: ~${formatTao(pos.taoValue)} τ`,
				);
			} else {
				emitDiagnostic(
					onDiagnostic,
					"verbose",
					`  OP: swap SN${pos.netuid}→SN${best.target.netuid}: ~${formatTao(pos.taoValue)} τ (matching hotkey)`,
				);
			}
			fulfilled.set(best.target.netuid, best.currentFulfilled + pos.taoValue);
			continue;
		}

		// Multi-target split: position exceeds any single target's deficit —
		// distribute proportionally across all underweight targets by deficit ratio.
		const totalDeficit = eligible.reduce((sum, e) => sum + e.deficit, 0n);
		const distributableTao =
			pos.taoValue < totalDeficit ? pos.taoValue : totalDeficit;

		// Compute proportional allocations capped at each target's deficit
		let allocations = eligible.map((e) => ({
			target: e.target,
			taoAmount:
				totalDeficit > 0n ? (distributableTao * e.deficit) / totalDeficit : 0n,
		}));

		// Filter out allocations below minOperationTao
		allocations = allocations.filter(
			(a) => a.taoAmount >= config.minOperationTao,
		);

		if (allocations.length === 0) {
			operations.push({
				kind: "unstake",
				netuid: pos.netuid,
				hotkey: pos.hotkey,
				alphaAmount: pos.stake,
				limitPrice: 0n,
				estimatedTaoValue: pos.taoValue,
			});
			emitDiagnostic(
				onDiagnostic,
				"verbose",
				`  OP: unstake SN${pos.netuid}: ~${formatTao(pos.taoValue)} τ (all split allocations below minimum)`,
			);
			continue;
		}

		// Absorb bigint rounding dust into last allocation
		const allocatedSum = allocations.reduce((sum, a) => sum + a.taoAmount, 0n);
		const roundingDust = distributableTao - allocatedSum;
		if (roundingDust > 0n) {
			const lastAlloc = allocations.at(-1);
			if (lastAlloc) lastAlloc.taoAmount += roundingDust;
		}

		// Generate partial swaps
		let usedAlpha = 0n;
		for (const [i, alloc] of allocations.entries()) {
			const isLast = i === allocations.length - 1;

			// Last allocation sweeps remaining alpha when position is fully
			// distributed (avoids conversion rounding dust)
			const swapAlpha =
				isLast && pos.taoValue <= totalDeficit
					? pos.stake - usedAlpha
					: pos.alphaPrice > 0n
						? (alloc.taoAmount * TAO) / pos.alphaPrice
						: 0n;

			const needsHotkeyChange = alloc.target.hotkey !== pos.hotkey;
			if (needsHotkeyChange && useLimits) {
				operations.push(
					moveOp(pos.netuid, pos.hotkey, alloc.target.hotkey, swapAlpha),
				);
			}
			operations.push({
				kind: "swap",
				originNetuid: pos.netuid,
				destinationNetuid: alloc.target.netuid,
				hotkey: needsHotkeyChange ? alloc.target.hotkey : pos.hotkey,
				alphaAmount: swapAlpha,
				estimatedTaoValue: alloc.taoAmount,
				limitPrice: 0n,
				originHotkey: needsHotkeyChange && !useLimits ? pos.hotkey : undefined,
			});
			emitDiagnostic(
				onDiagnostic,
				"verbose",
				needsHotkeyChange
					? `  OP: move hotkey SN${pos.netuid} + swap SN${pos.netuid}→SN${alloc.target.netuid}: ~${formatTao(alloc.taoAmount)} τ`
					: `  OP: swap SN${pos.netuid}→SN${alloc.target.netuid}: ~${formatTao(alloc.taoAmount)} τ (matching hotkey)`,
			);
			fulfilled.set(
				alloc.target.netuid,
				(fulfilled.get(alloc.target.netuid) ?? 0n) + alloc.taoAmount,
			);
			usedAlpha += swapAlpha;
		}

		// If position exceeds total deficit, unstake the remainder
		if (pos.taoValue > totalDeficit) {
			const remainderAlpha = pos.stake - usedAlpha;
			const remainderTao = pos.taoValue - distributableTao;
			if (remainderTao >= config.minOperationTao && remainderAlpha > 0n) {
				operations.push({
					kind: "unstake_partial",
					netuid: pos.netuid,
					hotkey: pos.hotkey,
					alphaAmount: remainderAlpha,
					estimatedTaoValue: remainderTao,
					limitPrice: 0n,
				});
				emitDiagnostic(
					onDiagnostic,
					"verbose",
					`  OP: unstake remainder SN${pos.netuid}: ~${formatTao(remainderTao)} τ`,
				);
			}
		}
	}

	// 2. Overweight reductions — swap excess to underweight target.
	//    Skip reductions within drift band only when no target is
	//    materially underweight (beyond its own drift band).
	//    Recomputed per position since fulfilled changes after each swap.
	for (const target of targets) {
		const keepPositions = positions.filter(
			(p) => p.netuid === target.netuid && p.classification === "keep",
		);
		for (const pos of keepPositions) {
			const excess = pos.taoValue - target.targetTaoValue;
			const driftBand = driftThreshold(
				target.targetTaoValue,
				config.allocationDriftPercent,
			);
			const anyTargetBeyondDrift = targets.some((t) => {
				const f = fulfilled.get(t.netuid) ?? 0n;
				const d = t.targetTaoValue - f;
				return (
					d > driftThreshold(t.targetTaoValue, config.allocationDriftPercent)
				);
			});
			if (
				excess < config.minRebalanceTao ||
				(excess <= driftBand && !anyTargetBeyondDrift)
			)
				continue;

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
				if (needsHotkeyChange && useLimits) {
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
					originHotkey:
						needsHotkeyChange && !useLimits ? pos.hotkey : undefined,
				});
				if (needsHotkeyChange) {
					emitDiagnostic(
						onDiagnostic,
						"verbose",
						`  OP: move hotkey SN${pos.netuid} + swap overweight SN${pos.netuid}→SN${fullSwapTarget.netuid}: ~${formatTao(reduceAmount)} τ`,
					);
				} else {
					emitDiagnostic(
						onDiagnostic,
						"verbose",
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
				emitDiagnostic(
					onDiagnostic,
					"verbose",
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
		const driftBand = driftThreshold(
			target.targetTaoValue,
			config.allocationDriftPercent,
		);
		if (deficit < config.minRebalanceTao || deficit <= driftBand) continue;

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

		emitDiagnostic(
			onDiagnostic,
			"verbose",
			`  OP: stake SN${target.netuid} with ${target.hotkey.slice(0, 8)}…: ${formatTao(stakeAmount)} τ`,
		);
	}

	return { operations, skipped };
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

/** Compute the absolute drift band for a given target value and drift fraction */
function driftThreshold(targetTaoValue: bigint, driftPercent: number): bigint {
	return (
		(targetTaoValue * BigInt(Math.round(driftPercent * 1e9))) / 1_000_000_000n
	);
}

/**
 * Among eligible targets, find the one where routing the entire position
 * keeps the post-swap allocation within drift tolerance. Prefers the
 * candidate with the smallest overshoot (closest to target).
 */
function findBestSingleTarget(
	eligible: Array<{
		target: ResolvedTarget;
		deficit: bigint;
		currentFulfilled: bigint;
	}>,
	positionValue: bigint,
	driftPercent: number,
):
	| { target: ResolvedTarget; deficit: bigint; currentFulfilled: bigint }
	| undefined {
	const candidates = eligible.filter((e) => {
		const afterFulfilled = e.currentFulfilled + positionValue;
		const maxAllowed =
			e.target.targetTaoValue +
			driftThreshold(e.target.targetTaoValue, driftPercent);
		return afterFulfilled <= maxAllowed;
	});
	if (candidates.length === 0) return undefined;
	// Prefer smallest overshoot (closest to target after filling)
	return candidates.sort((a, b) => {
		const devA = a.currentFulfilled + positionValue - a.target.targetTaoValue;
		const devB = b.currentFulfilled + positionValue - b.target.targetTaoValue;
		if (devA < devB) return -1;
		if (devA > devB) return 1;
		return 0;
	})[0];
}

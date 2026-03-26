import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import type { Balances, StakeEntry } from "../getBalances.ts";
import type { SubnetScore } from "../pickBestSubnets.ts";
import {
	FREE_RESERVE_TAO,
	MAX_SUBNETS,
	MIN_OPERATION_TAO,
	MIN_POSITION_TAO,
	MIN_REBALANCE_TAO,
	MIN_STAKE_TAO,
	TAO,
} from "./constants.ts";
import { log } from "./logger.ts";
import { pickBestValidatorByYield } from "./pickBestValidator.ts";
import type {
	RebalanceOperation,
	RebalancePlan,
	TargetSubnet,
} from "./types.ts";

type Api = TypedApi<typeof bittensor>;

interface ClassifiedPosition extends StakeEntry {
	classification: "keep" | "exit";
}

/**
 * Compute the rebalance plan: given current balances and profitable subnets,
 * produce a list of operations to reach equal-weight allocation across the top X subnets.
 */
export async function computeRebalance(
	api: Api,
	balances: Balances,
	profitable: SubnetScore[],
	fallbackValidatorHotkey?: string,
): Promise<RebalancePlan> {
	const available = balances.totalTaoValue - FREE_RESERVE_TAO;
	if (available <= 0n) {
		log.warn("Portfolio too small to rebalance (below free reserve)");
		return { targets: [], operations: [], skipped: [] };
	}

	// Determine X: use total portfolio size for spread count and apply reserve only
	// to per-target sizing. This helps keep allocations more evened out (e.g. ~0.5τ
	// per subnet) without changing profitable-subnet priority.
	const x = Math.min(
		MAX_SUBNETS,
		Math.max(Number(balances.totalTaoValue / MIN_POSITION_TAO), 1),
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

	const { hotkeysByTarget, skipped: hotkeySelectionSkips } =
		await resolveTargetHotkeys(
			api,
			balances.stakes,
			targetNetuids,
			fallbackValidatorHotkey,
		);

	const targetSet = new Set(targetNetuids);
	const classified = classifyPositions(balances.stakes, targetSet);

	for (const pos of classified) {
		log.verbose(
			`  Position SN${pos.netuid} (${pos.hotkey.slice(0, 8)}…): ${formatTao(pos.taoValue)} τ → ${pos.classification}`,
		);
	}

	const plan = generateOperations(
		classified,
		targets,
		hotkeysByTarget,
		balances.free,
	);
	plan.skipped = [...hotkeySelectionSkips, ...plan.skipped];
	return plan;
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

	// 1. Full exits — try swap to underweight target only when hotkeys match, otherwise unstake.
	for (const pos of positions) {
		if (pos.classification !== "exit") continue;
		if (pos.taoValue < MIN_OPERATION_TAO) {
			skipped.push({
				netuid: pos.netuid,
				reason: `Position too small to exit (${formatTao(pos.taoValue)} τ)`,
			});
			continue;
		}

		const bestSwapTarget = targets
			.filter((t) => {
				const deficit = t.targetTaoValue - (fulfilled.get(t.netuid) ?? 0n);
				if (deficit < pos.taoValue) return false;
				const targetHotkey = targetHotkeys.get(t.netuid);
				return targetHotkey === pos.hotkey;
			})
			.sort((a, b) =>
				Number(
					b.targetTaoValue -
						(fulfilled.get(b.netuid) ?? 0n) -
						(a.targetTaoValue - (fulfilled.get(a.netuid) ?? 0n)),
				),
			)[0];

		if (bestSwapTarget) {
			operations.push({
				kind: "swap",
				originNetuid: pos.netuid,
				destinationNetuid: bestSwapTarget.netuid,
				hotkey: pos.hotkey,
				alphaAmount: pos.stake,
				estimatedTaoValue: pos.taoValue,
				limitPrice: 0n,
			});
			fulfilled.set(
				bestSwapTarget.netuid,
				(fulfilled.get(bestSwapTarget.netuid) ?? 0n) + pos.taoValue,
			);
			log.verbose(
				`  OP: swap SN${pos.netuid}→SN${bestSwapTarget.netuid}: ~${formatTao(pos.taoValue)} τ (matching hotkey)`,
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
			`  OP: unstake SN${pos.netuid}: ~${formatTao(pos.taoValue)} τ (no matching swap destination hotkey)`,
		);
	}

	// 2. Overweight reductions — try swaps only where destination hotkey matches source hotkey.
	for (const target of targets) {
		const keepPositions = positions.filter(
			(p) => p.netuid === target.netuid && p.classification === "keep",
		);
		for (const pos of keepPositions) {
			const excess = pos.taoValue - target.targetTaoValue;
			if (excess < MIN_REBALANCE_TAO) continue;

			// Ensure remaining position stays above MIN_STAKE_TAO
			const maxReducible = pos.taoValue - MIN_STAKE_TAO;
			const reduceAmount = excess < maxReducible ? excess : maxReducible;
			if (reduceAmount < MIN_REBALANCE_TAO) {
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
					if (targetHotkeys.get(destTarget.netuid) !== pos.hotkey) return false;
					const destDeficit =
						destTarget.targetTaoValue -
						(fulfilled.get(destTarget.netuid) ?? 0n);
					return destDeficit >= reduceAmount;
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
				operations.push({
					kind: "swap",
					originNetuid: pos.netuid,
					destinationNetuid: fullSwapTarget.netuid,
					hotkey: pos.hotkey,
					alphaAmount: reduceAlpha,
					estimatedTaoValue: reduceAmount,
					limitPrice: 0n,
				});
				fulfilled.set(fullSwapTarget.netuid, destFulfilled + reduceAmount);

				log.verbose(
					`  OP: swap overweight SN${pos.netuid}→SN${fullSwapTarget.netuid}: ~${formatTao(reduceAmount)} τ (matching hotkey)`,
				);
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
	let availableFree = freeBalance - FREE_RESERVE_TAO;

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
		if (deficit < MIN_REBALANCE_TAO) continue;

		const targetHotkey = targetHotkeys.get(target.netuid);
		if (!targetHotkey) {
			skipped.push({
				netuid: target.netuid,
				reason: "No validator hotkey resolved for target subnet",
			});
			continue;
		}

		const stakeAmount = deficit < availableFree ? deficit : availableFree;
		if (stakeAmount < MIN_REBALANCE_TAO) {
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

async function resolveTargetHotkeys(
	api: Api,
	stakes: StakeEntry[],
	targetNetuids: number[],
	fallbackValidatorHotkey?: string,
): Promise<{
	hotkeysByTarget: Map<number, string>;
	skipped: RebalancePlan["skipped"];
}> {
	const hotkeysByTarget = new Map<number, string>();
	const skipped: RebalancePlan["skipped"] = [];

	for (const netuid of targetNetuids) {
		const existing = stakes.filter((s) => s.netuid === netuid);
		if (existing.length > 0) {
			const bestExisting = [...existing].sort((a, b) => {
				if (b.taoValue !== a.taoValue) return b.taoValue > a.taoValue ? 1 : -1;
				if (b.stake !== a.stake) return b.stake > a.stake ? 1 : -1;
				return a.hotkey.localeCompare(b.hotkey);
			})[0];
			if (!bestExisting) {
				continue;
			}
			hotkeysByTarget.set(netuid, bestExisting.hotkey);
			log.verbose(
				`  Validator SN${netuid}: existing ${bestExisting.hotkey.slice(0, 8)}… (largest position)`,
			);
			continue;
		}

		try {
			const best = await pickBestValidatorByYield(api, netuid);
			hotkeysByTarget.set(netuid, best.hotkey);
			log.verbose(
				`  Validator SN${netuid}: yield-picked ${best.hotkey.slice(0, 8)}… (UID ${best.candidate.uid})`,
			);
		} catch (err) {
			if (fallbackValidatorHotkey) {
				hotkeysByTarget.set(netuid, fallbackValidatorHotkey);
				log.warn(
					`Validator selection failed for SN${netuid}; falling back to VALIDATOR_HOTKEY (${fallbackValidatorHotkey.slice(0, 8)}…): ${String(err)}`,
				);
			} else {
				const reason =
					err instanceof Error
						? err.message
						: "unknown validator selection error";
				skipped.push({
					netuid,
					reason: `No validator selected for SN${netuid}: ${reason}`,
				});
				log.warn(
					`Skipping SN${netuid} destination: no yield candidate and VALIDATOR_HOTKEY not set`,
				);
			}
		}
	}

	return { hotkeysByTarget, skipped };
}

function formatTao(rao: bigint): string {
	const whole = rao / TAO;
	const frac = ((rao % TAO) * 1000n) / TAO;
	return `${whole}.${frac.toString().padStart(3, "0")}`;
}

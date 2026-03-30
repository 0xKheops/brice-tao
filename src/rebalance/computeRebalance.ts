import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import type { Balances, StakeEntry } from "../balances/getBalances.ts";
import type { AppConfig } from "../config/types.ts";
import type { SubnetScore } from "../subnets/getBestSubnets.ts";
import { TAO } from "./constants.ts";
import { log } from "./logger.ts";
import { pickBestValidatorByYield } from "./pickBestValidator.ts";
import type {
	MoveOperation,
	RebalanceOperation,
	RebalancePlan,
	TargetSubnet,
} from "./types.ts";

/** u64::MAX — used with move_stake to sweep all alpha for a hotkey on a subnet */
const U64_MAX = 18_446_744_073_709_551_615n;

type Api = TypedApi<typeof bittensor>;

interface ClassifiedPosition extends StakeEntry {
	classification: "keep" | "exit";
}

/**
 * Compute the rebalance plan: given current balances and eligible subnets,
 * produce a list of operations to reach equal-weight allocation across the top X subnets.
 */
export async function computeRebalance(
	api: Api,
	balances: Balances,
	eligibleSubnets: SubnetScore[],
	config: AppConfig["rebalance"],
	fallbackValidatorHotkey?: string,
): Promise<RebalancePlan> {
	const available = balances.totalTaoValue - config.freeReserveTao;
	if (available <= 0n) {
		log.warn("Portfolio too small to rebalance (below free reserve)");
		return { targets: [], operations: [], skipped: [] };
	}

	// Determine X: use total portfolio size for spread count and apply reserve only
	// to per-target sizing. This helps keep allocations more evened out (e.g. ~0.5τ
	// per subnet) without changing eligible-subnet priority.
	const x = Math.min(
		config.maxSubnets,
		Math.max(Number(balances.totalTaoValue / config.minPositionTao), 1),
		Math.max(eligibleSubnets.length, 1), // at least 1 target (netuid 0)
	);

	if (x < 1) {
		log.warn("Not enough TAO for even one position");
		return { targets: [], operations: [], skipped: [] };
	}

	// Select target subnets — fill with netuid 0 if fewer eligible than X
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
		config,
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

	// 1. Full exits — swap to underweight target, then move hotkey if needed.
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
				const deficit = t.targetTaoValue - (fulfilled.get(t.netuid) ?? 0n);
				return deficit >= pos.taoValue;
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
			operations.push({
				kind: "swap",
				originNetuid: pos.netuid,
				destinationNetuid: bestSwapTarget.netuid,
				hotkey: pos.hotkey,
				alphaAmount: pos.stake,
				estimatedTaoValue: pos.taoValue,
				limitPrice: 0n,
			});
			if (targetHotkey && targetHotkey !== pos.hotkey) {
				operations.push(
					moveOp(bestSwapTarget.netuid, pos.hotkey, targetHotkey),
				);
				log.verbose(
					`  OP: swap SN${pos.netuid}→SN${bestSwapTarget.netuid}: ~${formatTao(pos.taoValue)} τ + move hotkey`,
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
			`  OP: unstake SN${pos.netuid}: ~${formatTao(pos.taoValue)} τ (no swap target with sufficient deficit)`,
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
				const targetHotkey = targetHotkeys.get(fullSwapTarget.netuid);
				operations.push({
					kind: "swap",
					originNetuid: pos.netuid,
					destinationNetuid: fullSwapTarget.netuid,
					hotkey: pos.hotkey,
					alphaAmount: reduceAlpha,
					estimatedTaoValue: reduceAmount,
					limitPrice: 0n,
				});
				if (targetHotkey && targetHotkey !== pos.hotkey) {
					operations.push(
						moveOp(fullSwapTarget.netuid, pos.hotkey, targetHotkey),
					);
					log.verbose(
						`  OP: swap overweight SN${pos.netuid}→SN${fullSwapTarget.netuid}: ~${formatTao(reduceAmount)} τ + move hotkey`,
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

function moveOp(
	netuid: number,
	originHotkey: string,
	destinationHotkey: string,
): MoveOperation {
	return {
		kind: "move",
		netuid,
		originHotkey,
		destinationHotkey,
		alphaAmount: U64_MAX,
	};
}

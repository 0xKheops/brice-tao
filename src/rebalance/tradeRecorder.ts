import type { Balances } from "../balances/getBalances.ts";
import type { TradeRecord } from "../history/types.ts";
import type { BatchResult, RebalancePlan } from "./types.ts";

/**
 * Build per-operation trade records by correlating the rebalance plan,
 * before/after balance snapshots, and the batch execution result.
 *
 * Each operation in the plan maps to one TradeRecord. Position-level
 * before/after values are resolved by matching (netuid, hotkey) in the
 * balance snapshots.
 */
export function buildTradeRecords(
	cycleId: number,
	plan: RebalancePlan,
	balancesBefore: Balances,
	balancesAfter: Balances,
	batchResult: BatchResult | null,
): TradeRecord[] {
	const records: TradeRecord[] = [];

	for (let i = 0; i < plan.operations.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: loop bounded by plan.operations.length
		const op = plan.operations[i]!;

		// Resolve the primary netuid and hotkey for balance matching
		const {
			netuid,
			hotkey,
			beforeHotkey,
			originNetuid,
			estimatedTao,
			alphaAmount,
		} = extractOpFields(op);

		// Find matching position in before/after snapshots
		// For moves, the pre-trade position is under originHotkey, not destinationHotkey
		const posBefore = balancesBefore.stakes.find(
			(s) => s.netuid === netuid && s.hotkey === beforeHotkey,
		);
		const posAfter = balancesAfter.stakes.find(
			(s) => s.netuid === netuid && s.hotkey === hotkey,
		);

		// Spot price from the before-snapshot (best available pre-trade price)
		const spotPrice = posBefore?.alphaPrice ?? null;

		// Map success/failure from batch result
		const opResult =
			batchResult?.status !== "timeout"
				? batchResult?.operationResults[i]
				: undefined;

		records.push({
			cycleId,
			opIndex: i,
			opKind: op.kind,
			netuid,
			originNetuid,
			hotkey,
			success: opResult?.success ?? false,
			error: opResult?.error ?? null,
			estimatedTao,
			alphaAmount,
			taoBefore: posBefore?.taoValue ?? null,
			taoAfter: posAfter?.taoValue ?? null,
			alphaBefore: posBefore?.stake ?? null,
			alphaAfter: posAfter?.stake ?? null,
			spotPrice,
		});
	}

	return records;
}

/** Extract common fields from any operation type for trade recording */
function extractOpFields(op: RebalancePlan["operations"][number]): {
	netuid: number;
	hotkey: string;
	/** Hotkey to use for the before-snapshot lookup (differs from hotkey for moves) */
	beforeHotkey: string;
	originNetuid: number | null;
	estimatedTao: bigint;
	alphaAmount: bigint | null;
} {
	switch (op.kind) {
		case "swap":
			return {
				netuid: op.destinationNetuid,
				hotkey: op.hotkey,
				beforeHotkey: op.hotkey,
				originNetuid: op.originNetuid,
				estimatedTao: op.estimatedTaoValue,
				alphaAmount: op.alphaAmount,
			};
		case "unstake":
			return {
				netuid: op.netuid,
				hotkey: op.hotkey,
				beforeHotkey: op.hotkey,
				originNetuid: null,
				estimatedTao: op.estimatedTaoValue,
				alphaAmount: op.alphaAmount,
			};
		case "unstake_partial":
			return {
				netuid: op.netuid,
				hotkey: op.hotkey,
				beforeHotkey: op.hotkey,
				originNetuid: null,
				estimatedTao: op.estimatedTaoValue,
				alphaAmount: op.alphaAmount,
			};
		case "stake":
			return {
				netuid: op.netuid,
				hotkey: op.hotkey,
				beforeHotkey: op.hotkey,
				originNetuid: null,
				estimatedTao: op.taoAmount,
				alphaAmount: null,
			};
		case "move":
			return {
				netuid: op.netuid,
				hotkey: op.destinationHotkey,
				beforeHotkey: op.originHotkey,
				originNetuid: null,
				estimatedTao: 0n,
				alphaAmount: op.alphaAmount,
			};
	}
}

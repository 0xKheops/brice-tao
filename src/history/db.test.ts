import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { openHistoryDatabase } from "./db.ts";
import type { CycleRecord, TradeRecord } from "./types.ts";

const TEST_DB = "data/test-position-tracking.sqlite";

function cleanup() {
	try {
		unlinkSync(TEST_DB);
	} catch {
		// ignore
	}
	try {
		unlinkSync(`${TEST_DB}-wal`);
	} catch {
		// ignore
	}
	try {
		unlinkSync(`${TEST_DB}-shm`);
	} catch {
		// ignore
	}
}

afterEach(cleanup);

function makeCycle(overrides?: Partial<CycleRecord>): CycleRecord {
	return {
		strategy: "test-strategy",
		gitCommit: "abc123",
		blockNumber: 7909654,
		txHash: "0xdeadbeef",
		timestamp: Date.now(),
		status: "completed",
		totalBefore: 13_000_000_000n,
		totalAfter: 13_200_000_000n,
		feeInner: 5_000_000n,
		feeWrapper: 1_000_000n,
		opsTotal: 3,
		opsSucceeded: 3,
		dryRun: false,
		...overrides,
	};
}

describe("position tracking DB", () => {
	test("recordCycle returns auto-increment ID", () => {
		const db = openHistoryDatabase(TEST_DB);
		try {
			const id1 = db.recordCycle(makeCycle());
			const id2 = db.recordCycle(makeCycle({ blockNumber: 7909700 }));

			expect(id1).toBe(1);
			expect(id2).toBe(2);
		} finally {
			db.close();
		}
	});

	test("recordCycle stores and retrieves all fields", () => {
		const db = openHistoryDatabase(TEST_DB);
		try {
			const cycle = makeCycle({
				strategy: "momentum-stoploss",
				gitCommit: "d3f038b",
				blockNumber: 7912054,
				txHash: "0xfeed",
				status: "partial_failure",
				totalBefore: 14_000_000_000n,
				totalAfter: 13_800_000_000n,
				feeInner: 3_000_000n,
				feeWrapper: 2_000_000n,
				opsTotal: 5,
				opsSucceeded: 4,
				dryRun: true,
			});
			db.recordCycle(cycle);

			const rows = db.getCycles({ strategy: "momentum-stoploss" });
			expect(rows).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: test assertion
			const r = rows[0]!;

			expect(r.strategy).toBe("momentum-stoploss");
			expect(r.gitCommit).toBe("d3f038b");
			expect(r.blockNumber).toBe(7912054);
			expect(r.txHash).toBe("0xfeed");
			expect(r.status).toBe("partial_failure");
			expect(r.totalBefore).toBe(14_000_000_000n);
			expect(r.totalAfter).toBe(13_800_000_000n);
			expect(r.feeInner).toBe(3_000_000n);
			expect(r.feeWrapper).toBe(2_000_000n);
			expect(r.opsTotal).toBe(5);
			expect(r.opsSucceeded).toBe(4);
			expect(r.dryRun).toBe(true);
		} finally {
			db.close();
		}
	});

	test("getCycles filters by strategy", () => {
		const db = openHistoryDatabase(TEST_DB);
		try {
			db.recordCycle(makeCycle({ strategy: "alpha" }));
			db.recordCycle(makeCycle({ strategy: "beta" }));
			db.recordCycle(makeCycle({ strategy: "alpha" }));

			expect(db.getCycles({ strategy: "alpha" })).toHaveLength(2);
			expect(db.getCycles({ strategy: "beta" })).toHaveLength(1);
			expect(db.getCycles()).toHaveLength(3);
		} finally {
			db.close();
		}
	});

	test("getCycles respects limit", () => {
		const db = openHistoryDatabase(TEST_DB);
		try {
			for (let i = 0; i < 5; i++) {
				db.recordCycle(makeCycle({ timestamp: Date.now() + i }));
			}

			expect(db.getCycles({ limit: 3 })).toHaveLength(3);
		} finally {
			db.close();
		}
	});

	test("recordTrades and getTradesForCycle round-trip", () => {
		const db = openHistoryDatabase(TEST_DB);
		try {
			const cycleId = db.recordCycle(makeCycle());

			const trades: TradeRecord[] = [
				{
					cycleId,
					opIndex: 0,
					opKind: "swap",
					netuid: 88,
					originNetuid: 0,
					hotkey: "5Hot...",
					success: true,
					error: null,
					estimatedTao: 2_700_000_000n,
					alphaAmount: 1_000_000_000n,
					taoBefore: null,
					taoAfter: 2_650_000_000n,
					alphaBefore: null,
					alphaAfter: 980_000_000n,
					spotPrice: 2_700_000_000n,
				},
				{
					cycleId,
					opIndex: 1,
					opKind: "unstake",
					netuid: 5,
					originNetuid: null,
					hotkey: "5Old...",
					success: false,
					error: "SlippageExceeded",
					estimatedTao: 500_000_000n,
					alphaAmount: 500_000_000n,
					taoBefore: 500_000_000n,
					taoAfter: 500_000_000n,
					alphaBefore: 500_000_000n,
					alphaAfter: 500_000_000n,
					spotPrice: 1_000_000_000n,
				},
			];

			db.recordTrades(trades);

			const fetched = db.getTradesForCycle(cycleId);
			expect(fetched).toHaveLength(2);

			// biome-ignore lint/style/noNonNullAssertion: test assertion
			const t0 = fetched[0]!;
			expect(t0.opKind).toBe("swap");
			expect(t0.netuid).toBe(88);
			expect(t0.originNetuid).toBe(0);
			expect(t0.success).toBe(true);
			expect(t0.error).toBeNull();
			expect(t0.estimatedTao).toBe(2_700_000_000n);
			expect(t0.taoAfter).toBe(2_650_000_000n);
			expect(t0.alphaAfter).toBe(980_000_000n);
			expect(t0.taoBefore).toBeNull();
			expect(t0.alphaBefore).toBeNull();

			// biome-ignore lint/style/noNonNullAssertion: test assertion
			const t1 = fetched[1]!;
			expect(t1.success).toBe(false);
			expect(t1.error).toBe("SlippageExceeded");
			expect(t1.taoBefore).toBe(500_000_000n);
		} finally {
			db.close();
		}
	});

	test("recordTrades is no-op for empty array", () => {
		const db = openHistoryDatabase(TEST_DB);
		try {
			db.recordCycle(makeCycle());
			db.recordTrades([]);
			expect(db.getTradesForCycle(1)).toHaveLength(0);
		} finally {
			db.close();
		}
	});

	test("cycle with null blockNumber and txHash", () => {
		const db = openHistoryDatabase(TEST_DB);
		try {
			const cycleId = db.recordCycle(
				makeCycle({ blockNumber: null, txHash: null, status: "error" }),
			);
			const rows = db.getCycles();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.blockNumber).toBeNull();
			expect(rows[0]?.txHash).toBeNull();
			expect(rows[0]?.status).toBe("error");
			expect(cycleId).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe("hasEmissionData", () => {
	test("returns true for empty DB", () => {
		const db = openHistoryDatabase(TEST_DB);
		try {
			expect(db.hasEmissionData()).toBe(true);
		} finally {
			db.close();
		}
	});

	test("returns false when all emission columns are zero", () => {
		const db = openHistoryDatabase(TEST_DB);
		try {
			db.recordSnapshot({
				block: {
					blockNumber: 100,
					blockHash: "0xabc",
					timestamp: Date.now(),
				},
				subnets: [
					{
						netuid: 1,
						name: "test",
						taoIn: 1000n,
						alphaIn: 2000n,
						alphaOut: 3000n,
						taoInEmission: 100n,
						alphaOutEmission: 0n,
						alphaInEmission: 0n,
						pendingAlphaEmission: 0n,
						pendingRootEmission: 0n,
						spotPrice: 500n,
						movingPrice: 500n,
						subnetVolume: 0n,
						tempo: 360,
						blocksSinceLastStep: 0n,
						networkRegisteredAt: 0n,
						immunityPeriod: 100,
						subnetToPrune: null,
					},
				],
			});
			expect(db.hasEmissionData()).toBe(false);
		} finally {
			db.close();
		}
	});

	test("returns true when emission columns have real values", () => {
		const db = openHistoryDatabase(TEST_DB);
		try {
			db.recordSnapshot({
				block: {
					blockNumber: 100,
					blockHash: "0xabc",
					timestamp: Date.now(),
				},
				subnets: [
					{
						netuid: 1,
						name: "test",
						taoIn: 1000n,
						alphaIn: 2000n,
						alphaOut: 3000n,
						taoInEmission: 100n,
						alphaOutEmission: 50n,
						alphaInEmission: 30n,
						pendingAlphaEmission: 10n,
						pendingRootEmission: 5n,
						spotPrice: 500n,
						movingPrice: 500n,
						subnetVolume: 0n,
						tempo: 360,
						blocksSinceLastStep: 0n,
						networkRegisteredAt: 0n,
						immunityPeriod: 100,
						subnetToPrune: null,
					},
				],
			});
			expect(db.hasEmissionData()).toBe(true);
		} finally {
			db.close();
		}
	});
});

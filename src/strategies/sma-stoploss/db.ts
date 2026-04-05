import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
	StopLossEntry,
	StopOutRecord,
	SubnetPriceHistory,
} from "./types.ts";

export interface PriceDatabase {
	insertPriceSample(
		netuid: number,
		blockNumber: number,
		price: bigint,
		maxSamples: number,
	): boolean;
	getPriceHistory(netuid: number): SubnetPriceHistory;
	getAllPriceHistories(): Map<number, SubnetPriceHistory>;
	getPriceHistorySubnetCount(): number;

	saveStopLoss(entry: StopLossEntry): void;
	getAllStopLosses(): StopLossEntry[];
	deleteStopLoss(netuid: number): void;
	clearStopLosses(): void;

	saveStoppedOut(record: StopOutRecord): void;
	getAllStoppedOut(): StopOutRecord[];
	deleteStoppedOut(netuid: number): void;
	clearStoppedOut(): void;

	close(): void;
}

export function openPriceDatabase(dbPath: string): PriceDatabase {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);

	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");

	db.exec(`
		CREATE TABLE IF NOT EXISTS price_samples (
			netuid INTEGER NOT NULL,
			block_number INTEGER NOT NULL,
			price TEXT NOT NULL,
			PRIMARY KEY (netuid, block_number)
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS stop_losses (
			netuid INTEGER PRIMARY KEY,
			high_water_mark TEXT NOT NULL,
			stop_price TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS stopped_out (
			netuid INTEGER PRIMARY KEY,
			triggered_at_block INTEGER NOT NULL,
			exit_price TEXT NOT NULL
		)
	`);

	// Pre-compiled statements
	const insertPriceStmt = db.prepare(
		"INSERT OR IGNORE INTO price_samples (netuid, block_number, price) VALUES (?, ?, ?)",
	);
	const evictPriceStmt = db.prepare(
		"DELETE FROM price_samples WHERE netuid = ? AND block_number NOT IN (SELECT block_number FROM price_samples WHERE netuid = ? ORDER BY block_number DESC LIMIT ?)",
	);
	const queryPriceStmt = db.prepare(
		"SELECT block_number, price FROM price_samples WHERE netuid = ? ORDER BY block_number ASC",
	);
	const allPriceNetuidsStmt = db.prepare(
		"SELECT DISTINCT netuid FROM price_samples",
	);
	const countPriceSubnetsStmt = db.prepare(
		"SELECT COUNT(DISTINCT netuid) as count FROM price_samples",
	);

	const upsertStopLossStmt = db.prepare(
		"INSERT OR REPLACE INTO stop_losses (netuid, high_water_mark, stop_price) VALUES (?, ?, ?)",
	);
	const queryAllStopLossesStmt = db.prepare(
		"SELECT netuid, high_water_mark, stop_price FROM stop_losses",
	);
	const deleteStopLossStmt = db.prepare(
		"DELETE FROM stop_losses WHERE netuid = ?",
	);

	const upsertStoppedOutStmt = db.prepare(
		"INSERT OR REPLACE INTO stopped_out (netuid, triggered_at_block, exit_price) VALUES (?, ?, ?)",
	);
	const queryAllStoppedOutStmt = db.prepare(
		"SELECT netuid, triggered_at_block, exit_price FROM stopped_out",
	);
	const deleteStoppedOutStmt = db.prepare(
		"DELETE FROM stopped_out WHERE netuid = ?",
	);

	function rowsToHistory(
		netuid: number,
		rows: Array<{ block_number: number; price: string }>,
	): SubnetPriceHistory {
		return {
			netuid,
			samples: rows.map((r) => ({
				blockNumber: r.block_number,
				price: BigInt(r.price),
			})),
		};
	}

	return {
		insertPriceSample(netuid, blockNumber, price, maxSamples) {
			const result = insertPriceStmt.run(netuid, blockNumber, price.toString());
			if (result.changes === 0) return false;
			evictPriceStmt.run(netuid, netuid, maxSamples);
			return true;
		},

		getPriceHistory(netuid) {
			const rows = queryPriceStmt.all(netuid) as Array<{
				block_number: number;
				price: string;
			}>;
			return rowsToHistory(netuid, rows);
		},

		getAllPriceHistories() {
			const netuids = allPriceNetuidsStmt.all() as Array<{ netuid: number }>;
			const map = new Map<number, SubnetPriceHistory>();
			for (const { netuid } of netuids) {
				map.set(netuid, this.getPriceHistory(netuid));
			}
			return map;
		},

		getPriceHistorySubnetCount() {
			const row = countPriceSubnetsStmt.get() as { count: number };
			return row.count;
		},

		saveStopLoss(entry: StopLossEntry) {
			upsertStopLossStmt.run(
				entry.netuid,
				entry.highWaterMark.toString(),
				entry.stopPrice.toString(),
			);
		},

		getAllStopLosses() {
			const rows = queryAllStopLossesStmt.all() as Array<{
				netuid: number;
				high_water_mark: string;
				stop_price: string;
			}>;
			return rows.map((r) => ({
				netuid: r.netuid,
				highWaterMark: BigInt(r.high_water_mark),
				stopPrice: BigInt(r.stop_price),
			}));
		},

		deleteStopLoss(netuid: number) {
			deleteStopLossStmt.run(netuid);
		},

		clearStopLosses() {
			db.exec("DELETE FROM stop_losses");
		},

		saveStoppedOut(record: StopOutRecord) {
			upsertStoppedOutStmt.run(
				record.netuid,
				record.triggeredAtBlock,
				record.exitPrice.toString(),
			);
		},

		getAllStoppedOut() {
			const rows = queryAllStoppedOutStmt.all() as Array<{
				netuid: number;
				triggered_at_block: number;
				exit_price: string;
			}>;
			return rows.map((r) => ({
				netuid: r.netuid,
				triggeredAtBlock: r.triggered_at_block,
				exitPrice: BigInt(r.exit_price),
			}));
		},

		deleteStoppedOut(netuid: number) {
			deleteStoppedOutStmt.run(netuid);
		},

		clearStoppedOut() {
			db.exec("DELETE FROM stopped_out");
		},

		close() {
			db.close();
		},
	};
}

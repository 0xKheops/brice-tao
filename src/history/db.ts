import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { and, between, eq } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";
import type { HistorySnapshot, SubnetSnapshot } from "./types.ts";

export interface HistoryDatabase {
	/**
	 * Record a complete snapshot (block + all subnet data) in a single transaction.
	 * Idempotent: silently skips if the block_hash already exists.
	 * Returns true if the block was inserted, false if it already existed.
	 */
	recordSnapshot(snapshot: HistorySnapshot): boolean;

	/** Check whether a block hash has already been recorded */
	hasBlock(blockHash: string): boolean;

	/** Get the most recently recorded block number, or null if empty */
	getLatestBlockNumber(): number | null;

	/**
	 * Time-series query: get subnet snapshots for a given netuid between two block numbers.
	 * Ordered by block_number ascending. Used by future backtesting.
	 */
	getSubnetSeries(
		netuid: number,
		fromBlock: number,
		toBlock: number,
	): Array<{
		blockNumber: number;
		blockHash: string;
		timestamp: number;
		snapshot: SubnetSnapshot;
	}>;

	/** Get all block numbers and timestamps in the DB, sorted ascending */
	getBlockMetas(): Array<{ blockNumber: number; timestamp: number }>;

	/** Get all subnet snapshots for a given block number */
	getSnapshotsAtBlock(blockNumber: number): SubnetSnapshot[];

	close(): void;
}

export function openHistoryDatabase(dbPath: string): HistoryDatabase {
	mkdirSync(dirname(dbPath), { recursive: true });
	const sqlite = new Database(dbPath);

	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec("PRAGMA synchronous = NORMAL");

	// Create tables if they don't exist
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS blocks (
			block_hash       TEXT    PRIMARY KEY,
			block_number     INTEGER NOT NULL UNIQUE CHECK(block_number % 25 = 0),
			timestamp        INTEGER NOT NULL
		)
	`);
	sqlite.exec(
		"CREATE INDEX IF NOT EXISTS idx_blocks_number ON blocks(block_number)",
	);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS subnet_snapshots (
			block_hash            TEXT    NOT NULL REFERENCES blocks(block_hash),
			netuid                INTEGER NOT NULL,
			name                  TEXT    NOT NULL,
			tao_in                TEXT    NOT NULL,
			alpha_in              TEXT    NOT NULL,
			alpha_out             TEXT    NOT NULL,
			tao_in_emission       TEXT    NOT NULL,
			spot_price            TEXT    NOT NULL,
			moving_price          TEXT    NOT NULL,
			subnet_volume         TEXT    NOT NULL,
			tempo                 INTEGER NOT NULL,
			blocks_since_last_step TEXT   NOT NULL,
			network_registered_at TEXT    NOT NULL,
			immunity_period       INTEGER NOT NULL,
			subnet_to_prune       INTEGER,
			PRIMARY KEY (block_hash, netuid)
		)
	`);
	sqlite.exec(
		"CREATE INDEX IF NOT EXISTS idx_snapshots_netuid_block ON subnet_snapshots(netuid, block_hash)",
	);

	const db: BunSQLiteDatabase<typeof schema> = drizzle(sqlite, { schema });

	// Pre-compiled statement for fast block existence check
	const hasBlockStmt = sqlite.prepare(
		"SELECT 1 FROM blocks WHERE block_hash = ? LIMIT 1",
	);
	const latestBlockStmt = sqlite.prepare(
		"SELECT MAX(block_number) as max_block FROM blocks",
	);
	const allBlockNumbersStmt = sqlite.prepare(
		"SELECT block_number, timestamp FROM blocks ORDER BY block_number ASC",
	);
	const snapshotsAtBlockStmt = sqlite.prepare(`
		SELECT s.*, b.block_number, b.timestamp
		FROM subnet_snapshots s
		INNER JOIN blocks b ON s.block_hash = b.block_hash
		WHERE b.block_number = ?
	`);

	// Transaction for atomic snapshot recording
	const insertBlockStmt = sqlite.prepare(
		"INSERT OR IGNORE INTO blocks (block_hash, block_number, timestamp) VALUES (?, ?, ?)",
	);
	const insertSnapshotStmt = sqlite.prepare(`
		INSERT OR IGNORE INTO subnet_snapshots (
			block_hash, netuid, name, tao_in, alpha_in, alpha_out,
			tao_in_emission, spot_price, moving_price, subnet_volume,
			tempo, blocks_since_last_step, network_registered_at,
			immunity_period, subnet_to_prune
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const recordSnapshotTxn = sqlite.transaction(
		(snapshot: HistorySnapshot): boolean => {
			const blockResult = insertBlockStmt.run(
				snapshot.block.blockHash,
				snapshot.block.blockNumber,
				snapshot.block.timestamp,
			);

			// Block already existed — skip subnet inserts
			if (blockResult.changes === 0) return false;

			for (const s of snapshot.subnets) {
				insertSnapshotStmt.run(
					snapshot.block.blockHash,
					s.netuid,
					s.name,
					s.taoIn.toString(),
					s.alphaIn.toString(),
					s.alphaOut.toString(),
					s.taoInEmission.toString(),
					s.spotPrice.toString(),
					s.movingPrice.toString(),
					s.subnetVolume.toString(),
					s.tempo,
					s.blocksSinceLastStep.toString(),
					s.networkRegisteredAt.toString(),
					s.immunityPeriod,
					s.subnetToPrune,
				);
			}

			return true;
		},
	);

	return {
		recordSnapshot(snapshot) {
			return recordSnapshotTxn(snapshot);
		},

		hasBlock(blockHash) {
			return hasBlockStmt.get(blockHash) !== null;
		},

		getLatestBlockNumber() {
			const row = latestBlockStmt.get() as { max_block: number | null };
			return row.max_block;
		},

		getSubnetSeries(netuid, fromBlock, toBlock) {
			const rows = db
				.select()
				.from(schema.subnetSnapshots)
				.innerJoin(
					schema.blocks,
					eq(schema.subnetSnapshots.blockHash, schema.blocks.blockHash),
				)
				.where(
					and(
						eq(schema.subnetSnapshots.netuid, netuid),
						between(schema.blocks.blockNumber, fromBlock, toBlock),
					),
				)
				.orderBy(schema.blocks.blockNumber)
				.all();

			return rows.map((r) => ({
				blockNumber: r.blocks.blockNumber,
				blockHash: r.blocks.blockHash,
				timestamp: r.blocks.timestamp,
				snapshot: {
					netuid: r.subnet_snapshots.netuid,
					name: r.subnet_snapshots.name,
					taoIn: BigInt(r.subnet_snapshots.taoIn),
					alphaIn: BigInt(r.subnet_snapshots.alphaIn),
					alphaOut: BigInt(r.subnet_snapshots.alphaOut),
					taoInEmission: BigInt(r.subnet_snapshots.taoInEmission),
					spotPrice: BigInt(r.subnet_snapshots.spotPrice),
					movingPrice: BigInt(r.subnet_snapshots.movingPrice),
					subnetVolume: BigInt(r.subnet_snapshots.subnetVolume),
					tempo: r.subnet_snapshots.tempo,
					blocksSinceLastStep: BigInt(r.subnet_snapshots.blocksSinceLastStep),
					networkRegisteredAt: BigInt(r.subnet_snapshots.networkRegisteredAt),
					immunityPeriod: r.subnet_snapshots.immunityPeriod,
					subnetToPrune: r.subnet_snapshots.subnetToPrune,
				},
			}));
		},

		close() {
			sqlite.close();
		},

		getBlockMetas() {
			const rows = allBlockNumbersStmt.all() as Array<{
				block_number: number;
				timestamp: number;
			}>;
			return rows.map((r) => ({
				blockNumber: r.block_number,
				timestamp: r.timestamp,
			}));
		},

		getSnapshotsAtBlock(blockNumber) {
			const rows = snapshotsAtBlockStmt.all(blockNumber) as Array<{
				netuid: number;
				name: string;
				tao_in: string;
				alpha_in: string;
				alpha_out: string;
				tao_in_emission: string;
				spot_price: string;
				moving_price: string;
				subnet_volume: string;
				tempo: number;
				blocks_since_last_step: string;
				network_registered_at: string;
				immunity_period: number;
				subnet_to_prune: number | null;
			}>;
			return rows.map((r) => ({
				netuid: r.netuid,
				name: r.name,
				taoIn: BigInt(r.tao_in),
				alphaIn: BigInt(r.alpha_in),
				alphaOut: BigInt(r.alpha_out),
				taoInEmission: BigInt(r.tao_in_emission),
				spotPrice: BigInt(r.spot_price),
				movingPrice: BigInt(r.moving_price),
				subnetVolume: BigInt(r.subnet_volume),
				tempo: r.tempo,
				blocksSinceLastStep: BigInt(r.blocks_since_last_step),
				networkRegisteredAt: BigInt(r.network_registered_at),
				immunityPeriod: r.immunity_period,
				subnetToPrune: r.subnet_to_prune,
			}));
		},
	};
}

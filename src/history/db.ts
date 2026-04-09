import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { and, between, eq } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";
import type {
	CycleRecord,
	HistorySnapshot,
	SubnetSnapshot,
	TradeRecord,
} from "./types.ts";

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

	/** Record a rebalance cycle. Returns the auto-increment cycle ID. */
	recordCycle(cycle: CycleRecord): number;

	/** Record trade rows for a cycle in a single transaction. */
	recordTrades(trades: TradeRecord[]): void;

	/** Record a cycle and its trades atomically in a single transaction. */
	recordCycleWithTrades(cycle: CycleRecord, trades?: TradeRecord[]): void;

	/** Query cycles, optionally filtering by strategy. Newest first. */
	getCycles(opts?: {
		strategy?: string;
		limit?: number;
	}): Array<CycleRecord & { id: number }>;

	/** Get all trades for a given cycle ID. */
	getTradesForCycle(cycleId: number): TradeRecord[];

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

	// --- Position tracking tables ---
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS cycles (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			strategy        TEXT    NOT NULL,
			git_commit      TEXT    NOT NULL,
			block_number    INTEGER,
			tx_hash         TEXT,
			timestamp       INTEGER NOT NULL,
			status          TEXT    NOT NULL,
			total_before    TEXT    NOT NULL,
			total_after     TEXT    NOT NULL,
			fee_inner       TEXT    NOT NULL DEFAULT '0',
			fee_wrapper     TEXT    NOT NULL DEFAULT '0',
			ops_total       INTEGER NOT NULL DEFAULT 0,
			ops_succeeded   INTEGER NOT NULL DEFAULT 0,
			dry_run         INTEGER NOT NULL DEFAULT 0
		)
	`);
	sqlite.exec(
		"CREATE INDEX IF NOT EXISTS idx_cycles_strategy ON cycles(strategy)",
	);
	sqlite.exec(
		"CREATE INDEX IF NOT EXISTS idx_cycles_timestamp ON cycles(timestamp DESC)",
	);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS trades (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			cycle_id        INTEGER NOT NULL REFERENCES cycles(id),
			op_index        INTEGER NOT NULL,
			op_kind         TEXT    NOT NULL,
			netuid          INTEGER NOT NULL,
			origin_netuid   INTEGER,
			hotkey          TEXT    NOT NULL,
			success         INTEGER NOT NULL,
			error           TEXT,
			estimated_tao   TEXT    NOT NULL,
			alpha_amount    TEXT,
			tao_before      TEXT,
			tao_after       TEXT,
			alpha_before    TEXT,
			alpha_after     TEXT,
			spot_price      TEXT,
			UNIQUE(cycle_id, op_index)
		)
	`);
	sqlite.exec(
		"CREATE INDEX IF NOT EXISTS idx_trades_cycle ON trades(cycle_id)",
	);
	sqlite.exec("CREATE INDEX IF NOT EXISTS idx_trades_netuid ON trades(netuid)");

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

	// --- Position tracking statements ---
	const insertCycleStmt = sqlite.prepare(`
		INSERT INTO cycles (
			strategy, git_commit, block_number, tx_hash, timestamp,
			status, total_before, total_after, fee_inner, fee_wrapper,
			ops_total, ops_succeeded, dry_run
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const insertTradeStmt = sqlite.prepare(`
		INSERT INTO trades (
			cycle_id, op_index, op_kind, netuid, origin_netuid, hotkey,
			success, error, estimated_tao, alpha_amount,
			tao_before, tao_after, alpha_before, alpha_after, spot_price
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const insertTradesTxn = sqlite.transaction((trades: TradeRecord[]) => {
		for (const t of trades) {
			insertTradeStmt.run(
				t.cycleId,
				t.opIndex,
				t.opKind,
				t.netuid,
				t.originNetuid,
				t.hotkey,
				t.success ? 1 : 0,
				t.error,
				t.estimatedTao.toString(),
				t.alphaAmount?.toString() ?? null,
				t.taoBefore?.toString() ?? null,
				t.taoAfter?.toString() ?? null,
				t.alphaBefore?.toString() ?? null,
				t.alphaAfter?.toString() ?? null,
				t.spotPrice?.toString() ?? null,
			);
		}
	});
	const recordCycleWithTradesTxn = sqlite.transaction(
		(cycle: CycleRecord, trades?: TradeRecord[]): void => {
			const result = insertCycleStmt.run(
				cycle.strategy,
				cycle.gitCommit,
				cycle.blockNumber,
				cycle.txHash,
				cycle.timestamp,
				cycle.status,
				cycle.totalBefore.toString(),
				cycle.totalAfter.toString(),
				cycle.feeInner.toString(),
				cycle.feeWrapper.toString(),
				cycle.opsTotal,
				cycle.opsSucceeded,
				cycle.dryRun ? 1 : 0,
			);
			const cycleId = Number(result.lastInsertRowid);
			if (trades && trades.length > 0) {
				for (const t of trades) {
					insertTradeStmt.run(
						cycleId,
						t.opIndex,
						t.opKind,
						t.netuid,
						t.originNetuid,
						t.hotkey,
						t.success ? 1 : 0,
						t.error,
						t.estimatedTao.toString(),
						t.alphaAmount?.toString() ?? null,
						t.taoBefore?.toString() ?? null,
						t.taoAfter?.toString() ?? null,
						t.alphaBefore?.toString() ?? null,
						t.alphaAfter?.toString() ?? null,
						t.spotPrice?.toString() ?? null,
					);
				}
			}
		},
	);
	const getCyclesStmt = sqlite.prepare(
		"SELECT * FROM cycles WHERE (? IS NULL OR strategy = ?) ORDER BY timestamp DESC LIMIT ?",
	);
	const getTradesForCycleStmt = sqlite.prepare(
		"SELECT * FROM trades WHERE cycle_id = ? ORDER BY op_index ASC",
	);

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

		recordCycle(cycle) {
			const result = insertCycleStmt.run(
				cycle.strategy,
				cycle.gitCommit,
				cycle.blockNumber,
				cycle.txHash,
				cycle.timestamp,
				cycle.status,
				cycle.totalBefore.toString(),
				cycle.totalAfter.toString(),
				cycle.feeInner.toString(),
				cycle.feeWrapper.toString(),
				cycle.opsTotal,
				cycle.opsSucceeded,
				cycle.dryRun ? 1 : 0,
			);
			return Number(result.lastInsertRowid);
		},

		recordTrades(trades) {
			if (trades.length === 0) return;
			insertTradesTxn(trades);
		},

		recordCycleWithTrades(cycle, trades) {
			recordCycleWithTradesTxn(cycle, trades);
		},

		getCycles(opts) {
			const strategy = opts?.strategy ?? null;
			const limit = opts?.limit ?? 100;
			const rows = getCyclesStmt.all(strategy, strategy, limit) as Array<{
				id: number;
				strategy: string;
				git_commit: string;
				block_number: number | null;
				tx_hash: string | null;
				timestamp: number;
				status: string;
				total_before: string;
				total_after: string;
				fee_inner: string;
				fee_wrapper: string;
				ops_total: number;
				ops_succeeded: number;
				dry_run: number;
			}>;
			return rows.map((r) => ({
				id: r.id,
				strategy: r.strategy,
				gitCommit: r.git_commit,
				blockNumber: r.block_number,
				txHash: r.tx_hash,
				timestamp: r.timestamp,
				status: r.status as CycleRecord["status"],
				totalBefore: BigInt(r.total_before),
				totalAfter: BigInt(r.total_after),
				feeInner: BigInt(r.fee_inner),
				feeWrapper: BigInt(r.fee_wrapper),
				opsTotal: r.ops_total,
				opsSucceeded: r.ops_succeeded,
				dryRun: r.dry_run === 1,
			}));
		},

		getTradesForCycle(cycleId) {
			const rows = getTradesForCycleStmt.all(cycleId) as Array<{
				id: number;
				cycle_id: number;
				op_index: number;
				op_kind: string;
				netuid: number;
				origin_netuid: number | null;
				hotkey: string;
				success: number;
				error: string | null;
				estimated_tao: string;
				alpha_amount: string | null;
				tao_before: string | null;
				tao_after: string | null;
				alpha_before: string | null;
				alpha_after: string | null;
				spot_price: string | null;
			}>;
			return rows.map((r) => ({
				cycleId: r.cycle_id,
				opIndex: r.op_index,
				opKind: r.op_kind,
				netuid: r.netuid,
				originNetuid: r.origin_netuid,
				hotkey: r.hotkey,
				success: r.success === 1,
				error: r.error,
				estimatedTao: BigInt(r.estimated_tao),
				alphaAmount: r.alpha_amount !== null ? BigInt(r.alpha_amount) : null,
				taoBefore: r.tao_before !== null ? BigInt(r.tao_before) : null,
				taoAfter: r.tao_after !== null ? BigInt(r.tao_after) : null,
				alphaBefore: r.alpha_before !== null ? BigInt(r.alpha_before) : null,
				alphaAfter: r.alpha_after !== null ? BigInt(r.alpha_after) : null,
				spotPrice: r.spot_price !== null ? BigInt(r.spot_price) : null,
			}));
		},
	};
}

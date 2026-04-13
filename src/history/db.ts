import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HistoryDataError } from "../errors.ts";
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

	/**
	 * Check whether the DB has emission data populated.
	 * Returns true if the DB is empty OR has non-zero emission columns.
	 * Returns false if the DB has rows but all emission columns are '0'
	 * (indicating data was backfilled before the emission schema was added).
	 */
	hasEmissionData(): boolean;

	close(): void;
}

interface SnapshotRow {
	netuid: number;
	name: string;
	tao_in: string;
	alpha_in: string;
	alpha_out: string;
	tao_in_emission: string;
	alpha_out_emission: string;
	alpha_in_emission: string;
	pending_alpha_emission: string;
	pending_root_emission: string;
	spot_price: string;
	moving_price: string;
	subnet_volume: string;
	tempo: number;
	blocks_since_last_step: string;
	network_registered_at: string;
	immunity_period: number;
	subnet_to_prune: number | null;
}

interface SubnetSeriesRow extends SnapshotRow {
	block_number: number;
	block_hash: string;
	timestamp: number;
}

/**
 * Verify the history DB contains emission data. If the DB has snapshot rows
 * but all emission columns are zero, it was backfilled before the emission
 * schema was added and must be re-created.
 *
 * Throws a typed error so entrypoints can decide how to surface the failure.
 */
export function assertEmissionData(db: HistoryDatabase): void {
	if (!db.hasEmissionData()) {
		throw new HistoryDataError(
			"\n" +
				"═".repeat(60) +
				"\n" +
				"  ❌ History DB is missing emission data.\n" +
				"\n" +
				"  The database was backfilled before the emission-aware schema\n" +
				"  was added. Backtest emission accrual requires these columns\n" +
				"  to contain real values from DynamicInfo.\n" +
				"\n" +
				"  To fix, delete the DB and re-backfill:\n" +
				"\n" +
				"    rm data/history.sqlite\n" +
				"    bun backfill -- --days 30\n" +
				"\n" +
				"═".repeat(60) +
				"\n",
		);
	}
}

export function openHistoryDatabase(dbPath: string): HistoryDatabase {
	mkdirSync(dirname(dbPath), { recursive: true });
	const sqlite = new Database(dbPath);

	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec("PRAGMA synchronous = NORMAL");

	// Ensure WAL is checkpointed on process exit so -wal/-shm files are cleaned up.
	// Using "exit" (not "beforeExit") because "beforeExit" does NOT fire on all
	// shutdown paths — only when the event loop drains naturally.
	let closed = false;
	const onExit = () => {
		if (closed) return;
		closed = true;
		try {
			sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			sqlite.close();
		} catch {
			// DB may already be closed
		}
	};
	process.on("exit", onExit);

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
			alpha_out_emission    TEXT    NOT NULL DEFAULT '0',
			alpha_in_emission     TEXT    NOT NULL DEFAULT '0',
			pending_alpha_emission TEXT   NOT NULL DEFAULT '0',
			pending_root_emission TEXT    NOT NULL DEFAULT '0',
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

	// Migrate existing DBs: add emission columns if missing.
	// SQLite has no ADD COLUMN IF NOT EXISTS — use try/catch per column.
	for (const col of [
		"alpha_out_emission TEXT NOT NULL DEFAULT '0'",
		"alpha_in_emission TEXT NOT NULL DEFAULT '0'",
		"pending_alpha_emission TEXT NOT NULL DEFAULT '0'",
		"pending_root_emission TEXT NOT NULL DEFAULT '0'",
	]) {
		try {
			sqlite.exec(`ALTER TABLE subnet_snapshots ADD COLUMN ${col}`);
		} catch {
			// Column already exists — ignore
		}
	}

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
	const subnetSeriesStmt = sqlite.prepare(`
		SELECT s.*, b.block_number, b.block_hash, b.timestamp
		FROM subnet_snapshots s
		INNER JOIN blocks b ON s.block_hash = b.block_hash
		WHERE s.netuid = ?
		  AND b.block_number BETWEEN ? AND ?
		ORDER BY b.block_number ASC
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
			tao_in_emission, alpha_out_emission, alpha_in_emission,
			pending_alpha_emission, pending_root_emission,
			spot_price, moving_price, subnet_volume,
			tempo, blocks_since_last_step, network_registered_at,
			immunity_period, subnet_to_prune
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
					s.alphaOutEmission.toString(),
					s.alphaInEmission.toString(),
					s.pendingAlphaEmission.toString(),
					s.pendingRootEmission.toString(),
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
			const rows = subnetSeriesStmt.all(
				netuid,
				fromBlock,
				toBlock,
			) as Array<SubnetSeriesRow>;

			return rows.map((row) => ({
				blockNumber: row.block_number,
				blockHash: row.block_hash,
				timestamp: row.timestamp,
				snapshot: mapSnapshotRow(row),
			}));
		},

		close() {
			if (closed) return;
			closed = true;
			process.removeListener("exit", onExit);
			sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			sqlite.close();
		},

		hasEmissionData() {
			const row = sqlite
				.query(
					`SELECT COUNT(*) as total,
					        SUM(CASE WHEN alpha_out_emission != '0' THEN 1 ELSE 0 END) as with_emission
					 FROM subnet_snapshots`,
				)
				.get() as { total: number; with_emission: number };
			// Empty DB is fine (no stale data). Non-empty with zero emission rows is stale.
			return row.total === 0 || row.with_emission > 0;
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
			const rows = snapshotsAtBlockStmt.all(blockNumber) as Array<SnapshotRow>;
			return rows.map((row) => mapSnapshotRow(row));
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

function mapSnapshotRow(row: SnapshotRow): SubnetSnapshot {
	return {
		netuid: row.netuid,
		name: row.name,
		taoIn: BigInt(row.tao_in),
		alphaIn: BigInt(row.alpha_in),
		alphaOut: BigInt(row.alpha_out),
		taoInEmission: BigInt(row.tao_in_emission),
		alphaOutEmission: BigInt(row.alpha_out_emission),
		alphaInEmission: BigInt(row.alpha_in_emission),
		pendingAlphaEmission: BigInt(row.pending_alpha_emission),
		pendingRootEmission: BigInt(row.pending_root_emission),
		spotPrice: BigInt(row.spot_price),
		movingPrice: BigInt(row.moving_price),
		subnetVolume: BigInt(row.subnet_volume),
		tempo: row.tempo,
		blocksSinceLastStep: BigInt(row.blocks_since_last_step),
		networkRegisteredAt: BigInt(row.network_registered_at),
		immunityPeriod: row.immunity_period,
		subnetToPrune: row.subnet_to_prune,
	};
}

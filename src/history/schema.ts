import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const blocks = sqliteTable(
	"blocks",
	{
		blockHash: text("block_hash").primaryKey(),
		blockNumber: integer("block_number").notNull().unique(),
		timestamp: integer("timestamp").notNull(),
	},
	(table) => [
		index("idx_blocks_number").on(table.blockNumber),
		check("block_grid_25", sql`block_number % 25 = 0`),
	],
);

export const subnetSnapshots = sqliteTable(
	"subnet_snapshots",
	{
		blockHash: text("block_hash")
			.notNull()
			.references(() => blocks.blockHash),
		netuid: integer("netuid").notNull(),
		name: text("name").notNull(),
		taoIn: text("tao_in").notNull(),
		alphaIn: text("alpha_in").notNull(),
		alphaOut: text("alpha_out").notNull(),
		taoInEmission: text("tao_in_emission").notNull(),
		alphaOutEmission: text("alpha_out_emission").notNull(),
		alphaInEmission: text("alpha_in_emission").notNull(),
		pendingAlphaEmission: text("pending_alpha_emission").notNull(),
		pendingRootEmission: text("pending_root_emission").notNull(),
		spotPrice: text("spot_price").notNull(),
		movingPrice: text("moving_price").notNull(),
		subnetVolume: text("subnet_volume").notNull(),
		tempo: integer("tempo").notNull(),
		blocksSinceLastStep: text("blocks_since_last_step").notNull(),
		networkRegisteredAt: text("network_registered_at").notNull(),
		immunityPeriod: integer("immunity_period").notNull(),
		subnetToPrune: integer("subnet_to_prune"),
	},
	(table) => [
		primaryKey({ columns: [table.blockHash, table.netuid] }),
		index("idx_snapshots_netuid_block").on(table.netuid, table.blockHash),
	],
);

import { join } from "node:path";
import { createBittensorClient } from "./api/createClient.ts";
import { suppressRpcNoise } from "./api/suppressRpcNoise.ts";
import { loadEnv } from "./config/env.ts";
import { openHistoryDatabase } from "./history/db.ts";
import { buildRunnerContext } from "./scheduling/context.ts";
import { loadStrategy, resolveStrategyName } from "./strategies/loader.ts";

// Silence harmless "RpcError: Method not found" (-32601) warnings that
// polkadot-api emits when its archive_v1_* fallback hits Bittensor nodes
// (which don't implement the archive JSON-RPC spec). See suppressRpcNoise.ts.
suppressRpcNoise();

// --- Resolve strategy ---
const env = loadEnv();
const strategyName = resolveStrategyName(env.strategy);
const { getStrategyTargets, createRunner } = await loadStrategy(strategyName);

// --- Open shared history DB ---
const historyDb = openHistoryDatabase(join("data", "history.sqlite"));

// --- Build context ---
const bittensorClient = createBittensorClient(env.wsEndpoints);
const context = buildRunnerContext(
	bittensorClient,
	env,
	strategyName,
	getStrategyTargets,
	{ dryRun: false },
	historyDb,
);

// --- Start strategy runner ---
const runner = createRunner(context);
await runner.start();

// --- Graceful shutdown ---
let isShuttingDown = false;
const shutdown = async () => {
	if (isShuttingDown) return;
	isShuttingDown = true;
	console.log("[scheduler] Shutting down...");
	await runner.stop();
	historyDb.close();
	bittensorClient.client.destroy();
	process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

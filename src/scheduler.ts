import { createBittensorClient } from "./api/createClient.ts";
import { loadEnv } from "./config/env.ts";
import { buildRunnerContext } from "./scheduling/context.ts";
import { loadStrategy, resolveStrategyName } from "./strategies/loader.ts";

// --- Resolve strategy ---
const env = loadEnv();
const strategyName = resolveStrategyName(env.strategy);
const { getStrategyTargets, createRunner } = await loadStrategy(strategyName);

// --- Build context ---
const bittensorClient = createBittensorClient(env.wsEndpoints);
const context = buildRunnerContext(
	bittensorClient,
	env,
	strategyName,
	getStrategyTargets,
	{ dryRun: false },
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
	bittensorClient.client.destroy();
	process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

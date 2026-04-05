import { createBittensorClient } from "./api/createClient.ts";
import { suppressRpcNoise } from "./api/suppressRpcNoise.ts";
import { loadEnv } from "./config/env.ts";
import { log } from "./rebalance/logger.ts";
import { buildRunnerContext } from "./scheduling/context.ts";
import { createOneShotRunner } from "./scheduling/once.ts";
import { loadStrategy, resolveStrategyName } from "./strategies/loader.ts";

// Silence harmless "RpcError: Method not found" (-32601) warnings that
// polkadot-api emits when its archive_v1_* fallback hits Bittensor nodes
// (which don't implement the archive JSON-RPC spec). See suppressRpcNoise.ts.
suppressRpcNoise();

export interface RunRebalanceOptions {
	dryRun: boolean;
}

export async function runRebalance({
	dryRun,
}: RunRebalanceOptions): Promise<number> {
	const env = loadEnv();
	const strategyName = resolveStrategyName(env.strategy);
	const { getStrategyTargets } = await loadStrategy(strategyName);
	log.info(`Strategy: ${strategyName}`);

	const bittensorClient = createBittensorClient(env.wsEndpoints);

	try {
		const context = buildRunnerContext(
			bittensorClient,
			env,
			strategyName,
			getStrategyTargets,
			{ dryRun },
		);

		let cycleExitCode = 0;
		const runner = createOneShotRunner(async () => {
			const { exitCode } = await context.runRebalanceCycle();
			cycleExitCode = exitCode;
		});

		await runner.start();
		return cycleExitCode;
	} finally {
		bittensorClient.client.destroy();
	}
}

// --- One-shot CLI entrypoint (only when run directly, not when imported) ---
if (import.meta.main) {
	const dryRun = process.argv.includes("--dry-run");
	const exitCode = await runRebalance({ dryRun });
	process.exit(exitCode);
}

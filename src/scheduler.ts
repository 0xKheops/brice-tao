import { join } from "node:path";
import { createBittensorClient } from "./api/createClient.ts";
import { suppressRpcNoise } from "./api/suppressRpcNoise.ts";
import { loadEnv } from "./config/env.ts";
import { assertEmissionData, openHistoryDatabase } from "./history/db.ts";
import { buildRunnerContext } from "./scheduling/context.ts";
import {
	formatStrategyList,
	loadStrategy,
	resolveStrategySelection,
} from "./strategies/loader.ts";

// Silence harmless "RpcError: Method not found" (-32601) warnings that
// polkadot-api emits when its archive_v1_* fallback hits Bittensor nodes
// (which don't implement the archive JSON-RPC spec). See suppressRpcNoise.ts.
suppressRpcNoise();

export async function runScheduler(): Promise<void> {
	const env = loadEnv();
	const selection = resolveStrategySelection({ envStrategy: env.strategy });
	if (selection.kind === "list") {
		console.log(formatStrategyList(selection.available));
		return;
	}

	const strategyName = selection.name;
	const { getStrategyTargets, createRunner, preparePreview, warmup } =
		loadStrategy(strategyName);

	const historyDb = openHistoryDatabase(join("data", "history.sqlite"));
	let runner: Awaited<ReturnType<typeof createRunner>> | undefined;
	let isShuttingDown = false;

	try {
		assertEmissionData(historyDb);
		const bittensorClient = createBittensorClient(env.wsEndpoints);
		const context = buildRunnerContext(
			bittensorClient,
			env,
			strategyName,
			getStrategyTargets,
			{ dryRun: false },
			historyDb,
		);

		const shutdown = async () => {
			if (isShuttingDown) return;
			isShuttingDown = true;
			console.log("[scheduler] Shutting down...");
			if (runner) await runner.stop();
			historyDb.close();
			bittensorClient.client.destroy();
		};

		process.on("SIGTERM", () => {
			void shutdown();
		});
		process.on("SIGINT", () => {
			void shutdown();
		});

		try {
			if (warmup) {
				await warmup(env, historyDb);
			}

			if (preparePreview) {
				await preparePreview();
			}

			console.log("[scheduler] Running initial rebalance on startup...");
			const result = await context.runRebalanceCycle();
			if (result.exitCode === 0) {
				console.log(
					`[scheduler] Initial rebalance completed successfully (${result.outcome}).`,
				);
			} else {
				console.error(
					`[scheduler] Initial rebalance finished with exit code ${result.exitCode} (${result.outcome}) — continuing to scheduled runs.`,
				);
			}

			runner = createRunner(context);
			await runner.start();
		} catch (err) {
			await shutdown();
			throw err;
		}
	} finally {
		// Only close the DB here if the runner never started (early error).
		// When the runner IS active, the DB stays open and is closed later by
		// shutdown() on SIGTERM/SIGINT (or by the process.on("exit") handler
		// registered inside openHistoryDatabase()).
		if (!isShuttingDown && !runner) {
			historyDb.close();
		}
	}
}

if (import.meta.main) {
	await runScheduler();
}

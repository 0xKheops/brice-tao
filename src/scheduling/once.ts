import type { StrategyRunner } from "./types.ts";

/**
 * One-shot runner: executes a single rebalance cycle then returns.
 * Used by the `bun rebalance` CLI for consistency with the runner abstraction.
 */
export function createOneShotRunner(
	onRun: () => Promise<void>,
): StrategyRunner {
	return {
		async start() {
			await onRun();
		},
		async stop() {
			// no-op — already finished
		},
	};
}

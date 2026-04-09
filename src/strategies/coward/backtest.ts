import type { StrategyTarget } from "../../rebalance/types.ts";
import type { BacktestStep, BacktestStrategy } from "../types.ts";

const DUMMY_HOTKEY = "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM";

export function createBacktest(): BacktestStrategy {
	return {
		observe() {
			return { needsRebalance: false };
		},

		step(): BacktestStep {
			const targets: StrategyTarget[] = [
				{ netuid: 0, hotkey: DUMMY_HOTKEY, share: 1 },
			];
			return { targets };
		},
	};
}

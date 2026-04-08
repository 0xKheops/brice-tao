import { Cron } from "croner";
import type {
	CronScheduleConfig,
	RebalanceCycleResult,
	StrategyRunner,
} from "./types.ts";

export interface CronRunnerOptions {
	schedule: CronScheduleConfig;
	onTick: () => Promise<RebalanceCycleResult>;
	label: string;
}

/**
 * Create a cron-based strategy runner with overlap protection and stale timeout.
 * All schedules are evaluated in UTC to avoid DST / locale drift.
 */
export function createCronRunner({
	schedule,
	onTick,
	label,
}: CronRunnerOptions): StrategyRunner {
	let job: Cron | undefined;
	/** Promise tracking the currently in-flight cycle (null when idle) */
	let inflightRun: Promise<void> | null = null;

	async function tick(): Promise<void> {
		if (inflightRun) {
			console.warn(
				`[${label}] Skipping scheduled run — previous run still in progress`,
			);
			return;
		}

		const run = async (): Promise<void> => {
			const staleTimer = setTimeout(() => {
				console.error(
					`[${label}] Run exceeded stale timeout of ${schedule.staleTimeoutMinutes} minutes — will NOT interrupt; next tick will still be skipped until this run completes`,
				);
			}, schedule.staleTimeoutMinutes * 60_000);

			try {
				console.log(`[${label}] Starting run...`);
				const { exitCode } = await onTick();
				if (exitCode === 0) {
					console.log(`[${label}] Run finished successfully`);
				} else {
					console.error(`[${label}] Run finished with exit code ${exitCode}`);
				}
			} catch (err) {
				console.error(`[${label}] Unexpected error in run:`, err);
			} finally {
				clearTimeout(staleTimer);
				inflightRun = null;
			}
		};

		inflightRun = run();
		await inflightRun;
	}

	return {
		async start() {
			job = new Cron(schedule.cronSchedule, { timezone: "UTC" }, tick);
			const nextRun = job.nextRun();
			console.log(
				`[${label}] Started — schedule: ${schedule.cronSchedule} (UTC)`,
			);
			console.log(
				`[${label}] Next run: ${nextRun ? nextRun.toISOString() : "unknown"}`,
			);
		},

		async stop() {
			job?.stop();
			job = undefined;
			// Wait for any in-flight cycle to actually complete
			if (inflightRun) {
				await inflightRun;
			}
		},
	};
}

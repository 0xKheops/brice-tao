import { writeFileSync } from "node:fs";
import { Cron } from "croner";
import type {
	CronScheduleConfig,
	RebalanceCycleResult,
	StrategyRunner,
} from "./types.ts";

/**
 * Write a heartbeat deadline (epoch seconds) to `data/heartbeat`.
 * Docker healthcheck verifies the deadline is still in the future.
 */
function writeHeartbeat(deadlineSeconds: number): void {
	try {
		writeFileSync("data/heartbeat", String(Math.round(deadlineSeconds)));
	} catch {
		// Non-critical — don't fail the run
	}
}

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
	let consecutiveStaleTimeouts = 0;
	const MAX_CONSECUTIVE_STALE = 3;

	/** Compute the heartbeat deadline: next cron fire + stale timeout margin */
	function heartbeatDeadline(): number {
		const nextRun = job?.nextRun();
		const nextRunSeconds = nextRun
			? nextRun.getTime() / 1000
			: Date.now() / 1000 + 3600; // fallback 1h if unknown
		return nextRunSeconds + schedule.staleTimeoutMinutes * 60;
	}

	async function tick(): Promise<void> {
		if (inflightRun) {
			console.warn(
				`[${label}] Skipping scheduled run — previous run still in progress`,
			);
			return;
		}

		const run = async (): Promise<void> => {
			const staleTimer = setTimeout(() => {
				consecutiveStaleTimeouts++;
				console.error(
					`[${label}] Run exceeded stale timeout of ${schedule.staleTimeoutMinutes} minutes — will NOT interrupt; next tick will still be skipped until this run completes (consecutive: ${consecutiveStaleTimeouts}/${MAX_CONSECUTIVE_STALE})`,
				);
				if (consecutiveStaleTimeouts >= MAX_CONSECUTIVE_STALE) {
					console.error(
						`[${label}] ${MAX_CONSECUTIVE_STALE} consecutive stale timeouts — exiting for container restart`,
					);
					process.exit(1);
				}
			}, schedule.staleTimeoutMinutes * 60_000);

			try {
				console.log(`[${label}] Starting run...`);
				const { exitCode } = await onTick();
				consecutiveStaleTimeouts = 0;
				if (exitCode === 0) {
					console.log(`[${label}] Run finished successfully`);
				} else {
					console.error(`[${label}] Run finished with exit code ${exitCode}`);
				}
			} catch (err) {
				console.error(`[${label}] Unexpected error in run:`, err);
			} finally {
				clearTimeout(staleTimer);
				writeHeartbeat(heartbeatDeadline());
			}
		};

		inflightRun = run();
		try {
			await inflightRun;
		} finally {
			inflightRun = null;
		}
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
			writeHeartbeat(heartbeatDeadline());
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

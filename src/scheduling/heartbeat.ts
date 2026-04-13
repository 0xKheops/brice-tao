import { writeFileSync } from "node:fs";

/**
 * Write a heartbeat deadline (epoch seconds) to `data/heartbeat`.
 * Docker healthcheck verifies the deadline is still in the future.
 */
export function writeHeartbeat(deadlineSeconds: number): void {
	try {
		writeFileSync("data/heartbeat", String(Math.round(deadlineSeconds)));
	} catch {
		// Non-critical — don't fail the run
	}
}

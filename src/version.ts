import { execSync } from "node:child_process";

function resolveCommitHash(): string {
	const fromEnv = process.env.GIT_COMMIT;
	if (fromEnv) return fromEnv;

	try {
		return execSync("git rev-parse --short HEAD", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return "unknown";
	}
}

export const GIT_COMMIT = resolveCommitHash();

import { describe, expect, it } from "bun:test";
import { initLog, log } from "./logger.ts";

describe("logger", () => {
	it("filePath returns disabled marker when no file initialized", () => {
		expect(log.filePath()).toBe("file-logging-disabled");
	});

	it("initLog does not throw in test environment", () => {
		expect(() => initLog({ dryRun: true })).not.toThrow();
		expect(() => initLog({ dryRun: false })).not.toThrow();
	});

	it("all log methods accept messages without throwing", () => {
		expect(() => log.info("test info")).not.toThrow();
		expect(() => log.verbose("test verbose")).not.toThrow();
		expect(() => log.warn("test warn")).not.toThrow();
		expect(() => log.error("test error")).not.toThrow();
		expect(() => log.console("test console")).not.toThrow();
	});

	it("log methods accept structured data", () => {
		expect(() => log.info("info", { netuid: 5, amount: 100n })).not.toThrow();
		expect(() => log.verbose("swap", { from: 1, to: 2 })).not.toThrow();
		expect(() => log.warn("low balance", { balance: 0n })).not.toThrow();
	});

	it("log.error accepts Error objects with data", () => {
		expect(() =>
			log.error("operation failed", new Error("boom"), { op: "stake" }),
		).not.toThrow();
		expect(() => log.error("plain error", new Error("oops"))).not.toThrow();
		expect(() => log.error("no error object")).not.toThrow();
	});
});

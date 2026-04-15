/**
 * Multi-strategy backtest comparison.
 *
 * Runs `bun backtest` for each backtestable strategy, parses the JSON metrics
 * from the report, and outputs a ranked comparison table.
 *
 * Usage:
 *   bun compare -- --days 30
 *   bun compare -- --days 7 --strategies root-emission,coward
 *   bun compare -- --days 14 --initial-tao 100
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ── CLI parsing ──

interface CompareOptions {
	days?: number;
	initialTao?: number;
	strategies?: string[];
}

function parseArgs(argv: string[]): CompareOptions {
	const opts: CompareOptions = {};

	const daysIdx = argv.indexOf("--days");
	if (daysIdx !== -1) {
		const v = Number.parseInt(argv[daysIdx + 1] ?? "", 10);
		if (Number.isNaN(v) || v <= 0)
			throw new Error("--days must be a positive integer");
		opts.days = v;
	}

	const taoIdx = argv.indexOf("--initial-tao");
	if (taoIdx !== -1) {
		const v = Number.parseInt(argv[taoIdx + 1] ?? "", 10);
		if (Number.isNaN(v) || v <= 0)
			throw new Error("--initial-tao must be a positive integer");
		opts.initialTao = v;
	}

	const stratIdx = argv.indexOf("--strategies");
	if (stratIdx !== -1) {
		const raw = argv[stratIdx + 1];
		if (!raw || raw.startsWith("--"))
			throw new Error("--strategies requires a value");
		opts.strategies = raw.split(",").map((s) => s.trim());
	}

	return opts;
}

// ── Strategy discovery ──

async function discoverBacktestableStrategies(): Promise<string[]> {
	const proc = Bun.spawn(["bun", "backtest", "--", "--list-strategies"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;

	// Parse "Available strategies:" output — lines like "  - root-emission"
	return stdout
		.split("\n")
		.filter((l) => l.trim().startsWith("- "))
		.map((l) => l.trim().replace(/^- /, ""));
}

interface StrategyResult {
	name: string;
	success: boolean;
	reportPath?: string;
	json?: Record<string, unknown>;
	error?: string;
}

// ── Run single backtest ──

async function runBacktest(
	strategy: string,
	opts: CompareOptions,
): Promise<StrategyResult> {
	const args = ["bun", "backtest", "--", "--strategy", strategy];
	if (opts.days) args.push("--days", String(opts.days));
	if (opts.initialTao) args.push("--initial-tao", String(opts.initialTao));

	console.log(`  ▸ Running: ${args.join(" ")}`);
	const proc = Bun.spawn(args, {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		const errMsg = stderr.trim() || stdout.trim().slice(0, 200);
		return { name: strategy, success: false, error: errMsg };
	}

	// Extract report path from stdout: "  📄 Full report: reports/backtest-xxx.md"
	const reportMatch = stdout.match(/Full report:\s*(.+\.md)/);
	if (!reportMatch) {
		return {
			name: strategy,
			success: false,
			error: "Could not find report path in output",
		};
	}

	const reportPath = reportMatch[1] as string;
	try {
		const reportContent = await readFile(reportPath, "utf-8");
		const json = extractJsonBlock(reportContent);
		if (!json) {
			return {
				name: strategy,
				success: false,
				reportPath,
				error: "Could not parse JSON metrics from report",
			};
		}
		return { name: strategy, success: true, reportPath, json };
	} catch (err) {
		return {
			name: strategy,
			success: false,
			reportPath,
			error: `Failed to read report: ${err}`,
		};
	}
}

function extractJsonBlock(markdown: string): Record<string, unknown> | null {
	// Match the ```json ... ``` block after "## Raw Metrics (JSON)"
	const match = markdown.match(
		/## Raw Metrics \(JSON\)\s*\n+```json\n([\s\S]*?)\n```/,
	);
	if (!match) return null;
	try {
		return JSON.parse(match[1] as string) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// ── Comparison table ──

interface MetricDef {
	key: string;
	label: string;
	format: (v: unknown) => string;
	higherIsBetter: boolean;
}

function pct(v: unknown): string {
	if (v === null || v === undefined) return "—";
	return `${(v as number).toFixed(2)}%`;
}
function ratio(v: unknown): string {
	if (v === null || v === undefined) return "—";
	return (v as number).toFixed(4);
}
function days(v: unknown): string {
	if (v === null || v === undefined) return "—";
	return `${(v as number).toFixed(1)}d`;
}
function num(v: unknown): string {
	if (v === null || v === undefined) return "—";
	return String(v);
}

const COMPARISON_METRICS: MetricDef[] = [
	{
		key: "metrics.totalReturnPct",
		label: "Total Return",
		format: pct,
		higherIsBetter: true,
	},
	{ key: "metrics.cagr", label: "CAGR", format: pct, higherIsBetter: true },
	{
		key: "metrics.annualizedVolatility",
		label: "Volatility",
		format: pct,
		higherIsBetter: false,
	},
	{
		key: "metrics.sharpeRatio",
		label: "Sharpe",
		format: ratio,
		higherIsBetter: true,
	},
	{
		key: "metrics.sortinoRatio",
		label: "Sortino",
		format: ratio,
		higherIsBetter: true,
	},
	{
		key: "metrics.calmarRatio",
		label: "Calmar",
		format: ratio,
		higherIsBetter: true,
	},
	{
		key: "metrics.informationRatio",
		label: "Info Ratio",
		format: ratio,
		higherIsBetter: true,
	},
	{ key: "metrics.alpha", label: "Alpha", format: pct, higherIsBetter: true },
	{ key: "metrics.beta", label: "Beta", format: ratio, higherIsBetter: false },
	{
		key: "metrics.maxDrawdownPct",
		label: "Max DD",
		format: pct,
		higherIsBetter: false,
	},
	{
		key: "metrics.maxDrawdownDurationDays",
		label: "Max DD Duration",
		format: days,
		higherIsBetter: false,
	},
	{
		key: "metrics.recoveryFactor",
		label: "Recovery Factor",
		format: ratio,
		higherIsBetter: true,
	},
	{
		key: "metrics.winRate",
		label: "Win Rate",
		format: pct,
		higherIsBetter: true,
	},
	{
		key: "metrics.profitFactor",
		label: "Profit Factor",
		format: ratio,
		higherIsBetter: true,
	},
	{
		key: "metrics.maxConsecLosses",
		label: "Max Consec Losses",
		format: num,
		higherIsBetter: false,
	},
	{
		key: "metrics.var95",
		label: "VaR 95%",
		format: pct,
		higherIsBetter: false,
	},
	{
		key: "efficiency.turnoverRatio",
		label: "Turnover",
		format: ratio,
		higherIsBetter: false,
	},
	{
		key: "efficiency.costDragPct",
		label: "Cost Drag",
		format: pct,
		higherIsBetter: false,
	},
	{
		key: "run.totalFeesTao",
		label: "Fees (τ)",
		format: (v) => String(v ?? "—"),
		higherIsBetter: false,
	},
];

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
	const parts = path.split(".");
	let current: unknown = obj;
	for (const part of parts) {
		if (current === null || current === undefined) return null;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

// ANSI helpers
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function rankIndicator(rank: number, total: number): string {
	if (total <= 1) return "";
	if (rank === 0) return ` ${GREEN}★${RESET}`;
	if (rank === total - 1) return ` ${RED}▼${RESET}`;
	return "";
}

function formatComparisonTable(results: StrategyResult[]): string {
	const successful = results.filter((r) => r.success && r.json);
	if (successful.length === 0)
		return "No successful backtest results to compare.";

	const names = successful.map((r) => r.name);
	const colWidth = Math.max(14, ...names.map((n) => n.length + 3));
	const labelWidth =
		Math.max(...COMPARISON_METRICS.map((m) => m.label.length)) + 2;

	const lines: string[] = [];
	lines.push("");
	lines.push(
		`${BOLD}${CYAN}╔${"═".repeat(labelWidth + colWidth * names.length + 2)}╗${RESET}`,
	);
	lines.push(
		`${BOLD}${CYAN}║${RESET}${BOLD}  📊 STRATEGY COMPARISON${" ".repeat(Math.max(0, labelWidth + colWidth * names.length - 23))}${BOLD}${CYAN}║${RESET}`,
	);
	lines.push(
		`${BOLD}${CYAN}╠${"═".repeat(labelWidth + colWidth * names.length + 2)}╣${RESET}`,
	);

	// Header row
	let header = `${DIM}  ${"Metric".padEnd(labelWidth)}${RESET}`;
	for (const name of names) {
		header += `${BOLD}${name.padStart(colWidth)}${RESET}`;
	}
	lines.push(header);
	lines.push(
		`${DIM}  ${"─".repeat(labelWidth + colWidth * names.length)}${RESET}`,
	);

	// Metric rows
	for (const metric of COMPARISON_METRICS) {
		const values = successful.map((r) =>
			getNestedValue(r.json as Record<string, unknown>, metric.key),
		);
		const numericValues = values
			.map((v, i) => ({ v: v as number | null, i }))
			.filter(
				(x) => x.v !== null && x.v !== undefined && typeof x.v === "number",
			)
			.sort((a, b) =>
				metric.higherIsBetter
					? (b.v as number) - (a.v as number)
					: (a.v as number) - (b.v as number),
			);

		const rankMap = new Map<number, number>();
		for (let r = 0; r < numericValues.length; r++) {
			rankMap.set((numericValues[r] as { v: number; i: number }).i, r);
		}

		let row = `  ${metric.label.padEnd(labelWidth)}`;
		for (let i = 0; i < successful.length; i++) {
			const formatted = metric.format(values[i]);
			const rank = rankMap.get(i);
			const indicator =
				rank !== undefined ? rankIndicator(rank, numericValues.length) : "";
			row += `${formatted.padStart(colWidth - (indicator ? 2 : 0))}${indicator}`;
		}
		lines.push(row);
	}

	lines.push(
		`${BOLD}${CYAN}╚${"═".repeat(labelWidth + colWidth * names.length + 2)}╝${RESET}`,
	);
	lines.push("");
	lines.push(`  ${GREEN}★${RESET} = best · ${RED}▼${RESET} = worst`);
	lines.push("");

	return lines.join("\n");
}

function formatComparisonMarkdown(results: StrategyResult[]): string {
	const successful = results.filter((r) => r.success && r.json);
	if (successful.length === 0) return "No successful backtest results.";

	const names = successful.map((r) => r.name);
	const lines: string[] = [];
	lines.push("# Strategy Comparison");
	lines.push("");
	lines.push(
		`> Generated ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
	);
	lines.push("");

	// Summary table
	lines.push("## Ranking Table");
	lines.push("");
	lines.push(`| Metric | ${names.join(" | ")} |`);
	lines.push(`| --- | ${names.map(() => "---:").join(" | ")} |`);

	for (const metric of COMPARISON_METRICS) {
		const values = successful.map((r) =>
			getNestedValue(r.json as Record<string, unknown>, metric.key),
		);
		const cells = values.map((v) => metric.format(v));
		lines.push(`| ${metric.label} | ${cells.join(" | ")} |`);
	}

	lines.push("");

	// Individual report links
	lines.push("## Individual Reports");
	lines.push("");
	for (const r of results) {
		if (r.success && r.reportPath) {
			lines.push(`- **${r.name}**: [${r.reportPath}](${r.reportPath})`);
		} else {
			lines.push(`- **${r.name}**: ❌ ${r.error ?? "failed"}`);
		}
	}

	lines.push("");
	return lines.join("\n");
}

function formatComparisonJson(
	results: StrategyResult[],
): Record<string, unknown> {
	const successful = results.filter((r) => r.success && r.json);
	return {
		generatedAt: new Date().toISOString(),
		strategies: successful.map((r) => ({
			name: r.name,
			reportPath: r.reportPath,
			...r.json,
		})),
		failed: results
			.filter((r) => !r.success)
			.map((r) => ({ name: r.name, error: r.error })),
	};
}

// ── Main ──

const opts = parseArgs(process.argv.slice(2));

console.log("");
console.log(`${BOLD}${CYAN}━━━ Strategy Comparison ━━━${RESET}`);
console.log("");

// Discover strategies
let strategies: string[];
if (opts.strategies) {
	strategies = opts.strategies;
} else {
	const all = await discoverBacktestableStrategies();
	// Skip copy-trade (event-driven, not backtestable)
	strategies = all.filter((s) => s !== "copy-trade");
}

console.log(`  Strategies: ${strategies.join(", ")}`);
if (opts.days) console.log(`  Period: ${opts.days} days`);
if (opts.initialTao) console.log(`  Initial: ${opts.initialTao} τ`);
console.log("");

// Run backtests sequentially (each already hits the DB/RPC)
const results: StrategyResult[] = [];
for (const strategy of strategies) {
	console.log(`${BOLD}▶ ${strategy}${RESET}`);
	const result = await runBacktest(strategy, opts);
	if (result.success) {
		console.log(`  ${GREEN}✓${RESET} Done → ${result.reportPath}`);
	} else {
		console.log(`  ${RED}✗${RESET} Failed: ${result.error}`);
	}
	results.push(result);
	console.log("");
}

// Output comparison
console.log(formatComparisonTable(results));

// Write reports
await mkdir("reports", { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const mdPath = join("reports", `comparison-${ts}.md`);
const jsonPath = join("reports", `comparison-${ts}.json`);

await writeFile(mdPath, formatComparisonMarkdown(results));
await writeFile(
	jsonPath,
	JSON.stringify(formatComparisonJson(results), null, 2),
);

console.log(`  📄 Markdown: ${mdPath}`);
console.log(`  📊 JSON: ${jsonPath}`);
console.log("");

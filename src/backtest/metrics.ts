/**
 * Pure backtest metrics computation.
 *
 * All functions take plain number arrays — no bigint, no domain types.
 * Designed to be fully testable and decoupled from the backtest simulation.
 *
 * Conventions:
 * - Crypto 24/7 markets: 365.25 trading days per year
 * - Risk-free rate defaults to 0 (no meaningful TAO risk-free rate)
 * - Daily returns aggregated from high-frequency equity samples via UTC midnight bucketing
 */

const TRADING_DAYS_PER_YEAR = 365.25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EquitySample {
	/** Unix timestamp in milliseconds */
	timestamp: number;
	/** Portfolio value (e.g. in TAO, floating point) */
	value: number;
}

export interface TradeResult {
	/** Realized PnL in absolute terms (e.g. TAO) */
	pnlAbsolute: number;
}

export interface BacktestMetrics {
	// -- Returns --
	totalReturnPct: number;
	cagr: number;
	annualizedVolatility: number;

	// -- Risk-adjusted --
	sharpeRatio: number | null;
	sortinoRatio: number | null;
	calmarRatio: number | null;
	omegaRatio: number | null;

	// -- Drawdown --
	maxDrawdownPct: number;
	maxDrawdownDurationDays: number;
	recoveryFactor: number | null;

	// -- Trade-level --
	winRate: number | null;
	profitFactor: number | null;
	expectancy: number | null;
	payoffRatio: number | null;

	// -- Tail risk --
	var95: number | null;
	cvar95: number | null;
	tailRatio: number | null;
	skewness: number | null;
	kurtosis: number | null;
}

// ---------------------------------------------------------------------------
// Daily return aggregation
// ---------------------------------------------------------------------------

/** Bucket high-frequency equity samples into end-of-day values (UTC midnight). */
export function toDailyValues(samples: EquitySample[]): EquitySample[] {
	if (samples.length === 0) return [];

	const buckets = new Map<string, EquitySample>();
	for (const s of samples) {
		const dayKey = new Date(s.timestamp).toISOString().slice(0, 10);
		buckets.set(dayKey, s);
	}

	return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Compute simple returns from a value series: r[i] = (v[i] - v[i-1]) / v[i-1] */
export function computeReturns(values: number[]): number[] {
	const returns: number[] = [];
	for (let i = 1; i < values.length; i++) {
		const prev = values[i - 1] as number;
		const curr = values[i] as number;
		returns.push(prev !== 0 ? (curr - prev) / prev : 0);
	}
	return returns;
}

// ---------------------------------------------------------------------------
// Statistical primitives
// ---------------------------------------------------------------------------

function mean(arr: number[]): number {
	if (arr.length === 0) return 0;
	let sum = 0;
	for (const v of arr) sum += v;
	return sum / arr.length;
}

function variance(arr: number[], avg?: number): number {
	if (arr.length < 2) return 0;
	const m = avg ?? mean(arr);
	let sumSq = 0;
	for (const v of arr) sumSq += (v - m) ** 2;
	return sumSq / (arr.length - 1);
}

function stddev(arr: number[], avg?: number): number {
	return Math.sqrt(variance(arr, avg));
}

function downsideDeviation(returns: number[], threshold = 0): number {
	const downside = returns.filter((r) => r < threshold);
	if (downside.length < 2) return 0;
	let sumSq = 0;
	for (const r of downside) sumSq += (r - threshold) ** 2;
	return Math.sqrt(sumSq / (returns.length - 1));
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo] as number;
	const frac = idx - lo;
	return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}

// ---------------------------------------------------------------------------
// Individual metric functions (exported for testing)
// ---------------------------------------------------------------------------

export function totalReturn(initial: number, final: number): number {
	if (initial === 0) return 0;
	return ((final - initial) / initial) * 100;
}

export function cagr(
	initial: number,
	final: number,
	durationDays: number,
): number {
	if (initial <= 0 || final <= 0 || durationDays <= 0) return 0;
	return ((final / initial) ** (365.25 / durationDays) - 1) * 100;
}

export function annualizedVolatility(dailyReturns: number[]): number {
	if (dailyReturns.length < 2) return 0;
	return stddev(dailyReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

export function sharpeRatio(
	dailyReturns: number[],
	riskFreeDaily = 0,
): number | null {
	if (dailyReturns.length < 2) return null;
	const m = mean(dailyReturns) - riskFreeDaily;
	const s = stddev(dailyReturns);
	if (s === 0) return null;
	return (m / s) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

export function sortinoRatio(
	dailyReturns: number[],
	riskFreeDaily = 0,
): number | null {
	if (dailyReturns.length < 2) return null;
	const m = mean(dailyReturns) - riskFreeDaily;
	const dd = downsideDeviation(dailyReturns, riskFreeDaily);
	if (dd === 0) return null;
	return (m / dd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

export function calmarRatio(cagrPct: number, maxDDPct: number): number | null {
	if (maxDDPct === 0) return null;
	return cagrPct / Math.abs(maxDDPct);
}

export function omegaRatio(
	dailyReturns: number[],
	threshold = 0,
): number | null {
	if (dailyReturns.length === 0) return null;
	let gains = 0;
	let losses = 0;
	for (const r of dailyReturns) {
		if (r > threshold) gains += r - threshold;
		else losses += threshold - r;
	}
	if (losses === 0) return gains > 0 ? Infinity : null;
	return gains / losses;
}

// ---------------------------------------------------------------------------
// Drawdown
// ---------------------------------------------------------------------------

export interface DrawdownResult {
	maxDrawdownPct: number;
	maxDrawdownDurationDays: number;
}

export function computeDrawdown(equity: EquitySample[]): DrawdownResult {
	if (equity.length < 2)
		return { maxDrawdownPct: 0, maxDrawdownDurationDays: 0 };

	const first = equity[0] as EquitySample;
	let peak = first.value;
	let maxDD = 0;
	let maxDDDurationMs = 0;
	let currentDDStartMs = first.timestamp;

	for (const sample of equity) {
		if (sample.value >= peak) {
			const ddDuration = sample.timestamp - currentDDStartMs;
			if (maxDD > 0 && ddDuration > maxDDDurationMs) {
				maxDDDurationMs = ddDuration;
			}
			peak = sample.value;
			currentDDStartMs = sample.timestamp;
		} else {
			const dd = peak > 0 ? ((peak - sample.value) / peak) * 100 : 0;
			if (dd > maxDD) {
				maxDD = dd;
			}
		}
	}

	// If we end in a drawdown, record its duration
	if (maxDD > 0) {
		const lastSample = equity[equity.length - 1] as EquitySample;
		const trailingDuration = lastSample.timestamp - currentDDStartMs;
		if (trailingDuration > maxDDDurationMs) {
			maxDDDurationMs = trailingDuration;
		}
	}

	return {
		maxDrawdownPct: maxDD,
		maxDrawdownDurationDays: maxDDDurationMs / (86_400 * 1000),
	};
}

export function recoveryFactor(
	netProfitPct: number,
	maxDDPct: number,
): number | null {
	if (maxDDPct === 0) return null;
	return netProfitPct / Math.abs(maxDDPct);
}

// ---------------------------------------------------------------------------
// Trade-level metrics
// ---------------------------------------------------------------------------

export function winRate(trades: TradeResult[]): number | null {
	if (trades.length === 0) return null;
	const wins = trades.filter((t) => t.pnlAbsolute > 0).length;
	return (wins / trades.length) * 100;
}

export function profitFactor(trades: TradeResult[]): number | null {
	if (trades.length === 0) return null;
	let grossProfit = 0;
	let grossLoss = 0;
	for (const t of trades) {
		if (t.pnlAbsolute > 0) grossProfit += t.pnlAbsolute;
		else grossLoss += Math.abs(t.pnlAbsolute);
	}
	if (grossLoss === 0) return grossProfit > 0 ? Infinity : null;
	return grossProfit / grossLoss;
}

export function expectancy(trades: TradeResult[]): number | null {
	if (trades.length === 0) return null;
	let total = 0;
	for (const t of trades) total += t.pnlAbsolute;
	return total / trades.length;
}

export function payoffRatio(trades: TradeResult[]): number | null {
	const wins = trades.filter((t) => t.pnlAbsolute > 0);
	const losses = trades.filter((t) => t.pnlAbsolute < 0);
	if (wins.length === 0 || losses.length === 0) return null;
	const avgWin = mean(wins.map((t) => t.pnlAbsolute));
	const avgLoss = mean(losses.map((t) => Math.abs(t.pnlAbsolute)));
	if (avgLoss === 0) return null;
	return avgWin / avgLoss;
}

// ---------------------------------------------------------------------------
// Tail risk
// ---------------------------------------------------------------------------

export function valueAtRisk(
	dailyReturns: number[],
	confidence = 0.95,
): number | null {
	if (dailyReturns.length < 5) return null;
	const sorted = [...dailyReturns].sort((a, b) => a - b);
	return percentile(sorted, (1 - confidence) * 100) * 100;
}

export function conditionalVaR(
	dailyReturns: number[],
	confidence = 0.95,
): number | null {
	if (dailyReturns.length < 5) return null;
	const sorted = [...dailyReturns].sort((a, b) => a - b);
	const varThreshold = percentile(sorted, (1 - confidence) * 100);
	const tail = sorted.filter((r) => r <= varThreshold);
	if (tail.length === 0) return null;
	return mean(tail) * 100;
}

export function tailRatio(
	dailyReturns: number[],
	cutoff = 0.95,
): number | null {
	if (dailyReturns.length < 5) return null;
	const sorted = [...dailyReturns].sort((a, b) => a - b);
	const upper = percentile(sorted, cutoff * 100);
	const lower = Math.abs(percentile(sorted, (1 - cutoff) * 100));
	if (lower === 0) return upper > 0 ? Infinity : null;
	return upper / lower;
}

export function skewness(dailyReturns: number[]): number | null {
	if (dailyReturns.length < 3) return null;
	const n = dailyReturns.length;
	const m = mean(dailyReturns);
	const s = stddev(dailyReturns, m);
	if (s === 0) return null;
	let sum = 0;
	for (const r of dailyReturns) sum += ((r - m) / s) ** 3;
	return (n / ((n - 1) * (n - 2))) * sum;
}

export function kurtosis(dailyReturns: number[]): number | null {
	if (dailyReturns.length < 4) return null;
	const n = dailyReturns.length;
	const m = mean(dailyReturns);
	const s = stddev(dailyReturns, m);
	if (s === 0) return null;
	let sum = 0;
	for (const r of dailyReturns) sum += ((r - m) / s) ** 4;
	const raw =
		((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum -
		(3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
	return raw;
}

// ---------------------------------------------------------------------------
// Master computation
// ---------------------------------------------------------------------------

export function computeMetrics(
	equityCurve: EquitySample[],
	trades: TradeResult[],
): BacktestMetrics {
	const initial =
		equityCurve.length > 0 ? (equityCurve[0] as EquitySample).value : 0;
	const final =
		equityCurve.length > 0
			? (equityCurve[equityCurve.length - 1] as EquitySample).value
			: 0;
	const durationMs =
		equityCurve.length >= 2
			? (equityCurve[equityCurve.length - 1] as EquitySample).timestamp -
				(equityCurve[0] as EquitySample).timestamp
			: 0;
	const durationDays = durationMs / (86_400 * 1000);

	const dailySamples = toDailyValues(equityCurve);
	const dailyValues = dailySamples.map((s) => s.value);
	const dailyReturns = computeReturns(dailyValues);

	const totalRetPct = totalReturn(initial, final);
	const cagrPct = cagr(initial, final, durationDays);
	const dd = computeDrawdown(equityCurve);

	return {
		totalReturnPct: totalRetPct,
		cagr: cagrPct,
		annualizedVolatility: annualizedVolatility(dailyReturns),

		sharpeRatio: sharpeRatio(dailyReturns),
		sortinoRatio: sortinoRatio(dailyReturns),
		calmarRatio: calmarRatio(cagrPct, dd.maxDrawdownPct),
		omegaRatio: omegaRatio(dailyReturns),

		maxDrawdownPct: dd.maxDrawdownPct,
		maxDrawdownDurationDays: dd.maxDrawdownDurationDays,
		recoveryFactor: recoveryFactor(totalRetPct, dd.maxDrawdownPct),

		winRate: winRate(trades),
		profitFactor: profitFactor(trades),
		expectancy: expectancy(trades),
		payoffRatio: payoffRatio(trades),

		var95: valueAtRisk(dailyReturns),
		cvar95: conditionalVaR(dailyReturns),
		tailRatio: tailRatio(dailyReturns),
		skewness: skewness(dailyReturns),
		kurtosis: kurtosis(dailyReturns),
	};
}

// ---------------------------------------------------------------------------
// Formatting helpers (for terminal output)
// ---------------------------------------------------------------------------

function fmtPct(v: number | null, decimals = 2): string {
	if (v === null) return "N/A";
	const sign = v >= 0 ? "+" : "";
	return `${sign}${v.toFixed(decimals)}%`;
}

function fmtRatio(v: number | null, decimals = 2): string {
	if (v === null) return "N/A";
	if (v === Infinity) return "∞";
	if (v === -Infinity) return "-∞";
	return v.toFixed(decimals);
}

function fmtNum(v: number | null, decimals = 4): string {
	if (v === null) return "N/A";
	const sign = v >= 0 ? "+" : "";
	return `${sign}${v.toFixed(decimals)}`;
}

export function formatMetricsSummary(
	m: BacktestMetrics,
	extra: {
		strategyName: string;
		scheduleLabel: string;
		durationDays: number;
		rebalanceCount: number;
		totalTrades: number;
		totalFeesTao: string;
		initialTao: string;
		finalTao: string;
		pnlTao: string;
		pnlPct: number;
		tradePnlTao: string;
		emissionPnlTao: string;
		hodlReturnPct?: number;
		hodlCagr?: number;
	},
): string {
	const sep = "═".repeat(60);
	const lines: string[] = [];

	lines.push("");
	lines.push(sep);
	lines.push("  BACKTEST RESULTS (AMM-simulated, with emission accrual)");
	lines.push(sep);
	lines.push(`  Strategy:          ${extra.strategyName}`);
	lines.push(
		`  Period:            ${extra.durationDays.toFixed(1)} days  |  Rebalances: ${extra.rebalanceCount}`,
	);
	lines.push(
		`  Total trades:      ${extra.totalTrades}        |  Total fees: ${extra.totalFeesTao} τ`,
	);
	lines.push(`  Schedule:          ${extra.scheduleLabel}`);

	lines.push("");
	lines.push("  ── Returns ──");
	lines.push(`  Total Return:      ${fmtPct(m.totalReturnPct)}`);
	lines.push(`  CAGR:              ${fmtPct(m.cagr)}`);
	lines.push(`  Ann. Volatility:   ${fmtPct(m.annualizedVolatility)}`);
	if (extra.hodlReturnPct !== undefined) {
		lines.push(`  HODL (SN0):        ${fmtPct(extra.hodlReturnPct)}`);
		lines.push(
			`  Excess Return:     ${fmtPct(m.totalReturnPct - extra.hodlReturnPct)}`,
		);
	}
	if (extra.hodlCagr !== undefined) {
		lines.push(`  HODL CAGR:         ${fmtPct(extra.hodlCagr)}`);
	}

	lines.push("");
	lines.push("  ── Risk-Adjusted ──");
	lines.push(`  Sharpe Ratio:      ${fmtRatio(m.sharpeRatio)}`);
	lines.push(`  Sortino Ratio:     ${fmtRatio(m.sortinoRatio)}`);
	lines.push(`  Calmar Ratio:      ${fmtRatio(m.calmarRatio)}`);
	lines.push(`  Omega Ratio:       ${fmtRatio(m.omegaRatio)}`);

	lines.push("");
	lines.push("  ── Drawdown ──");
	lines.push(`  Max Drawdown:      ${fmtPct(-m.maxDrawdownPct)}`);
	lines.push(
		`  Max DD Duration:   ${m.maxDrawdownDurationDays.toFixed(1)} days`,
	);
	lines.push(`  Recovery Factor:   ${fmtRatio(m.recoveryFactor)}`);

	lines.push("");
	lines.push("  ── Trades ──");
	lines.push(
		`  Win Rate:          ${m.winRate !== null ? `${m.winRate.toFixed(1)}%` : "N/A"}`,
	);
	lines.push(`  Profit Factor:     ${fmtRatio(m.profitFactor)}`);
	lines.push(
		`  Expectancy:        ${m.expectancy !== null ? `${fmtNum(m.expectancy)} τ/trade` : "N/A"}`,
	);
	lines.push(`  Payoff Ratio:      ${fmtRatio(m.payoffRatio)}`);

	lines.push("");
	lines.push("  ── Tail Risk (daily) ──");
	lines.push(`  VaR (95%):         ${fmtPct(m.var95)}`);
	lines.push(`  CVaR (95%):        ${fmtPct(m.cvar95)}`);
	lines.push(`  Tail Ratio:        ${fmtRatio(m.tailRatio)}`);
	lines.push(`  Skewness:          ${fmtRatio(m.skewness)}`);
	lines.push(`  Kurtosis:          ${fmtRatio(m.kurtosis)}`);

	lines.push("");
	lines.push("  ── PnL Decomposition ──");
	lines.push(`  Initial value:     ${extra.initialTao} τ`);
	lines.push(`  Final value:       ${extra.finalTao} τ`);
	lines.push(
		`  PnL:               ${extra.pnlTao} τ (${fmtPct(extra.pnlPct)})`,
	);
	lines.push(`    Trade PnL:       ${extra.tradePnlTao} τ`);
	lines.push(`    Emission PnL:    ${extra.emissionPnlTao} τ (estimated)`);
	lines.push(sep);
	lines.push("");

	return lines.join("\n");
}

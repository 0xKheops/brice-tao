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
	informationRatio: number | null;
	alpha: number | null;
	beta: number | null;
	rSquared: number | null;

	// -- Drawdown --
	maxDrawdownPct: number;
	maxDrawdownDurationDays: number;
	recoveryFactor: number | null;

	// -- Trade-level --
	winRate: number | null;
	profitFactor: number | null;
	expectancy: number | null;
	payoffRatio: number | null;
	maxConsecWins: number | null;
	maxConsecLosses: number | null;

	// -- Tail risk --
	var95: number | null;
	cvar95: number | null;
	tailRatio: number | null;
	skewness: number | null;
	kurtosis: number | null;

	// -- Rolling (time-varying) --
	rollingSharpe: RollingMetric[] | null;
	drawdownTimeseries: DrawdownSample[] | null;
}

export interface RollingMetric {
	timestamp: number;
	value: number;
}

export interface DrawdownSample {
	timestamp: number;
	drawdownPct: number;
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
// Consecutive streaks
// ---------------------------------------------------------------------------

export function maxConsecutiveWins(trades: TradeResult[]): number | null {
	if (trades.length === 0) return null;
	let max = 0;
	let current = 0;
	for (const t of trades) {
		if (t.pnlAbsolute > 0) {
			current++;
			if (current > max) max = current;
		} else {
			current = 0;
		}
	}
	return max;
}

export function maxConsecutiveLosses(trades: TradeResult[]): number | null {
	if (trades.length === 0) return null;
	let max = 0;
	let current = 0;
	for (const t of trades) {
		if (t.pnlAbsolute < 0) {
			current++;
			if (current > max) max = current;
		} else {
			current = 0;
		}
	}
	return max;
}

// ---------------------------------------------------------------------------
// Information Ratio
// ---------------------------------------------------------------------------

export function informationRatio(
	strategyReturns: number[],
	benchmarkReturns: number[],
): number | null {
	const len = Math.min(strategyReturns.length, benchmarkReturns.length);
	if (len < 2) return null;
	const activeReturns: number[] = [];
	for (let i = 0; i < len; i++) {
		activeReturns.push(
			(strategyReturns[i] as number) - (benchmarkReturns[i] as number),
		);
	}
	const m = mean(activeReturns);
	const s = stddev(activeReturns, m);
	if (s === 0) return null;
	return (m / s) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

// ---------------------------------------------------------------------------
// CAPM regression (Alpha, Beta, R²)
// ---------------------------------------------------------------------------

export interface CAPMResult {
	alpha: number;
	beta: number;
	rSquared: number;
}

export function capmRegression(
	strategyReturns: number[],
	benchmarkReturns: number[],
): CAPMResult | null {
	const len = Math.min(strategyReturns.length, benchmarkReturns.length);
	if (len < 3) return null;

	const mx = mean(benchmarkReturns.slice(0, len));
	const my = mean(strategyReturns.slice(0, len));

	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	for (let i = 0; i < len; i++) {
		const dx = (benchmarkReturns[i] as number) - mx;
		const dy = (strategyReturns[i] as number) - my;
		sxx += dx * dx;
		sxy += dx * dy;
		syy += dy * dy;
	}

	if (sxx === 0) return null;

	const beta = sxy / sxx;
	// Annualized alpha: daily alpha × trading days
	const dailyAlpha = my - beta * mx;
	const alpha = dailyAlpha * TRADING_DAYS_PER_YEAR * 100;
	const rSquared = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;

	return { alpha, beta, rSquared };
}

// ---------------------------------------------------------------------------
// Rolling metrics (Sharpe, drawdown timeseries)
// ---------------------------------------------------------------------------

export function computeRollingSharpe(
	equity: EquitySample[],
	windowDays = 30,
): RollingMetric[] | null {
	const daily = toDailyValues(equity);
	if (daily.length < windowDays + 1) return null;

	const dailyValues = daily.map((s) => s.value);
	const dailyReturns = computeReturns(dailyValues);
	const results: RollingMetric[] = [];

	for (let i = windowDays - 1; i < dailyReturns.length; i++) {
		const window = dailyReturns.slice(i - windowDays + 1, i + 1);
		const sr = sharpeRatio(window);
		if (sr !== null) {
			results.push({
				timestamp: (daily[i + 1] as EquitySample).timestamp,
				value: sr,
			});
		}
	}

	return results.length > 0 ? results : null;
}

export function computeDrawdownTimeseries(
	equity: EquitySample[],
): DrawdownSample[] | null {
	if (equity.length < 2) return null;

	let peak = (equity[0] as EquitySample).value;
	const results: DrawdownSample[] = [];

	for (const sample of equity) {
		if (sample.value > peak) peak = sample.value;
		const dd = peak > 0 ? ((peak - sample.value) / peak) * 100 : 0;
		results.push({ timestamp: sample.timestamp, drawdownPct: dd });
	}

	return results;
}

/** Compute summary stats from a rolling metric series: min, median, max */
export function rollingSummary(
	series: RollingMetric[] | null,
): { min: number; median: number; max: number } | null {
	if (!series || series.length === 0) return null;
	const values = series.map((s) => s.value).sort((a, b) => a - b);
	return {
		min: values[0] as number,
		median: percentile(values, 50),
		max: values[values.length - 1] as number,
	};
}

// ---------------------------------------------------------------------------
// Master computation
// ---------------------------------------------------------------------------

export function computeMetrics(
	equityCurve: EquitySample[],
	trades: TradeResult[],
	benchmarkEquity?: EquitySample[],
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

	// Benchmark-relative metrics
	let ir: number | null = null;
	let capm: CAPMResult | null = null;
	if (benchmarkEquity && benchmarkEquity.length >= 2) {
		const benchDaily = toDailyValues(benchmarkEquity);
		const benchReturns = computeReturns(benchDaily.map((s) => s.value));
		ir = informationRatio(dailyReturns, benchReturns);
		capm = capmRegression(dailyReturns, benchReturns);
	}

	return {
		totalReturnPct: totalRetPct,
		cagr: cagrPct,
		annualizedVolatility: annualizedVolatility(dailyReturns),

		sharpeRatio: sharpeRatio(dailyReturns),
		sortinoRatio: sortinoRatio(dailyReturns),
		calmarRatio: calmarRatio(cagrPct, dd.maxDrawdownPct),
		omegaRatio: omegaRatio(dailyReturns),
		informationRatio: ir,
		alpha: capm?.alpha ?? null,
		beta: capm?.beta ?? null,
		rSquared: capm?.rSquared ?? null,

		maxDrawdownPct: dd.maxDrawdownPct,
		maxDrawdownDurationDays: dd.maxDrawdownDurationDays,
		recoveryFactor: recoveryFactor(totalRetPct, dd.maxDrawdownPct),

		winRate: winRate(trades),
		profitFactor: profitFactor(trades),
		expectancy: expectancy(trades),
		payoffRatio: payoffRatio(trades),
		maxConsecWins: maxConsecutiveWins(trades),
		maxConsecLosses: maxConsecutiveLosses(trades),

		var95: valueAtRisk(dailyReturns),
		cvar95: conditionalVaR(dailyReturns),
		tailRatio: tailRatio(dailyReturns),
		skewness: skewness(dailyReturns),
		kurtosis: kurtosis(dailyReturns),

		rollingSharpe: computeRollingSharpe(equityCurve),
		drawdownTimeseries: computeDrawdownTimeseries(equityCurve),
	};
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

import {
	type AnsiColors,
	createColors,
	renderEquityChart,
	renderUnderwaterChart,
} from "./chart.ts";

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

/** Colorize a percentage value: green if good, red if bad */
function colorPct(
	v: number | null,
	higherIsBetter: boolean,
	c: AnsiColors,
	decimals = 2,
): string {
	const str = fmtPct(v, decimals);
	if (v === null) return `${c.dim}${str}${c.reset}`;
	const good = higherIsBetter ? v >= 0 : v <= 0;
	return good ? `${c.green}${str}${c.reset}` : `${c.red}${str}${c.reset}`;
}

/** Colorize a ratio value: green if above threshold, red if below */
function colorRatio(
	v: number | null,
	threshold: number,
	c: AnsiColors,
	decimals = 2,
): string {
	const str = fmtRatio(v, decimals);
	if (v === null || v === Infinity || v === -Infinity)
		return `${c.dim}${str}${c.reset}`;
	return v >= threshold
		? `${c.green}${str}${c.reset}`
		: `${c.red}${str}${c.reset}`;
}

// ---------------------------------------------------------------------------
// ANSI-aware padding — invisible escape sequences don't count toward width
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(s: string): number {
	return s.replace(ANSI_RE, "").length;
}

function padStartVisible(s: string, width: number): string {
	const pad = width - visibleLength(s);
	return pad > 0 ? " ".repeat(pad) + s : s;
}

// ---------------------------------------------------------------------------
// Metric descriptors — single source of truth for labels + explanations
// ---------------------------------------------------------------------------

interface MetricRow {
	label: string;
	value: string;
	hint: string;
}

function buildMetricRows(
	m: BacktestMetrics,
	c: AnsiColors,
	durationDays: number,
): {
	performance: MetricRow[];
	risk: MetricRow[];
	trades: MetricRow[];
	tail: MetricRow[];
} {
	const shortPeriodWarning =
		durationDays < 90 ? ` (from ${durationDays.toFixed(0)}d)` : "";

	return {
		performance: [
			{
				label: "Total Return",
				value: colorPct(m.totalReturnPct, true, c),
				hint: "Overall gain or loss over the full period",
			},
			{
				label: "CAGR",
				value: colorPct(m.cagr, true, c),
				hint: `Compound Annual Growth Rate${shortPeriodWarning}`,
			},
			{
				label: "Ann. Volatility",
				value: colorPct(m.annualizedVolatility, false, c),
				hint: "How much the portfolio value swings day-to-day",
			},
		],
		risk: [
			{
				label: "Sharpe Ratio",
				value: colorRatio(m.sharpeRatio, 1.0, c),
				hint: "Return per unit of total risk (>1 is good)",
			},
			{
				label: "Sortino Ratio",
				value: colorRatio(m.sortinoRatio, 1.0, c),
				hint: "Like Sharpe but only penalizes downside moves",
			},
			{
				label: "Calmar Ratio",
				value: colorRatio(m.calmarRatio, 1.0, c),
				hint: "CAGR divided by worst drawdown",
			},
			{
				label: "Omega Ratio",
				value: colorRatio(m.omegaRatio, 1.0, c),
				hint: "Probability-weighted gains vs losses (>1 = net gain)",
			},
			{
				label: "Info Ratio",
				value: colorRatio(m.informationRatio, 0.5, c),
				hint: "Excess return per unit of tracking error vs HODL",
			},
			{
				label: "Alpha (ann.)",
				value: colorPct(m.alpha, true, c),
				hint: "CAPM alpha — excess return above benchmark beta",
			},
			{
				label: "Beta",
				value: fmtRatio(m.beta),
				hint: "Sensitivity to benchmark moves (<1 = defensive)",
			},
			{
				label: "R²",
				value:
					m.rSquared !== null
						? `${(m.rSquared * 100).toFixed(1)}%`
						: `${c.dim}N/A${c.reset}`,
				hint: "% of return variance explained by benchmark",
			},
			{
				label: "Max Drawdown",
				value: colorPct(-m.maxDrawdownPct, true, c),
				hint: "Worst peak-to-valley decline",
			},
			{
				label: "DD Duration",
				value: `${m.maxDrawdownDurationDays.toFixed(1)} days`,
				hint: "Longest time spent below a previous high",
			},
			{
				label: "Recovery Factor",
				value: fmtRatio(m.recoveryFactor),
				hint: "Total return / max drawdown (how well it recovers)",
			},
		],
		trades: [
			{
				label: "Win Rate",
				value:
					m.winRate !== null
						? `${m.winRate.toFixed(1)}%`
						: `${c.dim}N/A${c.reset}`,
				hint: "% of closed trades that were profitable",
			},
			{
				label: "Profit Factor",
				value: colorRatio(m.profitFactor, 1.0, c),
				hint: "Gross profit / gross loss (>1 means net profit)",
			},
			{
				label: "Expectancy",
				value:
					m.expectancy !== null
						? `${fmtNum(m.expectancy)} τ`
						: `${c.dim}N/A${c.reset}`,
				hint: "Average profit/loss per closed trade",
			},
			{
				label: "Payoff Ratio",
				value: fmtRatio(m.payoffRatio),
				hint: "Avg winning trade / avg losing trade",
			},
			{
				label: "Max Consec Wins",
				value:
					m.maxConsecWins !== null
						? `${m.maxConsecWins}`
						: `${c.dim}N/A${c.reset}`,
				hint: "Longest winning streak",
			},
			{
				label: "Max Consec Losses",
				value:
					m.maxConsecLosses !== null
						? `${m.maxConsecLosses}`
						: `${c.dim}N/A${c.reset}`,
				hint: "Longest losing streak",
			},
		],
		tail: [
			{
				label: "VaR (95%)",
				value: colorPct(m.var95, true, c),
				hint: "Worst expected daily loss 19 out of 20 days",
			},
			{
				label: "CVaR (95%)",
				value: colorPct(m.cvar95, true, c),
				hint: "Average loss on the worst 5% of days",
			},
			{
				label: "Tail Ratio",
				value: fmtRatio(m.tailRatio),
				hint: "Right-tail gains / left-tail losses (>1 = positive skew)",
			},
			{
				label: "Skewness",
				value: fmtRatio(m.skewness),
				hint: "Return distribution tilt (negative = more crash risk)",
			},
			{
				label: "Kurtosis",
				value: fmtRatio(m.kurtosis),
				hint: "Tail heaviness (>0 = more extreme moves than normal)",
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Extra parameters for formatters
// ---------------------------------------------------------------------------

export interface MetricsExtra {
	strategyName: string;
	durationDays: number;
	cycleCount: number;
	tradeLegCount: number;
	closedTradeCount: number;
	totalFeesTao: string;
	initialTao: string;
	finalTao: string;
	pnlTao: string;
	pnlPct: number;
	tradePnlTao: string;
	emissionPnlTao: string;
	hodlReturnPct?: number;
	hodlCagr?: number;
	equityCurve?: EquitySample[];
	hodlEquityCurve?: EquitySample[];
	/** Portfolio turnover ratio (annual) */
	turnoverRatio?: number;
	/** Cost drag as % of initial portfolio value */
	costDragPct?: number;
	/** Code context — helps AI match reports to source */
	gitCommit?: string;
	gitBranch?: string;
	strategyConfigPath?: string;
	schedule?: string;
	blockRange?: { first: number; last: number; snapshots: number };
}

// ---------------------------------------------------------------------------
// Terminal summary (colorized, with chart and explanations)
// ---------------------------------------------------------------------------

export function formatMetricsSummary(
	m: BacktestMetrics,
	extra: MetricsExtra,
): string {
	const c = createColors();
	const rows = buildMetricRows(m, c, extra.durationDays);
	const W = 70; // total width for box/sections
	const lines: string[] = [];

	// ── Header box ──
	const headerLine1 = `  📈 BACKTEST — ${extra.strategyName}`;
	const headerLine2 = `  ${extra.durationDays.toFixed(1)} days · ${extra.cycleCount} cycles · ${extra.tradeLegCount} trade legs · ${extra.closedTradeCount} closed trades · fees: ${extra.totalFeesTao} τ`;
	const boxW = Math.max(W, headerLine1.length + 4, headerLine2.length + 4);
	lines.push("");
	lines.push(`${c.dim}╔${"═".repeat(boxW)}╗${c.reset}`);
	lines.push(
		`${c.dim}║${c.reset}${c.bold}${headerLine1}${c.reset}${" ".repeat(Math.max(0, boxW - headerLine1.length))}${c.dim}║${c.reset}`,
	);
	lines.push(
		`${c.dim}║${c.reset}${headerLine2}${" ".repeat(Math.max(0, boxW - headerLine2.length))}${c.dim}║${c.reset}`,
	);
	lines.push(`${c.dim}╚${"═".repeat(boxW)}╝${c.reset}`);

	// ── Equity chart ──
	if (extra.equityCurve && extra.equityCurve.length >= 3) {
		lines.push("");
		const chart = renderEquityChart(extra.equityCurve, extra.hodlEquityCurve, {
			colors: c,
			width: 60,
			height: 15,
		});
		if (chart) lines.push(chart);
	}

	// ── Underwater chart ──
	if (m.drawdownTimeseries && m.drawdownTimeseries.length >= 3) {
		lines.push("");
		const underwater = renderUnderwaterChart(m.drawdownTimeseries, {
			colors: c,
			width: 60,
			height: 8,
		});
		if (underwater) lines.push(underwater);
	}

	// ── Verdict ──
	lines.push("");
	const verdictLines = buildVerdict(m, extra, c);
	for (const vl of verdictLines) lines.push(vl);

	// ── Metric sections ──
	const renderSection = (
		title: string,
		emoji: string,
		sectionRows: MetricRow[],
	) => {
		lines.push("");
		lines.push(
			`  ${c.dim}${emoji} ${title} ${"─".repeat(Math.max(0, W - title.length - 6))}${c.reset}`,
		);
		for (const row of sectionRows) {
			// Fixed-width columns: label (20) + value (16) + hint (rest)
			const labelStr = `  ${row.label}`.padEnd(22);
			const valueStr = padStartVisible(row.value, 16);
			const hintStr = `${c.dim}${row.hint}${c.reset}`;
			lines.push(`${labelStr}${valueStr}    ${hintStr}`);
		}
	};

	renderSection("Performance", "──", rows.performance);

	// Add HODL comparison rows if available
	if (extra.hodlReturnPct !== undefined) {
		const excessReturn = m.totalReturnPct - extra.hodlReturnPct;
		const hodlRows: MetricRow[] = [
			{
				label: "HODL (SN0)",
				value: colorPct(extra.hodlReturnPct, true, c),
				hint: "Benchmark: hold everything in SN0",
			},
			{
				label: "vs HODL",
				value: colorPct(excessReturn, true, c),
				hint: "Strategy return minus HODL return",
			},
		];
		if (extra.hodlCagr !== undefined) {
			hodlRows.push({
				label: "HODL CAGR",
				value: colorPct(extra.hodlCagr, true, c),
				hint: "HODL annualized return",
			});
		}
		for (const row of hodlRows) {
			const labelStr = `  ${row.label}`.padEnd(22);
			const valueStr = padStartVisible(row.value, 16);
			const hintStr = `${c.dim}${row.hint}${c.reset}`;
			lines.push(`${labelStr}${valueStr}    ${hintStr}`);
		}
	}

	renderSection("Risk", "──", rows.risk);
	renderSection("Trades", "──", rows.trades);
	renderSection("Tail Risk", "──", rows.tail);

	// ── Rolling Sharpe summary ──
	const rsSum = rollingSummary(m.rollingSharpe);
	if (rsSum) {
		lines.push("");
		lines.push(
			`  ${c.dim}── Rolling Sharpe (30d) ${"─".repeat(Math.max(0, W - 25))}${c.reset}`,
		);
		const minStr = colorRatio(rsSum.min, 0, c);
		const medStr = colorRatio(rsSum.median, 1.0, c);
		const maxStr = colorRatio(rsSum.max, 1.0, c);
		lines.push(`  Min ${minStr}    Median ${medStr}    Max ${maxStr}`);
	}

	// ── Turnover & cost drag ──
	if (extra.turnoverRatio !== undefined || extra.costDragPct !== undefined) {
		lines.push("");
		lines.push(
			`  ${c.dim}── Efficiency ${"─".repeat(Math.max(0, W - 16))}${c.reset}`,
		);
		if (extra.turnoverRatio !== undefined) {
			const labelStr = "  Turnover (ann.)".padEnd(22);
			const valueStr = padStartVisible(
				`${extra.turnoverRatio.toFixed(2)}×`,
				16,
			);
			lines.push(
				`${labelStr}${valueStr}    ${c.dim}Times portfolio traded per year${c.reset}`,
			);
		}
		if (extra.costDragPct !== undefined) {
			const labelStr = "  Cost Drag".padEnd(22);
			const valueStr = padStartVisible(
				colorPct(-extra.costDragPct, true, c),
				16,
			);
			lines.push(
				`${labelStr}${valueStr}    ${c.dim}Total fees as % of initial value${c.reset}`,
			);
		}
	}

	// ── PnL decomposition ──
	lines.push("");
	lines.push(
		`  ${c.dim}── PnL Breakdown ${"─".repeat(Math.max(0, W - 20))}${c.reset}`,
	);
	const arrow = `${extra.initialTao} τ → ${extra.finalTao} τ`;
	const pnlColor = extra.pnlPct >= 0 ? c.green : c.red;
	lines.push(
		`  ${arrow}  ${pnlColor}(${extra.pnlTao} τ, ${fmtPct(extra.pnlPct)})${c.reset}`,
	);
	lines.push(
		`    Trading:       ${extra.tradePnlTao} τ    ${c.dim}Buy/sell gains, losses, and fees${c.reset}`,
	);
	lines.push(
		`    Emissions:     ${extra.emissionPnlTao} τ    ${c.dim}Staking rewards accrued (estimated)${c.reset}`,
	);

	lines.push("");
	lines.push(`${c.dim}${"═".repeat(boxW + 2)}${c.reset}`);
	lines.push("");

	return lines.join("\n");
}

/** Build 1-2 verdict lines summarizing the key takeaway */
function buildVerdict(
	m: BacktestMetrics,
	extra: MetricsExtra,
	c: AnsiColors,
): string[] {
	const lines: string[] = [];

	if (extra.hodlReturnPct !== undefined) {
		const excess = m.totalReturnPct - extra.hodlReturnPct;
		const beat = excess >= 0;
		const icon = beat ? "🏆" : "📉";
		const verb = beat ? "Outperformed" : "Underperformed";
		const excessColor = beat ? c.green : c.red;

		lines.push(
			`${icon} ${c.bold}VERDICT${c.reset}: ${verb} SN0 HODL by ${excessColor}${Math.abs(excess).toFixed(2)}%${c.reset} (${colorPct(m.totalReturnPct, true, c)} vs ${fmtPct(extra.hodlReturnPct)})`,
		);
	} else {
		const icon = m.totalReturnPct >= 0 ? "🏆" : "📉";
		lines.push(
			`${icon} ${c.bold}VERDICT${c.reset}: Total return ${colorPct(m.totalReturnPct, true, c)}`,
		);
	}

	if (m.maxDrawdownPct > 0) {
		lines.push(
			`   Max drawdown ${colorPct(-m.maxDrawdownPct, true, c)} over ${m.maxDrawdownDurationDays.toFixed(1)} days`,
		);
	}

	return lines;
}

// ---------------------------------------------------------------------------
// Markdown report (with glossary and indicators)
// ---------------------------------------------------------------------------

export function formatMetricsMarkdown(
	m: BacktestMetrics,
	extra: MetricsExtra,
): string {
	const lines: string[] = [];

	// ── Key Takeaways ──
	lines.push("## Key Takeaways");
	lines.push("");
	const takeaways: string[] = [];

	if (extra.hodlReturnPct !== undefined) {
		const excess = m.totalReturnPct - extra.hodlReturnPct;
		const verb = excess >= 0 ? "outperformed" : "underperformed";
		const icon = excess >= 0 ? "✅" : "❌";
		takeaways.push(
			`${icon} Strategy ${verb} SN0 HODL by ${Math.abs(excess).toFixed(2)}% (${fmtPct(m.totalReturnPct)} vs ${fmtPct(extra.hodlReturnPct)})`,
		);
	}
	if (m.maxDrawdownPct > 0) {
		const ddIcon = m.maxDrawdownPct > 20 ? "⚠️" : "ℹ️";
		takeaways.push(
			`${ddIcon} Worst drawdown was ${fmtPct(-m.maxDrawdownPct)}, lasting ${m.maxDrawdownDurationDays.toFixed(1)} days`,
		);
	}
	if (m.winRate !== null) {
		const wrIcon = m.winRate >= 50 ? "✅" : "⚠️";
		takeaways.push(
			`${wrIcon} Won ${m.winRate.toFixed(0)}% of ${extra.closedTradeCount} closed trades${m.profitFactor !== null ? ` (profit factor: ${fmtRatio(m.profitFactor)})` : ""}`,
		);
	}
	if (extra.durationDays < 60) {
		takeaways.push(
			`⏳ Only ${extra.durationDays.toFixed(0)} days of data — annualized metrics (CAGR, Sharpe, etc.) should be treated as rough estimates`,
		);
	}
	for (const t of takeaways) lines.push(`- ${t}`);
	lines.push("");

	// ── Summary table ──
	lines.push("## Summary");
	lines.push("");
	lines.push("| Parameter | Value |");
	lines.push("| --- | --- |");
	lines.push(`| Strategy | ${extra.strategyName} |`);
	lines.push(`| Period | ${extra.durationDays.toFixed(1)} days |`);
	lines.push(`| Execution cycles | ${extra.cycleCount} |`);
	lines.push(`| Trade legs | ${extra.tradeLegCount} |`);
	lines.push(`| Closed trades | ${extra.closedTradeCount} |`);
	lines.push(`| Total fees | ${extra.totalFeesTao} τ |`);
	lines.push("");

	// ── Returns ──
	lines.push("## Returns");
	lines.push("");
	lines.push("| Metric | Value | |");
	lines.push("| --- | --- | --- |");
	lines.push(
		`| Total Return | ${fmtPct(m.totalReturnPct)} | ${indicator(m.totalReturnPct, 0, true)} |`,
	);
	lines.push(
		`| CAGR | ${fmtPct(m.cagr)} | ${indicator(m.cagr, 0, true)} Compound annual growth rate${extra.durationDays < 90 ? ` *(extrapolated from ${extra.durationDays.toFixed(0)}d)*` : ""} |`,
	);
	lines.push(
		`| Ann. Volatility | ${fmtPct(m.annualizedVolatility)} | Daily value swing, annualized |`,
	);
	if (extra.hodlReturnPct !== undefined) {
		lines.push(
			`| HODL (SN0) | ${fmtPct(extra.hodlReturnPct)} | Benchmark: hold 100% in SN0 |`,
		);
		const excess = m.totalReturnPct - extra.hodlReturnPct;
		lines.push(
			`| **Excess Return** | **${fmtPct(excess)}** | ${indicator(excess, 0, true)} Strategy minus HODL |`,
		);
	}
	if (extra.hodlCagr !== undefined) {
		lines.push(`| HODL CAGR | ${fmtPct(extra.hodlCagr)} | |`);
	}
	lines.push("");

	// ── Risk-Adjusted ──
	lines.push("## Risk-Adjusted Ratios");
	lines.push("");
	lines.push("| Metric | Value | |");
	lines.push("| --- | --- | --- |");
	lines.push(
		`| Sharpe Ratio | ${fmtRatio(m.sharpeRatio)} | ${indicator(m.sharpeRatio, 1, true)} Return per unit of risk |`,
	);
	lines.push(
		`| Sortino Ratio | ${fmtRatio(m.sortinoRatio)} | ${indicator(m.sortinoRatio, 1, true)} Sharpe using only downside volatility |`,
	);
	lines.push(
		`| Calmar Ratio | ${fmtRatio(m.calmarRatio)} | ${indicator(m.calmarRatio, 1, true)} CAGR / max drawdown |`,
	);
	lines.push(
		`| Omega Ratio | ${fmtRatio(m.omegaRatio)} | ${indicator(m.omegaRatio, 1, true)} Gain probability / loss probability |`,
	);
	lines.push(
		`| Info Ratio | ${fmtRatio(m.informationRatio)} | ${indicator(m.informationRatio, 0.5, true)} Excess return per tracking error vs HODL |`,
	);
	lines.push(
		`| Alpha (ann.) | ${fmtPct(m.alpha)} | ${indicator(m.alpha, 0, true)} CAPM excess return above benchmark beta |`,
	);
	lines.push(`| Beta | ${fmtRatio(m.beta)} | Sensitivity to benchmark moves |`);
	lines.push(
		`| R² | ${m.rSquared !== null ? `${(m.rSquared * 100).toFixed(1)}%` : "N/A"} | Variance explained by benchmark |`,
	);
	lines.push("");

	// ── Drawdown ──
	lines.push("## Drawdown");
	lines.push("");
	lines.push("| Metric | Value | |");
	lines.push("| --- | --- | --- |");
	lines.push(
		`| Max Drawdown | ${fmtPct(-m.maxDrawdownPct)} | Worst peak-to-valley decline |`,
	);
	lines.push(
		`| Max DD Duration | ${m.maxDrawdownDurationDays.toFixed(1)} days | Time from peak to recovery (or end) |`,
	);
	lines.push(
		`| Recovery Factor | ${fmtRatio(m.recoveryFactor)} | Total return / max drawdown |`,
	);
	lines.push("");

	// ── Trade Metrics ──
	lines.push("## Trade Metrics");
	lines.push("");
	lines.push("| Metric | Value | |");
	lines.push("| --- | --- | --- |");
	lines.push(
		`| Closed Trades | ${extra.closedTradeCount} | Realized sell exits used for win rate / expectancy |`,
	);
	lines.push(
		`| Trade Legs | ${extra.tradeLegCount} | Each BUY or SELL leg; one swap counts as 2 |`,
	);
	lines.push(
		`| Win Rate | ${m.winRate !== null ? `${m.winRate.toFixed(1)}%` : "N/A"} | ${indicator(m.winRate, 50, true)} % of closed trades in profit |`,
	);
	lines.push(
		`| Profit Factor | ${fmtRatio(m.profitFactor)} | ${indicator(m.profitFactor, 1, true)} Gross profit / gross loss |`,
	);
	lines.push(
		`| Expectancy | ${m.expectancy !== null ? `${fmtNum(m.expectancy)} τ/trade` : "N/A"} | Average profit per closed trade |`,
	);
	lines.push(
		`| Payoff Ratio | ${fmtRatio(m.payoffRatio)} | Avg win size / avg loss size |`,
	);
	lines.push(
		`| Max Consec Wins | ${m.maxConsecWins ?? "N/A"} | Longest winning streak |`,
	);
	lines.push(
		`| Max Consec Losses | ${m.maxConsecLosses ?? "N/A"} | Longest losing streak |`,
	);
	lines.push("");

	// ── Tail Risk ──
	lines.push("## Tail Risk (daily)");
	lines.push("");
	lines.push("| Metric | Value | |");
	lines.push("| --- | --- | --- |");
	lines.push(
		`| VaR (95%) | ${fmtPct(m.var95)} | Worst expected daily loss 19/20 days |`,
	);
	lines.push(
		`| CVaR (95%) | ${fmtPct(m.cvar95)} | Average loss on the worst 5% of days |`,
	);
	lines.push(
		`| Tail Ratio | ${fmtRatio(m.tailRatio)} | Upside tails / downside tails |`,
	);
	lines.push(`| Skewness | ${fmtRatio(m.skewness)} | Return tilt direction |`);
	lines.push(
		`| Kurtosis | ${fmtRatio(m.kurtosis)} | Tail heaviness vs normal distribution |`,
	);
	lines.push("");

	// ── Efficiency ──
	if (extra.turnoverRatio !== undefined || extra.costDragPct !== undefined) {
		lines.push("## Efficiency");
		lines.push("");
		lines.push("| Metric | Value | |");
		lines.push("| --- | --- | --- |");
		if (extra.turnoverRatio !== undefined) {
			lines.push(
				`| Turnover (ann.) | ${extra.turnoverRatio.toFixed(2)}× | Times portfolio traded per year |`,
			);
		}
		if (extra.costDragPct !== undefined) {
			lines.push(
				`| Cost Drag | ${fmtPct(-extra.costDragPct)} | Total fees as % of initial value |`,
			);
		}
		lines.push("");
	}

	// ── Rolling Sharpe ──
	const rsSummary = rollingSummary(m.rollingSharpe);
	if (rsSummary) {
		lines.push("## Rolling Sharpe (30-day window)");
		lines.push("");
		lines.push("| Stat | Value |");
		lines.push("| --- | --- |");
		lines.push(`| Min | ${fmtRatio(rsSummary.min)} |`);
		lines.push(`| Median | ${fmtRatio(rsSummary.median)} |`);
		lines.push(`| Max | ${fmtRatio(rsSummary.max)} |`);
		lines.push("");
	}

	// ── PnL Decomposition ──
	lines.push("## PnL Decomposition");
	lines.push("");
	lines.push("| | Value |");
	lines.push("| --- | --- |");
	lines.push(`| Initial value | ${extra.initialTao} τ |`);
	lines.push(`| Final value | ${extra.finalTao} τ |`);
	lines.push(`| PnL | ${extra.pnlTao} τ (${fmtPct(extra.pnlPct)}) |`);
	lines.push(`| Trade PnL | ${extra.tradePnlTao} τ |`);
	lines.push(`| Emission PnL | ${extra.emissionPnlTao} τ (estimated) |`);
	lines.push("");

	// ── Glossary ──
	lines.push("## Glossary");
	lines.push("");
	lines.push("| Term | Meaning |");
	lines.push("| --- | --- |");
	lines.push(
		"| **CAGR** | Compound Annual Growth Rate — the annualized return assuming steady compounding. On short backtests (<90 days), this extrapolates and can look extreme. |",
	);
	lines.push(
		"| **Sharpe Ratio** | Measures return per unit of total risk (volatility). >1 is considered good, >2 is excellent. Uses daily returns, annualized. |",
	);
	lines.push(
		"| **Sortino Ratio** | Like Sharpe but only counts downside volatility. More relevant when you care about losses, not all fluctuations. |",
	);
	lines.push(
		'| **Calmar Ratio** | CAGR divided by the worst drawdown. Answers: "How much growth per unit of worst-case pain?" >1 is decent. |',
	);
	lines.push(
		"| **Omega Ratio** | Ratio of probability-weighted gains to losses. >1 means gains outweigh losses overall. |",
	);
	lines.push(
		"| **Max Drawdown** | The largest peak-to-trough decline during the backtest. Shows the worst losing streak. |",
	);
	lines.push(
		"| **Recovery Factor** | Total return / max drawdown. Shows how well the strategy rebounds from its worst decline. |",
	);
	lines.push(
		"| **Win Rate** | Percentage of closed trades that made money. High win rate with tiny wins and big losses is still bad — check Payoff Ratio. |",
	);
	lines.push(
		"| **Trade Leg** | A single BUY or SELL side in the operations log. One swap contributes two trade legs: the sell side and the buy side. |",
	);
	lines.push(
		"| **Closed Trade** | A realized exit (sell) with measurable PnL. Win rate, profit factor, expectancy, and payoff ratio use closed trades, not trade legs. |",
	);
	lines.push(
		"| **Profit Factor** | Gross profits / gross losses. >1 means the strategy is net profitable on trades alone. |",
	);
	lines.push(
		"| **Expectancy** | Average τ gained (or lost) per closed trade. Combines win rate with average win/loss sizes. |",
	);
	lines.push(
		"| **Payoff Ratio** | Average winning trade / average losing trade. With 50% win rate, you need payoff >1 to profit. |",
	);
	lines.push(
		"| **VaR (95%)** | Value at Risk — the daily loss you'd expect to exceed only 5% of trading days (1 in 20). |",
	);
	lines.push(
		"| **CVaR (95%)** | Conditional VaR — average loss on the worst 5% of days. Shows how bad the bad days really are. |",
	);
	lines.push(
		"| **Tail Ratio** | Right tail (gains) / left tail (losses) at the 95th percentile. >1 = bigger upside surprises than downside. |",
	);
	lines.push(
		"| **Skewness** | Measures return distribution asymmetry. Negative = more downside crash risk; positive = more upside surprise potential. |",
	);
	lines.push(
		'| **Kurtosis** | Measures "fat tails" — how likely extreme moves are vs a normal distribution. >0 = more extremes than expected. |',
	);
	lines.push(
		"| **HODL (SN0)** | Benchmark: what you'd earn just holding all capital in SN0 (Bittensor root network, 1:1 TAO peg). |",
	);
	lines.push(
		"| **Emission PnL** | Staking rewards that would have accrued during the period. Estimated — real emissions depend on validator and network state. |",
	);
	lines.push(
		"| **Information Ratio** | Excess return over benchmark per unit of tracking error. Like Sharpe but relative to HODL. >0.5 is good, >1 is excellent. |",
	);
	lines.push(
		"| **Alpha** | CAPM alpha — the annualized return that can't be explained by benchmark exposure (beta). Positive alpha = genuine skill. |",
	);
	lines.push(
		"| **Beta** | Sensitivity to benchmark moves. β=1 means 1:1 tracking. β<1 = defensive, β>1 = amplified exposure. |",
	);
	lines.push(
		"| **R²** | Percentage of strategy return variance explained by the benchmark. High R² = benchmark-driven; low R² = independent returns. |",
	);
	lines.push(
		"| **Max Consec Wins/Losses** | Longest unbroken streak of winning or losing trades. Helps assess psychological and capital drawdown risk. |",
	);
	lines.push(
		"| **Turnover** | Annualized ratio of total traded volume to average portfolio value. Higher turnover = more trading activity and fee exposure. |",
	);
	lines.push(
		"| **Cost Drag** | Total fees paid as a percentage of initial portfolio value. Shows how much trading costs erode returns. |",
	);
	lines.push(
		"| **Rolling Sharpe** | Sharpe ratio computed over a rolling 30-day window. Shows how risk-adjusted performance evolves over time. |",
	);
	lines.push("");

	return lines.join("\n");
}

/**
 * Machine-readable JSON summary of all metrics + run parameters.
 * Wrapped in a fenced code block so AI tools can extract structured data
 * from the markdown report.
 */
export function formatMetricsJson(
	m: BacktestMetrics,
	extra: MetricsExtra,
): string {
	const data: Record<string, unknown> = {
		// Code context — lets AI match this report to the exact code that produced it
		source: {
			gitCommit: extra.gitCommit ?? null,
			gitBranch: extra.gitBranch ?? null,
			strategy: extra.strategyName,
			strategyConfigPath: extra.strategyConfigPath ?? null,
			strategySourceDir: `src/strategies/${extra.strategyName}/`,
			schedule: extra.schedule ?? null,
		},
		// Run parameters
		run: {
			generatedAt: new Date().toISOString(),
			durationDays: round(extra.durationDays, 1),
			blockRange: extra.blockRange ?? null,
			cycleCount: extra.cycleCount,
			tradeLegCount: extra.tradeLegCount,
			closedTradeCount: extra.closedTradeCount,
			rebalanceCount: extra.cycleCount,
			totalTrades: extra.tradeLegCount,
			initialTao: extra.initialTao,
			finalTao: extra.finalTao,
			pnlTao: extra.pnlTao,
			pnlPct: round(extra.pnlPct, 2),
			totalFeesTao: extra.totalFeesTao,
			tradePnlTao: extra.tradePnlTao,
			emissionPnlTao: extra.emissionPnlTao,
		},
		metrics: {
			totalReturnPct: round(m.totalReturnPct, 2),
			cagr: round(m.cagr, 2),
			annualizedVolatility: round(m.annualizedVolatility, 2),
			sharpeRatio: round(m.sharpeRatio, 4),
			sortinoRatio: round(m.sortinoRatio, 4),
			calmarRatio: round(m.calmarRatio, 4),
			omegaRatio: round(m.omegaRatio, 4),
			informationRatio: round(m.informationRatio, 4),
			alpha: round(m.alpha, 4),
			beta: round(m.beta, 4),
			rSquared: round(m.rSquared, 4),
			maxDrawdownPct: round(m.maxDrawdownPct, 2),
			maxDrawdownDurationDays: round(m.maxDrawdownDurationDays, 1),
			recoveryFactor: round(m.recoveryFactor, 4),
			winRate: m.winRate !== null ? round(m.winRate, 1) : null,
			profitFactor: m.profitFactor !== null ? round(m.profitFactor, 4) : null,
			expectancy: m.expectancy !== null ? round(m.expectancy, 6) : null,
			payoffRatio: m.payoffRatio !== null ? round(m.payoffRatio, 4) : null,
			maxConsecWins: m.maxConsecWins,
			maxConsecLosses: m.maxConsecLosses,
			var95: round(m.var95, 4),
			cvar95: round(m.cvar95, 4),
			tailRatio: round(m.tailRatio, 4),
			skewness: round(m.skewness, 4),
			kurtosis: round(m.kurtosis, 4),
			rollingSharpe: rollingSummary(m.rollingSharpe),
		},
		hodl:
			extra.hodlReturnPct !== undefined
				? {
						returnPct: round(extra.hodlReturnPct, 2),
						cagr:
							extra.hodlCagr !== undefined ? round(extra.hodlCagr, 2) : null,
					}
				: null,
		efficiency:
			extra.turnoverRatio !== undefined || extra.costDragPct !== undefined
				? {
						turnoverRatio:
							extra.turnoverRatio !== undefined
								? round(extra.turnoverRatio, 2)
								: null,
						costDragPct:
							extra.costDragPct !== undefined
								? round(extra.costDragPct, 4)
								: null,
					}
				: null,
	};

	return [
		"## Raw Metrics (JSON)",
		"",
		"```json",
		JSON.stringify(data, null, 2),
		"```",
	].join("\n");
}

function round(v: number | null, decimals: number): number | null {
	if (v === null) return null;
	const factor = 10 ** decimals;
	return Math.round(v * factor) / factor;
}

/** Returns a 🟢/🟡/🔴 indicator emoji based on whether value is above/at/below a threshold */
function indicator(
	v: number | null,
	threshold: number,
	higherIsBetter: boolean,
): string {
	if (v === null) return "⚪";
	if (higherIsBetter) {
		if (v > threshold * 1.2) return "🟢";
		if (v >= threshold * 0.8) return "🟡";
		return "🔴";
	}
	// lower is better
	if (v < threshold * 0.8) return "🟢";
	if (v <= threshold * 1.2) return "🟡";
	return "🔴";
}

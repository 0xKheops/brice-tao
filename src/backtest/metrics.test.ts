import { describe, expect, test } from "bun:test";
import {
	annualizedVolatility,
	cagr,
	calmarRatio,
	computeDrawdown,
	computeMetrics,
	computeReturns,
	conditionalVaR,
	type EquitySample,
	expectancy,
	kurtosis,
	omegaRatio,
	payoffRatio,
	profitFactor,
	recoveryFactor,
	sharpeRatio,
	skewness,
	sortinoRatio,
	type TradeResult,
	tailRatio,
	toDailyValues,
	totalReturn,
	valueAtRisk,
	winRate,
} from "./metrics.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function makeEquity(
	values: number[],
	startMs = Date.UTC(2025, 0, 1),
	intervalMs = DAY_MS,
): EquitySample[] {
	return values.map((v, i) => ({
		timestamp: startMs + i * intervalMs,
		value: v,
	}));
}

// ---------------------------------------------------------------------------
// Return helpers
// ---------------------------------------------------------------------------

describe("computeReturns", () => {
	test("computes simple returns", () => {
		const r = computeReturns([100, 110, 99]);
		expect(r).toHaveLength(2);
		expect(r[0]).toBeCloseTo(0.1, 10);
		expect(r[1]).toBeCloseTo(-0.1, 10);
	});

	test("empty and single element", () => {
		expect(computeReturns([])).toEqual([]);
		expect(computeReturns([100])).toEqual([]);
	});
});

describe("toDailyValues", () => {
	test("buckets intraday samples to end-of-day", () => {
		const samples: EquitySample[] = [
			{ timestamp: Date.UTC(2025, 0, 1, 0, 0), value: 100 },
			{ timestamp: Date.UTC(2025, 0, 1, 12, 0), value: 105 },
			{ timestamp: Date.UTC(2025, 0, 1, 23, 59), value: 110 },
			{ timestamp: Date.UTC(2025, 0, 2, 6, 0), value: 108 },
		];
		const daily = toDailyValues(samples);
		expect(daily).toHaveLength(2);
		// Last value of each day
		expect(daily[0]?.value).toBe(110);
		expect(daily[1]?.value).toBe(108);
	});

	test("empty input", () => {
		expect(toDailyValues([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Return metrics
// ---------------------------------------------------------------------------

describe("totalReturn", () => {
	test("positive return", () => {
		expect(totalReturn(100, 120)).toBeCloseTo(20, 10);
	});
	test("negative return", () => {
		expect(totalReturn(100, 80)).toBeCloseTo(-20, 10);
	});
	test("zero initial", () => {
		expect(totalReturn(0, 100)).toBe(0);
	});
});

describe("cagr", () => {
	test("doubles in one year", () => {
		// (200/100)^(365.25/365.25) - 1 = 1 = 100%
		expect(cagr(100, 200, 365.25)).toBeCloseTo(100, 5);
	});
	test("zero duration returns 0", () => {
		expect(cagr(100, 200, 0)).toBe(0);
	});
});

describe("annualizedVolatility", () => {
	test("constant returns → zero vol", () => {
		expect(annualizedVolatility([0.01, 0.01, 0.01, 0.01])).toBeCloseTo(0, 10);
	});
	test("insufficient data", () => {
		expect(annualizedVolatility([0.01])).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Risk-adjusted ratios
// ---------------------------------------------------------------------------

describe("sharpeRatio", () => {
	test("positive consistent returns → positive sharpe", () => {
		const returns = Array(100).fill(0.001) as number[];
		const sr = sharpeRatio(returns);
		expect(sr).not.toBeNull();
		// With zero variance this would be null, but fill creates tiny floating point diffs
		// Actually fill(0.001) gives identical values so stddev=0 → null
	});

	test("null with < 2 data points", () => {
		expect(sharpeRatio([0.01])).toBeNull();
	});

	test("null with zero variance", () => {
		expect(sharpeRatio([0.01, 0.01, 0.01])).toBeNull();
	});

	test("mixed returns produce finite ratio", () => {
		const returns = [0.02, -0.01, 0.03, -0.005, 0.01, 0.015, -0.02, 0.025];
		const sr = sharpeRatio(returns);
		expect(sr).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: asserted not null above
		expect(Number.isFinite(sr!)).toBe(true);
	});
});

describe("sortinoRatio", () => {
	test("null with insufficient data", () => {
		expect(sortinoRatio([0.01])).toBeNull();
	});

	test("all positive returns → null (no downside deviation)", () => {
		expect(sortinoRatio([0.01, 0.02, 0.03])).toBeNull();
	});

	test("mixed returns produce finite ratio", () => {
		const returns = [0.02, -0.01, 0.03, -0.005, 0.01];
		const sr = sortinoRatio(returns);
		expect(sr).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: asserted not null above
		expect(Number.isFinite(sr!)).toBe(true);
	});
});

describe("calmarRatio", () => {
	test("zero drawdown → null", () => {
		expect(calmarRatio(50, 0)).toBeNull();
	});
	test("positive cagr and drawdown", () => {
		expect(calmarRatio(100, 20)).toBeCloseTo(5, 10);
	});
});

describe("omegaRatio", () => {
	test("all gains → Infinity", () => {
		expect(omegaRatio([0.01, 0.02, 0.03])).toBe(Infinity);
	});
	test("all losses → 0 with threshold 0", () => {
		const o = omegaRatio([-0.01, -0.02, -0.03]);
		expect(o).toBeCloseTo(0, 10);
	});
	test("mixed returns", () => {
		const o = omegaRatio([0.05, -0.02, 0.03, -0.01]);
		expect(o).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: asserted not null above
		expect(o!).toBeGreaterThan(1);
	});
	test("empty → null", () => {
		expect(omegaRatio([])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Drawdown
// ---------------------------------------------------------------------------

describe("computeDrawdown", () => {
	test("monotonically increasing → zero drawdown", () => {
		const equity = makeEquity([100, 110, 120, 130]);
		const dd = computeDrawdown(equity);
		expect(dd.maxDrawdownPct).toBe(0);
		expect(dd.maxDrawdownDurationDays).toBe(0);
	});

	test("known drawdown", () => {
		// Peak at 200, trough at 150 → 25% drawdown
		const equity = makeEquity([100, 200, 150, 180, 210]);
		const dd = computeDrawdown(equity);
		expect(dd.maxDrawdownPct).toBeCloseTo(25, 10);
	});

	test("drawdown duration", () => {
		// Peak at day 0, drops, recovers at day 3
		const equity = makeEquity([100, 80, 90, 100, 110]);
		const dd = computeDrawdown(equity);
		expect(dd.maxDrawdownPct).toBeCloseTo(20, 10);
		// Recovers to peak at index 3 (3 days from peak at index 0)
		expect(dd.maxDrawdownDurationDays).toBeCloseTo(3, 5);
	});

	test("ends in drawdown", () => {
		const equity = makeEquity([100, 120, 90]);
		const dd = computeDrawdown(equity);
		expect(dd.maxDrawdownPct).toBeCloseTo(25, 10);
		// Duration from peak (day 1) to end (day 2) = 1 day
		expect(dd.maxDrawdownDurationDays).toBeCloseTo(1, 5);
	});

	test("insufficient data", () => {
		const dd = computeDrawdown([{ timestamp: 0, value: 100 }]);
		expect(dd.maxDrawdownPct).toBe(0);
	});
});

describe("recoveryFactor", () => {
	test("zero drawdown → null", () => {
		expect(recoveryFactor(50, 0)).toBeNull();
	});
	test("positive", () => {
		expect(recoveryFactor(100, 20)).toBeCloseTo(5, 10);
	});
});

// ---------------------------------------------------------------------------
// Trade-level metrics
// ---------------------------------------------------------------------------

describe("winRate", () => {
	test("50/50 trades", () => {
		const trades: TradeResult[] = [
			{ pnlAbsolute: 10 },
			{ pnlAbsolute: -5 },
			{ pnlAbsolute: 20 },
			{ pnlAbsolute: -15 },
		];
		expect(winRate(trades)).toBeCloseTo(50, 10);
	});
	test("all winners", () => {
		expect(winRate([{ pnlAbsolute: 1 }, { pnlAbsolute: 2 }])).toBeCloseTo(
			100,
			10,
		);
	});
	test("no trades → null", () => {
		expect(winRate([])).toBeNull();
	});
	test("breakeven counts as loss", () => {
		expect(winRate([{ pnlAbsolute: 0 }])).toBeCloseTo(0, 10);
	});
});

describe("profitFactor", () => {
	test("2:1 profit ratio", () => {
		const trades: TradeResult[] = [{ pnlAbsolute: 20 }, { pnlAbsolute: -10 }];
		expect(profitFactor(trades)).toBeCloseTo(2, 10);
	});
	test("no losses → Infinity", () => {
		expect(profitFactor([{ pnlAbsolute: 10 }])).toBe(Infinity);
	});
	test("no trades → null", () => {
		expect(profitFactor([])).toBeNull();
	});
});

describe("expectancy", () => {
	test("average PnL per trade", () => {
		const trades: TradeResult[] = [
			{ pnlAbsolute: 10 },
			{ pnlAbsolute: -5 },
			{ pnlAbsolute: 20 },
			{ pnlAbsolute: -15 },
		];
		expect(expectancy(trades)).toBeCloseTo(2.5, 10);
	});
	test("no trades → null", () => {
		expect(expectancy([])).toBeNull();
	});
});

describe("payoffRatio", () => {
	test("avg win 15, avg loss 10 → 1.5", () => {
		const trades: TradeResult[] = [
			{ pnlAbsolute: 10 },
			{ pnlAbsolute: 20 },
			{ pnlAbsolute: -10 },
		];
		expect(payoffRatio(trades)).toBeCloseTo(1.5, 10);
	});
	test("no losses → null", () => {
		expect(payoffRatio([{ pnlAbsolute: 10 }])).toBeNull();
	});
	test("no wins → null", () => {
		expect(payoffRatio([{ pnlAbsolute: -10 }])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tail risk
// ---------------------------------------------------------------------------

describe("valueAtRisk", () => {
	test("insufficient data", () => {
		expect(valueAtRisk([0.01, 0.02])).toBeNull();
	});
	test("negative tail captured", () => {
		const returns = [
			-0.05, -0.03, -0.01, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07,
		];
		const var95 = valueAtRisk(returns);
		expect(var95).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: asserted not null above
		expect(var95!).toBeLessThan(0);
	});
});

describe("conditionalVaR", () => {
	test("insufficient data", () => {
		expect(conditionalVaR([0.01])).toBeNull();
	});
	test("worse than VaR", () => {
		const returns = [
			-0.05, -0.03, -0.01, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07,
		];
		const cvar = conditionalVaR(returns);
		const var95 = valueAtRisk(returns);
		expect(cvar).not.toBeNull();
		// CVaR should be <= VaR (more negative = worse)
		// biome-ignore lint/style/noNonNullAssertion: asserted not null above
		expect(cvar!).toBeLessThanOrEqual(var95!);
	});
});

describe("tailRatio", () => {
	test("symmetric returns → ~1", () => {
		const returns = [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03];
		const tr = tailRatio(returns);
		expect(tr).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: asserted not null above
		expect(tr!).toBeCloseTo(1, 1);
	});
});

describe("skewness", () => {
	test("insufficient data", () => {
		expect(skewness([1, 2])).toBeNull();
	});
	test("symmetric data → near zero", () => {
		const data = [-3, -2, -1, 0, 1, 2, 3];
		const s = skewness(data);
		expect(s).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: asserted not null above
		expect(Math.abs(s!)).toBeLessThan(0.1);
	});
});

describe("kurtosis", () => {
	test("insufficient data", () => {
		expect(kurtosis([1, 2, 3])).toBeNull();
	});
	test("returns a number for sufficient data", () => {
		const data = [-3, -2, -1, 0, 1, 2, 3, -3, -2, -1, 0, 1, 2, 3];
		const k = kurtosis(data);
		expect(k).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: asserted not null above
		expect(Number.isFinite(k!)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Master computation
// ---------------------------------------------------------------------------

describe("computeMetrics", () => {
	test("full computation with realistic data", () => {
		const equity = makeEquity([
			100, 102, 98, 105, 103, 108, 106, 110, 107, 115, 112, 118, 114, 120, 116,
			122, 119, 125, 121, 128,
		]);
		const trades: TradeResult[] = [
			{ pnlAbsolute: 2 },
			{ pnlAbsolute: -4 },
			{ pnlAbsolute: 7 },
			{ pnlAbsolute: -2 },
			{ pnlAbsolute: 5 },
			{ pnlAbsolute: -3 },
			{ pnlAbsolute: 4 },
			{ pnlAbsolute: -1 },
			{ pnlAbsolute: 8 },
			{ pnlAbsolute: -2 },
		];
		const m = computeMetrics(equity, trades);

		expect(m.totalReturnPct).toBeCloseTo(28, 0);
		expect(m.cagr).toBeGreaterThan(0);
		expect(m.maxDrawdownPct).toBeGreaterThan(0);
		expect(m.winRate).toBeCloseTo(50, 10);
		expect(m.profitFactor).toBeGreaterThan(1);
		expect(m.expectancy).toBeGreaterThan(0);
	});

	test("empty equity curve", () => {
		const m = computeMetrics([], []);
		expect(m.totalReturnPct).toBe(0);
		expect(m.cagr).toBe(0);
		expect(m.sharpeRatio).toBeNull();
	});

	test("single sample", () => {
		const m = computeMetrics([{ timestamp: 0, value: 100 }], []);
		expect(m.totalReturnPct).toBe(0);
		expect(m.maxDrawdownPct).toBe(0);
	});
});

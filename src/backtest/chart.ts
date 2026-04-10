/**
 * Terminal equity chart using Unicode braille characters.
 *
 * Each braille character is a 2×4 dot matrix, giving much higher resolution
 * than standard ASCII block characters. Two series (strategy + HODL benchmark)
 * are rendered with different ANSI colors for visual comparison.
 */

// ---------------------------------------------------------------------------
// Braille encoding
// ---------------------------------------------------------------------------

const BRAILLE_BASE = 0x2800;

/**
 * Bit positions for (subCol, subRow) within a braille character.
 * subCol: 0 (left), 1 (right). subRow: 0 (top) to 3 (bottom).
 */
const BRAILLE_BITS = [
	[0x01, 0x02, 0x04, 0x40], // left column
	[0x08, 0x10, 0x20, 0x80], // right column
] as const;

function setPixel(
	canvas: number[][],
	px: number,
	py: number,
	charWidth: number,
): void {
	const charCol = Math.floor(px / 2);
	const charRow = Math.floor(py / 4);
	if (
		charCol < 0 ||
		charCol >= charWidth ||
		charRow < 0 ||
		charRow >= canvas.length
	)
		return;
	const subCol = px % 2;
	const subRow = py % 4;
	// biome-ignore lint/style/noNonNullAssertion: bounded by constants
	canvas[charRow]![charCol]! |= BRAILLE_BITS[subCol]![subRow]!;
}

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

export interface AnsiColors {
	green: string;
	red: string;
	yellow: string;
	cyan: string;
	dim: string;
	bold: string;
	underline: string;
	reset: string;
}

export function createColors(): AnsiColors {
	const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR;
	if (!enabled) {
		return {
			green: "",
			red: "",
			yellow: "",
			cyan: "",
			dim: "",
			bold: "",
			underline: "",
			reset: "",
		};
	}
	return {
		green: "\x1b[32m",
		red: "\x1b[31m",
		yellow: "\x1b[33m",
		cyan: "\x1b[36m",
		dim: "\x1b[2m",
		bold: "\x1b[1m",
		underline: "\x1b[4m",
		reset: "\x1b[0m",
	};
}

// ---------------------------------------------------------------------------
// Chart types
// ---------------------------------------------------------------------------

import type { EquitySample } from "./metrics.ts";

interface ChartOptions {
	/** Character columns for the braille plot area (default: 60) */
	width?: number;
	/** Character rows for the braille plot area (default: 15) */
	height?: number;
	colors: AnsiColors;
}

// ---------------------------------------------------------------------------
// Downsampling
// ---------------------------------------------------------------------------

function downsample(values: number[], targetLength: number): number[] {
	if (values.length === 0) return new Array(targetLength).fill(0);
	if (values.length === 1) return new Array(targetLength).fill(values[0]);
	if (values.length <= targetLength) {
		// Upsample via linear interpolation
		const result: number[] = [];
		for (let i = 0; i < targetLength; i++) {
			const srcIdx = (i / (targetLength - 1)) * (values.length - 1);
			const lo = Math.floor(srcIdx);
			const hi = Math.min(lo + 1, values.length - 1);
			const frac = srcIdx - lo;
			// biome-ignore lint/style/noNonNullAssertion: bounded
			result.push(values[lo]! * (1 - frac) + values[hi]! * frac);
		}
		return result;
	}

	// Downsample via linear interpolation at evenly-spaced source positions
	const result: number[] = [];
	for (let i = 0; i < targetLength; i++) {
		const srcIdx = (i / (targetLength - 1)) * (values.length - 1);
		const lo = Math.floor(srcIdx);
		const hi = Math.min(lo + 1, values.length - 1);
		const frac = srcIdx - lo;
		// biome-ignore lint/style/noNonNullAssertion: bounded
		result.push(values[lo]! * (1 - frac) + values[hi]! * frac);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Line drawing on braille canvas
// ---------------------------------------------------------------------------

function drawLine(
	canvas: number[][],
	charWidth: number,
	yPixels: number[],
	dotHeight: number,
): void {
	for (let x = 0; x < yPixels.length; x++) {
		// biome-ignore lint/style/noNonNullAssertion: bounded
		const y = yPixels[x]!;
		if (y < 0 || y >= dotHeight) continue;
		setPixel(canvas, x, y, charWidth);

		// Connect to previous point with vertical fill to avoid gaps
		if (x > 0) {
			// biome-ignore lint/style/noNonNullAssertion: bounded
			const prevY = yPixels[x - 1]!;
			const minY = Math.min(y, prevY);
			const maxY = Math.max(y, prevY);
			for (let fillY = minY; fillY <= maxY; fillY++) {
				if (fillY >= 0 && fillY < dotHeight) {
					setPixel(canvas, x, fillY, charWidth);
				}
			}
		}
	}
}

function makeCanvas(charHeight: number, charWidth: number): number[][] {
	return Array.from({ length: charHeight }, () => new Array(charWidth).fill(0));
}

function valuesToPixels(
	values: number[],
	minVal: number,
	maxVal: number,
	dotHeight: number,
): number[] {
	const range = maxVal - minVal;
	if (range === 0) {
		// Flat line in the middle
		return values.map(() => Math.floor(dotHeight / 2));
	}
	return values.map((v) => {
		const normalized = (v - minVal) / range;
		// Invert: 0 = top of canvas, dotHeight-1 = bottom
		return Math.round((1 - normalized) * (dotHeight - 1));
	});
}

// ---------------------------------------------------------------------------
// Y-axis label computation
// ---------------------------------------------------------------------------

function computeNiceTicks(
	min: number,
	max: number,
	targetCount: number,
): number[] {
	if (min === max) return [min];
	const range = max - min;
	const roughSpacing = range / (targetCount - 1);
	const magnitude = 10 ** Math.floor(Math.log10(roughSpacing));
	const residual = roughSpacing / magnitude;

	let niceSpacing: number;
	if (residual <= 1.5) niceSpacing = 1 * magnitude;
	else if (residual <= 3) niceSpacing = 2 * magnitude;
	else if (residual <= 7) niceSpacing = 5 * magnitude;
	else niceSpacing = 10 * magnitude;

	const niceMin = Math.floor(min / niceSpacing) * niceSpacing;
	const niceMax = Math.ceil(max / niceSpacing) * niceSpacing;
	const ticks: number[] = [];
	for (let v = niceMin; v <= niceMax + niceSpacing * 0.01; v += niceSpacing) {
		ticks.push(Math.round(v * 1e8) / 1e8); // avoid float artifacts
	}
	return ticks;
}

function formatAxisLabel(v: number): string {
	if (Math.abs(v) >= 1000) return v.toFixed(0);
	if (Math.abs(v) >= 100) return v.toFixed(1);
	if (Math.abs(v) >= 10) return v.toFixed(2);
	return v.toFixed(2);
}

// ---------------------------------------------------------------------------
// Date labels for X-axis
// ---------------------------------------------------------------------------

function formatDateShort(timestamp: number): string {
	const d = new Date(timestamp);
	const months = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	];
	return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a terminal equity chart with one or two series using braille characters.
 *
 * Returns a multi-line string ready for console.log.
 * Strategy line is colored green/cyan, HODL line is dim.
 */
export function renderEquityChart(
	strategyCurve: EquitySample[],
	hodlCurve?: EquitySample[],
	options?: Partial<ChartOptions>,
): string {
	if (strategyCurve.length < 2) return "";

	const c = options?.colors ?? createColors();
	const charWidth = options?.width ?? 60;
	const charHeight = options?.height ?? 15;
	const dotWidth = charWidth * 2;
	const dotHeight = charHeight * 4;

	// Extract values and timestamps
	const stratVals = strategyCurve.map((p) => p.value);
	const hodlVals = hodlCurve?.map((p) => p.value);
	const timestamps = strategyCurve.map((p) => p.timestamp);

	// Compute Y range across both series with 5% padding
	let minVal = Math.min(...stratVals);
	let maxVal = Math.max(...stratVals);
	if (hodlVals && hodlVals.length > 0) {
		minVal = Math.min(minVal, ...hodlVals);
		maxVal = Math.max(maxVal, ...hodlVals);
	}
	const padding = (maxVal - minVal) * 0.05 || 0.01;
	minVal -= padding;
	maxVal += padding;

	// Downsample to dot resolution
	const stratDownsampled = downsample(stratVals, dotWidth);
	const hodlDownsampled = hodlVals ? downsample(hodlVals, dotWidth) : null;

	// Map values to pixel Y coordinates
	const stratPixels = valuesToPixels(
		stratDownsampled,
		minVal,
		maxVal,
		dotHeight,
	);
	const hodlPixels = hodlDownsampled
		? valuesToPixels(hodlDownsampled, minVal, maxVal, dotHeight)
		: null;

	// Draw on separate canvases for independent coloring
	const stratCanvas = makeCanvas(charHeight, charWidth);
	drawLine(stratCanvas, charWidth, stratPixels, dotHeight);

	const hodlCanvas = hodlPixels ? makeCanvas(charHeight, charWidth) : null;
	if (hodlCanvas && hodlPixels) {
		drawLine(hodlCanvas, charWidth, hodlPixels, dotHeight);
	}

	// Compute Y-axis ticks
	const ticks = computeNiceTicks(minVal, maxVal, 6);
	const labelWidth = Math.max(
		...ticks.map((t) => formatAxisLabel(t).length),
		4,
	);

	// Map tick values to character rows
	const tickRowMap = new Map<number, string>();
	for (const tick of ticks) {
		if (tick < minVal || tick > maxVal) continue;
		const normalized = (tick - minVal) / (maxVal - minVal);
		const pixelY = Math.round((1 - normalized) * (dotHeight - 1));
		const charRow = Math.floor(pixelY / 4);
		if (charRow >= 0 && charRow < charHeight) {
			tickRowMap.set(charRow, formatAxisLabel(tick));
		}
	}

	// Build output lines
	const lines: string[] = [];

	// Header with legend
	const legendPad = " ".repeat(labelWidth + 2);
	const legend = hodlCurve
		? `${legendPad}${c.dim}  ── ${c.reset}${c.cyan}Strategy${c.reset}${c.dim}  ╌╌ HODL (SN0)${c.reset}`
		: "";
	lines.push(`  📊 Equity Curve (τ)${legend}`);

	// Chart rows
	for (let row = 0; row < charHeight; row++) {
		const label = tickRowMap.get(row);
		const labelStr = label
			? label.padStart(labelWidth)
			: " ".repeat(labelWidth);

		let rowStr = "";
		for (let col = 0; col < charWidth; col++) {
			// biome-ignore lint/style/noNonNullAssertion: canvas is properly sized
			const stratBits = stratCanvas[row]![col]!;
			const hodlBits = hodlCanvas ? (hodlCanvas[row]?.[col] ?? 0) : 0;

			if (stratBits && hodlBits) {
				// Both series in this cell — combine bits, use strategy color
				const combined = stratBits | hodlBits;
				rowStr += `${c.cyan}${String.fromCharCode(BRAILLE_BASE + combined)}${c.reset}`;
			} else if (stratBits) {
				rowStr += `${c.cyan}${String.fromCharCode(BRAILLE_BASE + stratBits)}${c.reset}`;
			} else if (hodlBits) {
				rowStr += `${c.dim}${String.fromCharCode(BRAILLE_BASE + hodlBits)}${c.reset}`;
			} else {
				// Empty cell — use blank braille (U+2800) for consistent spacing
				rowStr += String.fromCharCode(BRAILLE_BASE);
			}
		}

		lines.push(`  ${c.dim}${labelStr} ┤${c.reset}${rowStr}`);
	}

	// X-axis bottom border
	const bottomBorder = `  ${" ".repeat(labelWidth)} └${"─".repeat(charWidth)}`;
	lines.push(`${c.dim}${bottomBorder}${c.reset}`);

	// X-axis date labels
	if (timestamps.length >= 2) {
		const dateCount = Math.min(5, Math.max(2, Math.floor(charWidth / 12)));
		let dateLine = " ".repeat(labelWidth + 3); // offset for Y-axis + border
		const positions: Array<{ pos: number; label: string }> = [];

		for (let i = 0; i < dateCount; i++) {
			const idx = Math.round((i / (dateCount - 1)) * (timestamps.length - 1));
			// biome-ignore lint/style/noNonNullAssertion: bounded
			const label = formatDateShort(timestamps[idx]!);
			const charPos = Math.round((i / (dateCount - 1)) * (charWidth - 1));
			positions.push({ pos: charPos, label });
		}

		// Build the date line by placing labels at their positions
		const dateChars = new Array(charWidth).fill(" ");
		for (const { pos, label } of positions) {
			const start = Math.max(0, pos - Math.floor(label.length / 2));
			for (let j = 0; j < label.length && start + j < charWidth; j++) {
				dateChars[start + j] = label[j];
			}
		}
		dateLine += dateChars.join("");
		lines.push(`${c.dim}${dateLine}${c.reset}`);
	}

	return lines.join("\n");
}

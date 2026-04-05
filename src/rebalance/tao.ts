export const TAO = 1_000_000_000n;

/** Format a RAO amount as a human-readable TAO string. */
export function formatTao(rao: bigint, decimals = 4): string {
	const abs = rao < 0n ? -rao : rao;
	const sign = rao < 0n ? "-" : "";
	const whole = abs / TAO;
	const multiplier = 10n ** BigInt(decimals);
	const frac = ((abs % TAO) * multiplier) / TAO;
	return `${sign}${whole}.${frac.toString().padStart(decimals, "0")}`;
}

export function parseTao(value: number): bigint {
	if (!Number.isFinite(value)) {
		throw new Error(`Invalid TAO amount: ${String(value)} (must be finite)`);
	}
	if (value < 0) {
		throw new Error(`Invalid TAO amount: ${value} (must be non-negative)`);
	}

	const { digits, scale } = toDecimalComponents(value);
	if (scale > 9) {
		throw new Error(
			`Invalid TAO amount: ${value} (max precision is 9 decimal places)`,
		);
	}

	return BigInt(digits) * 10n ** BigInt(9 - scale);
}

function toDecimalComponents(value: number): { digits: string; scale: number } {
	const normalized = value.toString().toLowerCase();
	const match = normalized.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
	if (!match) {
		throw new Error(`Invalid TAO amount: ${value}`);
	}

	const intPart = match[1] ?? "0";
	const fracPart = match[2] ?? "";
	const exp = Number.parseInt(match[3] ?? "0", 10);

	let digits = `${intPart}${fracPart}`.replace(/^0+/, "");
	if (digits.length === 0) {
		return { digits: "0", scale: 0 };
	}

	let scale = fracPart.length - exp;
	if (scale < 0) {
		digits = `${digits}${"0".repeat(-scale)}`;
		scale = 0;
	}

	return { digits, scale };
}

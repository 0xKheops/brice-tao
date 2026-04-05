import { deriveSigner } from "../src/accounts/deriveSigner.ts";
import { createBittensorClient } from "../src/api/createClient.ts";
import { fetchSubnetNames } from "../src/api/fetchSubnetNames.ts";
import type { Balances } from "../src/balances/getBalances.ts";
import { getBalances } from "../src/balances/getBalances.ts";
import { TAO } from "../src/rebalance/tao.ts";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const coldkey = process.env.COLDKEY_ADDRESS;
const proxyMnemonic = process.env.PROXY_MNEMONIC;

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!coldkey) throw new Error("COLDKEY_ADDRESS is not set");

// ---------------------------------------------------------------------------
// Proxy address derivation (optional)
// ---------------------------------------------------------------------------
const proxyAddress = proxyMnemonic
	? deriveSigner(proxyMnemonic).address
	: undefined;

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------
const { client, api } = createBittensorClient(wsEndpoints);

try {
	// Fetch subnet names + balances in parallel
	const accounts: Array<{ label: string; address: string }> = [
		{ label: "Coldkey", address: coldkey },
	];
	if (proxyAddress) {
		accounts.push({ label: "Proxy", address: proxyAddress });
	}

	const [subnetNames, ...balanceResults] = await Promise.all([
		fetchSubnetNames(api),
		...accounts.map((a) => getBalances(api, a.address)),
	]);

	// -----------------------------------------------------------------------
	// Display
	// -----------------------------------------------------------------------
	console.log();
	console.log("╔══════════════════════════════════════╗");
	console.log("║         Portfolio Balances            ║");
	console.log("╚══════════════════════════════════════╝");

	let grandTotal = 0n;

	for (const [i, account] of accounts.entries()) {
		const balances = balanceResults[i] as Balances;
		grandTotal += balances.totalTaoValue;

		console.log();
		console.log(`◆ ${account.label} (${truncate(account.address)})`);
		console.log(`  Free:      ${fmt(balances.free)}`);
		console.log(`  Reserved:  ${fmt(balances.reserved)}`);

		if (balances.stakes.length === 0) {
			console.log("  Stakes:    (none)");
		} else {
			printStakesTable(balances.stakes, subnetNames);
		}

		console.log("  ─────────────────────────────────────────────");
		console.log(`  Subtotal:  ${fmt(balances.totalTaoValue)}`);
	}

	console.log();
	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log(`Grand Total: ${fmt(grandTotal)}`);
	console.log();
} finally {
	client.destroy();
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(rao: bigint): string {
	const whole = rao / TAO;
	const frac = (rao < 0n ? -rao : rao) % TAO;
	return `${whole}.${frac.toString().padStart(9, "0")} τ`;
}

function truncate(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function truncateName(name: string, maxLen: number): string {
	return name.length > maxLen ? `${name.slice(0, maxLen - 1)}…` : name;
}

function printStakesTable(
	stakes: Balances["stakes"],
	subnetNames: Map<number, string>,
): void {
	// Sort by TAO value descending
	const sorted = [...stakes].sort((a, b) =>
		a.taoValue > b.taoValue ? -1 : a.taoValue < b.taoValue ? 1 : 0,
	);

	// Aggregate by netuid (multiple hotkeys may stake on the same subnet)
	const bySubnet = new Map<
		number,
		{ totalAlpha: bigint; totalTao: bigint; count: number }
	>();
	for (const s of sorted) {
		const existing = bySubnet.get(s.netuid);
		if (existing) {
			existing.totalAlpha += s.stake;
			existing.totalTao += s.taoValue;
			existing.count++;
		} else {
			bySubnet.set(s.netuid, {
				totalAlpha: s.stake,
				totalTao: s.taoValue,
				count: 1,
			});
		}
	}

	// Sort aggregated entries by TAO value descending
	const entries = [...bySubnet.entries()].sort((a, b) =>
		a[1].totalTao > b[1].totalTao ? -1 : a[1].totalTao < b[1].totalTao ? 1 : 0,
	);

	const NAME_MAX = 16;
	console.log("  Stakes:");
	for (const [netuid, agg] of entries) {
		const name = truncateName(
			subnetNames.get(netuid) ?? "Unknown",
			NAME_MAX,
		).padEnd(NAME_MAX);
		const snLabel = `SN${netuid.toString().padStart(3, " ")}`;
		const hotkeys = agg.count > 1 ? ` (${agg.count} validators)` : "";
		console.log(
			`    ${snLabel} │ ${name} │ ${fmt(agg.totalTao).padStart(22)}${hotkeys}`,
		);
	}
}

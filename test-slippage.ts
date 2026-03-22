import { bittensor, MultiAddress } from "@polkadot-api/descriptors";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
	entropyToMiniSecret,
	mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers";
import type { TypedApi } from "polkadot-api";
import { Enum } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { createWsClient } from "polkadot-api/ws";
import { getBalances } from "./src/getBalances.ts";

type Api = TypedApi<typeof bittensor>;

const TAO = 1_000_000_000n;
const TEST_AMOUNT_TAO = (TAO * 2n) / 100n; // 0.02 TAO

// ── Environment ──────────────────────────────────

const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const coldkey = process.env.COLDKEY_ADDRESS;
const proxyMnemonic = process.env.PROXY_MNEMONIC;
const validatorHotkey = process.env.VALIDATOR_HOTKEY;

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!coldkey) throw new Error("COLDKEY_ADDRESS is not set");
if (!proxyMnemonic) throw new Error("PROXY_MNEMONIC is not set");
if (!validatorHotkey) throw new Error("VALIDATOR_HOTKEY is not set");

// ── CLI: --netuid=<N> ────────────────────────────

const netuidFlag = process.argv.find((a) => a.startsWith("--netuid="));
const requestedNetuid = netuidFlag
	? Number(netuidFlag.split("=")[1])
	: undefined;

// ── Signer ───────────────────────────────────────

const miniSecret = entropyToMiniSecret(mnemonicToEntropy(proxyMnemonic));
const derive = sr25519CreateDerive(miniSecret);
const keyPair = derive("");
const signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);

// ── Connect ──────────────────────────────────────

const client = createWsClient(wsEndpoints);

interface StepResult {
	label: string;
	unit: string;
	expected: bigint;
	actual: bigint;
}

const results: StepResult[] = [];

try {
	const api = client.getTypedApi(bittensor);

	console.log("Fetching balances...\n");
	const balances = await getBalances(api, coldkey);

	// Need two positions: one as origin, SN45 as destination (or vice versa)
	// Pick a non-SN45 position with correct hotkey
	const eligible = balances.stakes
		.filter((s) => s.netuid !== 45 && s.hotkey === validatorHotkey)
		.sort((a, b) => Number(a.taoValue - b.taoValue));

	const position = requestedNetuid
		? eligible.find((s) => s.netuid === requestedNetuid)
		: eligible[0];

	if (!position) {
		throw new Error(
			requestedNetuid
				? `No position on SN${requestedNetuid} with hotkey ${validatorHotkey}`
				: "No eligible position (need a non-SN45 position with validator hotkey)",
		);
	}

	if (position.taoValue < TEST_AMOUNT_TAO) {
		throw new Error(
			`Position SN${position.netuid} too small (${fmtRao(position.taoValue)} τ < ${fmtRao(TEST_AMOUNT_TAO)} τ)`,
		);
	}

	// Compute alpha amount worth ~TEST_AMOUNT_TAO
	const testAlpha =
		position.alphaPrice > 0n
			? (TEST_AMOUNT_TAO * TAO) / position.alphaPrice
			: 0n;
	if (testAlpha <= 0n) {
		throw new Error("Cannot compute test alpha amount (zero price?)");
	}

	console.log(`Swap test: SN${position.netuid} → SN45 → SN${position.netuid}`);
	console.log(
		`  Position:   ${fmtRao(position.stake)} α on SN${position.netuid}`,
	);
	console.log(`  TAO value:  ${fmtRao(position.taoValue)} τ`);
	console.log(`  Price:      ${fmtRao(position.alphaPrice)} τ/α`);
	console.log(
		`  Test amount: ${fmtRao(testAlpha)} α (~${fmtRao(TEST_AMOUNT_TAO)} τ)`,
	);

	// ═══════════════════════════════════════════════
	// Swap: SN(origin) → SN45
	// ═══════════════════════════════════════════════
	console.log("\n══════════════════════════════════════");
	console.log(`Swap: SN${position.netuid} → SN45`);
	console.log("══════════════════════════════════════");

	const sn45AlphaBefore = await getAlphaStake(
		api,
		validatorHotkey,
		coldkey,
		45,
	);

	// Chained simulation: alpha(origin) → TAO → alpha(SN45)
	const fwdSim1 = await api.apis.SwapRuntimeApi.sim_swap_alpha_for_tao(
		position.netuid,
		testAlpha,
	);
	const fwdSim2 = await api.apis.SwapRuntimeApi.sim_swap_tao_for_alpha(
		45,
		fwdSim1.tao_amount,
	);
	console.log("\n  Chained simulation:");
	console.log(
		`    Leg 1 (α→τ): ${fmtRao(testAlpha)} α → ${fmtRao(fwdSim1.tao_amount)} τ (fee: ${fmtRao(fwdSim1.tao_fee)} τ, slippage: ${fmtRao(fwdSim1.tao_slippage)} τ)`,
	);
	console.log(
		`    Leg 2 (τ→α): ${fmtRao(fwdSim1.tao_amount)} τ → ${fmtRao(fwdSim2.alpha_amount)} α (fee: ${fmtRao(fwdSim2.tao_fee)} τ, slippage: ${fmtRao(fwdSim2.tao_slippage)} τ)`,
	);

	const fwdStakeFee = await api.apis.StakeInfoRuntimeApi.get_stake_fee(
		[validatorHotkey, position.netuid],
		coldkey,
		[validatorHotkey, 45],
		coldkey,
		fwdSim1.tao_amount,
	);
	console.log(
		`    Total sim fees: ${fmtRao(fwdSim1.tao_fee + fwdSim2.tao_fee)} τ | get_stake_fee: ${fmtRao(fwdStakeFee)} τ`,
	);

	console.log("\n  Submitting swap_stake_limit...");
	await proxyCall(
		api,
		api.tx.SubtensorModule.swap_stake_limit({
			hotkey: validatorHotkey,
			origin_netuid: position.netuid,
			destination_netuid: 45,
			alpha_amount: testAlpha,
			limit_price: 0n,
			allow_partial: false,
		}),
	);
	console.log("  ✓ Finalized");

	const sn45AlphaAfter = await getAlphaStake(api, validatorHotkey, coldkey, 45);
	const actualFwdAlpha = sn45AlphaAfter - sn45AlphaBefore;

	reportStep(
		`SN${position.netuid}→45`,
		"α",
		fwdSim2.alpha_amount,
		actualFwdAlpha,
	);

	// ═══════════════════════════════════════════════
	// Swap back: SN45 → SN(origin)
	// ═══════════════════════════════════════════════
	console.log("\n══════════════════════════════════════");
	console.log(`Swap back: SN45 → SN${position.netuid}`);
	console.log("══════════════════════════════════════");

	const origAlphaBefore = await getAlphaStake(
		api,
		validatorHotkey,
		coldkey,
		position.netuid,
	);

	// Chained simulation: alpha(SN45) → TAO → alpha(original)
	const revSim1 = await api.apis.SwapRuntimeApi.sim_swap_alpha_for_tao(
		45,
		actualFwdAlpha,
	);
	const revSim2 = await api.apis.SwapRuntimeApi.sim_swap_tao_for_alpha(
		position.netuid,
		revSim1.tao_amount,
	);
	console.log("\n  Chained simulation:");
	console.log(
		`    Leg 1 (α→τ): ${fmtRao(actualFwdAlpha)} α → ${fmtRao(revSim1.tao_amount)} τ (fee: ${fmtRao(revSim1.tao_fee)} τ, slippage: ${fmtRao(revSim1.tao_slippage)} τ)`,
	);
	console.log(
		`    Leg 2 (τ→α): ${fmtRao(revSim1.tao_amount)} τ → ${fmtRao(revSim2.alpha_amount)} α (fee: ${fmtRao(revSim2.tao_fee)} τ, slippage: ${fmtRao(revSim2.tao_slippage)} τ)`,
	);

	const revStakeFee = await api.apis.StakeInfoRuntimeApi.get_stake_fee(
		[validatorHotkey, 45],
		coldkey,
		[validatorHotkey, position.netuid],
		coldkey,
		revSim1.tao_amount,
	);
	console.log(
		`    Total sim fees: ${fmtRao(revSim1.tao_fee + revSim2.tao_fee)} τ | get_stake_fee: ${fmtRao(revStakeFee)} τ`,
	);

	console.log("\n  Submitting swap_stake_limit...");
	await proxyCall(
		api,
		api.tx.SubtensorModule.swap_stake_limit({
			hotkey: validatorHotkey,
			origin_netuid: 45,
			destination_netuid: position.netuid,
			alpha_amount: actualFwdAlpha,
			limit_price: 0n,
			allow_partial: false,
		}),
	);
	console.log("  ✓ Finalized");

	const origAlphaAfter = await getAlphaStake(
		api,
		validatorHotkey,
		coldkey,
		position.netuid,
	);
	const actualRevAlpha = origAlphaAfter - origAlphaBefore;

	reportStep(
		`45→SN${position.netuid}`,
		"α",
		revSim2.alpha_amount,
		actualRevAlpha,
	);

	// ═══════════════════════════════════════════════
	// Summary
	// ═══════════════════════════════════════════════
	console.log("\n══════════════════════════════════════");
	console.log("Summary");
	console.log("══════════════════════════════════════\n");

	const c = { step: 12, val: 20, pct: 10 };
	console.log(
		`  ${"Step".padEnd(c.step)}│ ${"Expected".padEnd(c.val)}│ ${"Actual".padEnd(c.val)}│ ${"Delta".padEnd(c.val)}│ Delta %`,
	);
	console.log(
		`  ${"─".repeat(c.step)}┼${"─".repeat(c.val + 1)}┼${"─".repeat(c.val + 1)}┼${"─".repeat(c.val + 1)}┼${"─".repeat(c.pct)}`,
	);
	for (const r of results) {
		const delta = r.actual - r.expected;
		const pct = deltaPct(r.expected, r.actual);
		console.log(
			`  ${r.label.padEnd(c.step)}│ ${pad(fmtRao(r.expected), r.unit, c.val)}│ ${pad(fmtRao(r.actual), r.unit, c.val)}│ ${pad(fmtRao(delta), r.unit, c.val)}│ ${pct}`,
		);
	}

	console.log("");
} catch (err) {
	console.error("\n✗ Test failed:", err);
	process.exit(1);
} finally {
	client.destroy();
}

// ── Helpers ──────────────────────────────────────

async function getAlphaStake(
	api: Api,
	hotkey: string,
	coldkeyAddr: string,
	netuid: number,
): Promise<bigint> {
	const info =
		await api.apis.StakeInfoRuntimeApi.get_stake_info_for_hotkey_coldkey_netuid(
			hotkey,
			coldkeyAddr,
			netuid,
		);
	return info?.stake ?? 0n;
}

// biome-ignore lint/suspicious/noExplicitAny: Transaction type is complex and not worth spelling out
async function proxyCall(api: Api, innerTx: any): Promise<void> {
	const tx = api.tx.Proxy.proxy({
		// coldkey is validated at startup — safe to assert
		// biome-ignore lint/style/noNonNullAssertion: validated above
		real: MultiAddress.Id(coldkey!),
		force_proxy_type: Enum("Staking"),
		call: innerTx.decodedCall,
	});
	await tx.signAndSubmit(signer);
}

function reportStep(
	label: string,
	unit: string,
	expected: bigint,
	actual: bigint,
): void {
	const delta = actual - expected;
	const pct = deltaPct(expected, actual);

	console.log(`\n  Expected: ${fmtRao(expected)} ${unit}`);
	console.log(`  Actual:   ${fmtRao(actual)} ${unit}`);
	console.log(`  Delta:    ${fmtRao(delta)} ${unit} (${pct})`);

	results.push({ label, unit, expected, actual });
}

function deltaPct(expected: bigint, actual: bigint): string {
	if (expected === 0n) return "N/A";
	const delta = actual - expected;
	const pct = Number((delta * 1_000_000n) / expected) / 10_000;
	return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function fmtRao(rao: bigint): string {
	const neg = rao < 0n;
	const abs = neg ? -rao : rao;
	const whole = abs / TAO;
	const frac = (abs % TAO) / 1000n; // 6 decimal places (TAO has 9 digits)
	return `${neg ? "-" : ""}${whole}.${frac.toString().padStart(6, "0")}`;
}

function pad(value: string, unit: string, width: number): string {
	return `${value} ${unit}`.padEnd(width);
}

import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import { SLIPPAGE_BUFFER, TAO } from "./constants.ts";
import { log } from "./logger.ts";
import type {
	RebalanceOperation,
	StakeOperation,
	SwapOperation,
	UnstakeOperation,
	UnstakePartialOperation,
} from "./types.ts";

type Api = TypedApi<typeof bittensor>;

/**
 * Fill in simulation-based limit prices for all operations.
 *
 * - stake:          sim_swap_tao_for_alpha → effective price + buffer (max price to pay)
 * - unstake/partial: sim_swap_alpha_for_tao → effective price − buffer (min price to accept)
 * - swap:           current price ratio (origin/dest) − buffer (min acceptable ratio)
 */
export async function simulateAllOperations(
	api: Api,
	operations: RebalanceOperation[],
): Promise<RebalanceOperation[]> {
	return Promise.all(operations.map((op) => simulateOperation(api, op)));
}

function simulateOperation(
	api: Api,
	op: RebalanceOperation,
): Promise<RebalanceOperation> {
	switch (op.kind) {
		case "stake":
			return simulateStake(api, op);
		case "unstake":
			return simulateUnstake(api, op);
		case "unstake_partial":
			return simulateUnstakePartial(api, op);
		case "swap":
			return simulateSwap(api, op);
	}
}

async function simulateStake(
	api: Api,
	op: StakeOperation,
): Promise<StakeOperation> {
	const sim = await api.apis.SwapRuntimeApi.sim_swap_tao_for_alpha(
		op.netuid,
		op.taoAmount,
	);
	if (sim.alpha_amount === 0n) {
		log.warn(`Sim stake SN${op.netuid}: zero alpha output — skipping limit`);
		return op;
	}
	// effective price = TAO spent / alpha received (TAO per alpha)
	const effectivePrice = (sim.tao_amount * TAO) / sim.alpha_amount;
	// add_stake_limit: limit_price = max price to pay → buffer up
	const limitPrice = bufferUp(effectivePrice);
	log.verbose(
		`  Sim stake SN${op.netuid}: effective=${effectivePrice} limit=${limitPrice}`,
	);
	return { ...op, limitPrice };
}

async function simulateUnstake(
	api: Api,
	op: UnstakeOperation,
): Promise<UnstakeOperation> {
	const sim = await api.apis.SwapRuntimeApi.sim_swap_alpha_for_tao(
		op.netuid,
		op.alphaAmount,
	);
	if (sim.tao_amount === 0n) {
		log.warn(`Sim unstake SN${op.netuid}: zero TAO output — skipping limit`);
		return op;
	}
	// effective price = TAO received / alpha sold (TAO per alpha)
	const effectivePrice = (sim.tao_amount * TAO) / sim.alpha_amount;
	// remove_stake_limit: limit_price = min price to accept → buffer down
	const limitPrice = bufferDown(effectivePrice);
	log.verbose(
		`  Sim unstake SN${op.netuid}: effective=${effectivePrice} limit=${limitPrice}`,
	);
	return { ...op, limitPrice };
}

async function simulateUnstakePartial(
	api: Api,
	op: UnstakePartialOperation,
): Promise<UnstakePartialOperation> {
	const sim = await api.apis.SwapRuntimeApi.sim_swap_alpha_for_tao(
		op.netuid,
		op.alphaAmount,
	);
	if (sim.tao_amount === 0n) {
		log.warn(
			`Sim unstake_partial SN${op.netuid}: zero TAO output — skipping limit`,
		);
		return op;
	}
	const effectivePrice = (sim.tao_amount * TAO) / sim.alpha_amount;
	const limitPrice = bufferDown(effectivePrice);
	log.verbose(
		`  Sim unstake_partial SN${op.netuid}: effective=${effectivePrice} limit=${limitPrice}`,
	);
	return { ...op, limitPrice };
}

async function simulateSwap(
	api: Api,
	op: SwapOperation,
): Promise<SwapOperation> {
	// swap_stake_limit limit_price = min acceptable ratio (origin_price / dest_price)
	// On-chain check: REJECT if limit_price / 1e9 > current ratio
	const [originPrice, destPrice] = await Promise.all([
		api.apis.SwapRuntimeApi.current_alpha_price(op.originNetuid),
		api.apis.SwapRuntimeApi.current_alpha_price(op.destinationNetuid),
	]);

	if (destPrice === 0n) {
		log.warn(
			`Sim swap SN${op.originNetuid}→SN${op.destinationNetuid}: zero dest price — skipping limit`,
		);
		return op;
	}

	const ratio = (originPrice * TAO) / destPrice;
	// buffer down → more permissive (lower min ratio)
	const limitPrice = bufferDown(ratio);
	log.verbose(
		`  Sim swap SN${op.originNetuid}→SN${op.destinationNetuid}: ratio=${ratio} limit=${limitPrice}`,
	);
	return { ...op, limitPrice };
}

function bufferUp(price: bigint): bigint {
	const bps = BigInt(Math.round(SLIPPAGE_BUFFER * 10_000));
	return price + (price * bps) / 10_000n;
}

function bufferDown(price: bigint): bigint {
	const bps = BigInt(Math.round(SLIPPAGE_BUFFER * 10_000));
	return price - (price * bps) / 10_000n;
}

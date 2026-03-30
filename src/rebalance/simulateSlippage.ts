import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";
import type { AppConfig } from "../config/types.ts";
import { TAO } from "./constants.ts";
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
	config: Pick<AppConfig["rebalance"], "slippageBuffer" | "swapSlippageBuffer">,
): Promise<RebalanceOperation[]> {
	return Promise.all(
		operations.map((op) => simulateOperation(api, op, config)),
	);
}

function simulateOperation(
	api: Api,
	op: RebalanceOperation,
	config: Pick<AppConfig["rebalance"], "slippageBuffer" | "swapSlippageBuffer">,
): Promise<RebalanceOperation> {
	switch (op.kind) {
		case "stake":
			return simulateStake(api, op, config.slippageBuffer);
		case "unstake":
			return simulateUnstake(api, op, config.slippageBuffer);
		case "unstake_partial":
			return simulateUnstakePartial(api, op, config.slippageBuffer);
		case "swap":
			return simulateSwap(api, op, config.swapSlippageBuffer);
		case "move":
			return Promise.resolve(op);
	}
}

async function simulateStake(
	api: Api,
	op: StakeOperation,
	slippageBuffer: number,
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
	const limitPrice = bufferUp(effectivePrice, slippageBuffer);
	log.verbose(
		`  Sim stake SN${op.netuid}: effective=${effectivePrice} limit=${limitPrice}`,
	);
	return { ...op, limitPrice };
}

async function simulateUnstake(
	api: Api,
	op: UnstakeOperation,
	slippageBuffer: number,
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
	const limitPrice = bufferDown(effectivePrice, slippageBuffer);
	log.verbose(
		`  Sim unstake SN${op.netuid}: effective=${effectivePrice} limit=${limitPrice}`,
	);
	return { ...op, limitPrice };
}

async function simulateUnstakePartial(
	api: Api,
	op: UnstakePartialOperation,
	slippageBuffer: number,
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
	const limitPrice = bufferDown(effectivePrice, slippageBuffer);
	log.verbose(
		`  Sim unstake_partial SN${op.netuid}: effective=${effectivePrice} limit=${limitPrice}`,
	);
	return { ...op, limitPrice };
}

async function simulateSwap(
	api: Api,
	op: SwapOperation,
	swapSlippageBuffer: number,
): Promise<SwapOperation> {
	const simUnstake = await api.apis.SwapRuntimeApi.sim_swap_alpha_for_tao(
		op.originNetuid,
		op.alphaAmount,
	);
	if (simUnstake.tao_amount === 0n || simUnstake.alpha_amount === 0n) {
		log.warn(
			`Sim swap SN${op.originNetuid}→SN${op.destinationNetuid}: zero unstake output — skipping limit`,
		);
		return op;
	}

	const simStake = await api.apis.SwapRuntimeApi.sim_swap_tao_for_alpha(
		op.destinationNetuid,
		simUnstake.tao_amount,
	);
	if (simStake.alpha_amount === 0n) {
		log.warn(
			`Sim swap SN${op.originNetuid}→SN${op.destinationNetuid}: zero stake output — skipping limit`,
		);
		return op;
	}

	// conversion ratio: dest alpha received per origin alpha spent, scaled by TAO (10^9)
	// this matches what the runtime expects for swap_stake_limit's limit_price
	const actualPrice = (simStake.alpha_amount * TAO) / simUnstake.alpha_amount;

	// Use wider swap buffer to absorb intra-batch price compounding
	const bps = BigInt(Math.round(swapSlippageBuffer * 10_000));
	const limitPrice = actualPrice - (actualPrice * bps) / 10_000n;
	log.verbose(
		`  Sim swap SN${op.originNetuid}→SN${op.destinationNetuid}: ratio=${actualPrice} limit=${limitPrice}`,
	);
	return { ...op, limitPrice };
}

function bufferUp(price: bigint, slippageBuffer: number): bigint {
	const bps = BigInt(Math.round(slippageBuffer * 10_000));
	return price + (price * bps) / 10_000n;
}

function bufferDown(price: bigint, slippageBuffer: number): bigint {
	const bps = BigInt(Math.round(slippageBuffer * 10_000));
	return price - (price * bps) / 10_000n;
}

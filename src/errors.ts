/** Base class for all rebalancer errors — enables typed catch blocks */
export class RebalanceError extends Error {
	override readonly name: string;

	constructor(
		message: string,
		public readonly code: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = this.constructor.name;
	}
}

/** Config file missing, malformed, or has invalid values */
export class ConfigError extends RebalanceError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "CONFIG_ERROR", options);
	}
}

/** Swap simulation returned zero output or price moved beyond buffer */
export class SlippageError extends RebalanceError {
	constructor(
		message: string,
		public readonly netuid: number,
		options?: ErrorOptions,
	) {
		super(message, "SLIPPAGE_ERROR", options);
	}
}

/** MEV shield encryption key unavailable or expired */
export class MevShieldError extends RebalanceError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "MEV_SHIELD_ERROR", options);
	}
}

/** RPC call failed (timeout, connection lost, method error) */
export class RpcError extends RebalanceError {
	constructor(
		message: string,
		public readonly method: string,
		options?: ErrorOptions,
	) {
		super(message, "RPC_ERROR", options);
	}
}

/** Transaction submission or finalization failed */
export class TransactionError extends RebalanceError {
	constructor(
		message: string,
		public readonly txHash: string | null = null,
		options?: ErrorOptions,
	) {
		super(message, "TRANSACTION_ERROR", options);
	}
}

/** Proxy account signing or key derivation failed */
export class SigningError extends RebalanceError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "SIGNING_ERROR", options);
	}
}

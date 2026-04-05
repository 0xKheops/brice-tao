/**
 * Suppress noisy but harmless `RpcError: Method not found` (code -32601)
 * warnings that polkadot-api prints to the console.
 *
 * ## Why these errors happen
 *
 * polkadot-api uses the new Substrate JSON-RPC spec which includes
 * `archive_v1_*` methods. When block processing falls behind and a block gets
 * "unpinned" from the chainHead subscription, polkadot-api's `withArchive`
 * wrapper (in `@polkadot-api/observable-client`) automatically falls back to
 * `archive_v1_storage` / `archive_v1_call` etc. Bittensor subtensor nodes
 * **do not implement** these archive methods, so the fallback returns -32601.
 * The library then `console.warn()`s the error before re-throwing the original
 * `BlockNotPinnedError`, which our runner handles correctly.
 *
 * A secondary source is the chainHead follow retry handler in
 * `@polkadot-api/observable-client` — it `console.warn()`s when a
 * `chainHead_v1_follow` call fails during WebSocket endpoint failover.
 *
 * ## Why suppression is safe
 *
 * - Only suppresses `RpcError` with code `-32601` — all other warnings/errors
 *   pass through unchanged.
 * - Our runner code already handles the resulting `BlockNotPinnedError` and
 *   `RpcError` exceptions via `isBlockNotPinnedError()` and
 *   `isTransientRpcError()` in the momentum-stoploss runner.
 * - The suppressed errors are purely informational noise from polkadot-api's
 *   internal fallback logic — no user-visible functionality is affected.
 *
 * ## Upstream context
 *
 * There is no polkadot-api configuration option to disable the archive
 * fallback or suppress these console messages. The `console.warn()` is
 * hardcoded in `@polkadot-api/observable-client/src/utils/with-archive.ts`.
 *
 * @see https://github.com/polkadot-api/polkadot-api — polkadot-api repository
 */
export function suppressRpcNoise(): void {
	const isRpcMethodNotFound = (arg: unknown): boolean =>
		arg instanceof Error &&
		arg.name === "RpcError" &&
		"code" in arg &&
		(arg as { code: number }).code === -32601;

	for (const method of ["warn", "error"] as const) {
		const original = console[method];
		console[method] = (...args: unknown[]) => {
			if (args.some(isRpcMethodNotFound)) return;
			original.apply(console, args);
		};
	}
}

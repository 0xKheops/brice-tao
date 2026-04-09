/** Result of a single Proxy.ProxyExecuted event */
export interface ProxyResult {
	ok: boolean;
	error?: string;
}

/**
 * Extract ProxyExecuted results from a list of events.
 * Works with both raw finalized events and System.Events records.
 *
 * @param events - Array of event-like objects
 * @param getEvent - Accessor to extract the {type, value} from each element
 * @param formatError - Optional formatter for dispatch errors
 */
export function extractProxyResults<T>(
	events: T[],
	getEvent: (e: T) => { type: string; value: unknown },
	formatError?: (dispatchError: unknown) => string,
): ProxyResult[] {
	const results: ProxyResult[] = [];

	for (const item of events) {
		const event = getEvent(item);
		if (event.type !== "Proxy") continue;

		const proxyValue = event.value;
		if (
			typeof proxyValue !== "object" ||
			proxyValue === null ||
			!("type" in proxyValue)
		) {
			continue;
		}
		const typed = proxyValue as { type: string; value?: unknown };
		if (typed.type !== "ProxyExecuted") continue;

		const execValue = typed.value;
		if (
			typeof execValue !== "object" ||
			execValue === null ||
			!("result" in execValue)
		) {
			continue;
		}
		const execResult = (
			execValue as { result: { success: boolean; value?: unknown } }
		).result;

		if (execResult.success) {
			results.push({ ok: true });
		} else {
			const errorMsg = formatError
				? formatError(execResult.value)
				: `Proxied call failed: ${JSON.stringify(execResult.value)}`;
			results.push({ ok: false, error: errorMsg });
		}
	}

	return results;
}

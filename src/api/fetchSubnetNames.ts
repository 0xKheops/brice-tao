import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";

/**
 * Fetch on-chain subnet names for all registered subnets.
 * Returns a Map of netuid → human-readable name.
 *
 * This is a lightweight helper for scripts that only need subnet
 * metadata — strategies should use their own richer fetch functions.
 */
export async function fetchSubnetNames(
	api: TypedApi<typeof bittensor>,
): Promise<Map<number, string>> {
	const dynamicInfos =
		await api.apis.SubnetInfoRuntimeApi.get_all_dynamic_info();

	const decoder = new TextDecoder();
	const names = new Map<number, string>();

	for (const info of dynamicInfos) {
		if (info === undefined) continue;
		const name = decoder.decode(new Uint8Array(info.subnet_name)).trim();
		names.set(info.netuid, name);
	}

	return names;
}

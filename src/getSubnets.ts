import type { bittensor } from "@polkadot-api/descriptors";
import type { TypedApi } from "polkadot-api";

export type RegistrationStatus = "active" | "inactive" | "prune_target";

export interface SubnetInfo {
	netuid: number;
	owner: string;
	name: string;
	registrationStatus: RegistrationStatus;
}

export async function getSubnets(
	api: TypedApi<typeof bittensor>,
): Promise<SubnetInfo[]> {
	const [allSubnets, pruneTarget] = await Promise.all([
		api.apis.SubnetInfoRuntimeApi.get_subnets_info_v2(),
		api.apis.SubnetInfoRuntimeApi.get_subnet_to_prune(),
	]);

	const activeNetuids = new Set<number>();
	const subnets: SubnetInfo[] = [];

	for (const s of allSubnets) {
		if (s === undefined) continue;
		activeNetuids.add(s.netuid);
		subnets.push({
			netuid: s.netuid,
			owner: s.owner,
			name: s.identity ? new TextDecoder().decode(s.identity.subnet_name) : "",
			registrationStatus: s.netuid === pruneTarget ? "prune_target" : "active",
		});
	}

	const maxNetuid = Math.max(...activeNetuids, 0);
	for (let i = 0; i <= maxNetuid; i++) {
		if (!activeNetuids.has(i)) {
			subnets.push({
				netuid: i,
				owner: "",
				name: "",
				registrationStatus: "inactive",
			});
		}
	}

	subnets.sort((a, b) => a.netuid - b.netuid);
	return subnets;
}

export function printSubnets(subnets: SubnetInfo[]): void {
	const grouped = Object.groupBy(subnets, (s) => s.registrationStatus);

	for (const status of ["active", "prune_target", "inactive"] as const) {
		const list = grouped[status] ?? [];
		console.log(`\n${status} (${list.length}):`);
		if (list.length === 0) {
			console.log("  (none)");
			continue;
		}
		for (const s of list) {
			const name = s.name ? ` — ${s.name}` : "";
			console.log(`  SN${s.netuid.toString().padStart(3, " ")}${name}`);
		}
	}
}

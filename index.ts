import { bittensor } from "@polkadot-api/descriptors";
import { createWsClient } from "polkadot-api/ws";
import { Sn45Api } from "./src/api/generated/Sn45Api.ts";
import { getBalances, printBalances } from "./src/getBalances.ts";
import {
	getMostProfitableSubnets,
	printMomentumRanking,
} from "./src/getMostProfitableSubnets.ts";
import { getSubnets, printSubnets } from "./src/getSubnets.ts";

const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const coldkey = process.env.COLDKEY_ADDRESS;
const sn45ApiKey = process.env.SN45_API_KEY;

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!coldkey) throw new Error("COLDKEY_ADDRESS is not set");
if (!sn45ApiKey) throw new Error("SN45_API_KEY is not set");

const client = createWsClient(wsEndpoints);
const sn45 = new Sn45Api({
	baseUrl: "https://sn45api.talisman.xyz",
	baseApiParams: { headers: { "X-API-Key": sn45ApiKey } },
});

try {
	const api = client.getTypedApi(bittensor);
	const [balances, subnets, profitable] = await Promise.all([
		getBalances(api, coldkey),
		getSubnets(api),
		getMostProfitableSubnets(sn45),
	]);
	printBalances(coldkey, balances);
	printSubnets(subnets);
	printMomentumRanking(profitable);
} finally {
	client.destroy();
}

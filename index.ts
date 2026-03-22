import { bittensor } from "@polkadot-api/descriptors";
import { createWsClient } from "polkadot-api/ws";
import { getBalances, printBalances } from "./src/getBalances.ts";

const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
const coldkey = process.env.COLDKEY_ADDRESS;

if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
if (!coldkey) throw new Error("COLDKEY_ADDRESS is not set");

const client = createWsClient(wsEndpoints);

try {
	const api = client.getTypedApi(bittensor);
	const balances = await getBalances(api, coldkey);
	printBalances(coldkey, balances);
} finally {
	client.destroy();
}

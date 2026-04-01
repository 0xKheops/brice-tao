import {
	bittensor,
	getMetadata as getDescriptorsMetadata,
} from "@polkadot-api/descriptors";
import type { PolkadotClient, TypedApi } from "polkadot-api";
import { createWsClient } from "polkadot-api/ws";

const CACHE_DIR = ".papi/cache";

const setMetadata = (codeHash: string, value: Uint8Array) => {
	Bun.write(Bun.file(`${CACHE_DIR}/${codeHash}.bin`), value);
};

const getMetadata = async (codeHash: string) => {
	const file = Bun.file(`${CACHE_DIR}/${codeHash}.bin`);
	if (await file.exists()) return new Uint8Array(await file.arrayBuffer());

	const metadata = await getDescriptorsMetadata(codeHash);
	if (metadata) setMetadata(codeHash, metadata);
	return metadata;
};

type Api = TypedApi<typeof bittensor>;

export interface BittensorClient {
	client: PolkadotClient;
	api: Api;
}

export function createBittensorClient(wsEndpoints: string[]): BittensorClient {
	const client = createWsClient(wsEndpoints, { getMetadata, setMetadata });
	const api = client.getTypedApi(bittensor);
	return { client, api };
}

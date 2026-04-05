export interface Env {
	wsEndpoints: string[];
	archiveWsEndpoints: string[];
	coldkey: string;

	proxyMnemonic: string;
	validatorHotkey: string | undefined;
	discordWebhookUrl: string | undefined;
	strategy: string | undefined;
	leaderAddress: string | undefined;
}

export function loadEnv(): Env {
	const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
	const archiveWsEndpoints = process.env.ARCHIVE_WS_ENDPOINT?.split(",") ?? [];
	const coldkey = process.env.COLDKEY_ADDRESS;
	const proxyMnemonic = process.env.PROXY_MNEMONIC;
	const validatorHotkey = process.env.VALIDATOR_HOTKEY;
	const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
	const strategy = process.env.STRATEGY;
	const leaderAddress = process.env.LEADER_ADDRESS;

	if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
	if (!coldkey) throw new Error("COLDKEY_ADDRESS is not set");
	if (!proxyMnemonic) throw new Error("PROXY_MNEMONIC is not set");
	return {
		wsEndpoints,
		archiveWsEndpoints,
		coldkey,
		proxyMnemonic,
		validatorHotkey,
		discordWebhookUrl: discordWebhookUrl || undefined,
		strategy,
		leaderAddress,
	};
}

export interface Env {
	wsEndpoints: string[];
	coldkey: string;
	sn45ApiKey: string;
	proxyMnemonic: string;
	validatorHotkey: string | undefined;
	discordWebhookUrl: string;
}

export function loadEnv(): Env {
	const wsEndpoints = process.env.WS_ENDPOINT?.split(",") ?? [];
	const coldkey = process.env.COLDKEY_ADDRESS;
	const sn45ApiKey = process.env.SN45_API_KEY;
	const proxyMnemonic = process.env.PROXY_MNEMONIC;
	const validatorHotkey = process.env.VALIDATOR_HOTKEY;
	const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

	if (!wsEndpoints.length) throw new Error("WS_ENDPOINT is not set");
	if (!coldkey) throw new Error("COLDKEY_ADDRESS is not set");
	if (!sn45ApiKey) throw new Error("SN45_API_KEY is not set");
	if (!proxyMnemonic) throw new Error("PROXY_MNEMONIC is not set");
	if (!discordWebhookUrl) throw new Error("DISCORD_WEBHOOK_URL is not set");

	return {
		wsEndpoints,
		coldkey,
		sn45ApiKey,
		proxyMnemonic,
		validatorHotkey,
		discordWebhookUrl,
	};
}

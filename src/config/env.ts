import { ConfigError } from "../errors.ts";

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

	if (!wsEndpoints.length) throw new ConfigError("WS_ENDPOINT is not set");
	for (const ep of wsEndpoints) {
		if (!/^wss?:\/\/.+/.test(ep)) {
			throw new ConfigError(`Invalid WS_ENDPOINT URL: ${ep}`);
		}
	}
	for (const ep of archiveWsEndpoints) {
		if (!/^wss?:\/\/.+/.test(ep)) {
			throw new ConfigError(`Invalid ARCHIVE_WS_ENDPOINT URL: ${ep}`);
		}
	}
	if (!coldkey) throw new ConfigError("COLDKEY_ADDRESS is not set");
	if (!/^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(coldkey)) {
		throw new ConfigError(
			`Invalid COLDKEY_ADDRESS format (expected SS58): ${coldkey}`,
		);
	}
	if (!proxyMnemonic) throw new ConfigError("PROXY_MNEMONIC is not set");
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

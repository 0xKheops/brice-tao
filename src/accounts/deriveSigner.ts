import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
	entropyToMiniSecret,
	mnemonicToEntropy,
	ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import type { PolkadotSigner } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { SigningError } from "../errors.ts";

export interface DerivedAccount {
	signer: PolkadotSigner;
	address: string;
}

const VALID_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

export function deriveSigner(mnemonic: string): DerivedAccount {
	const words = mnemonic.trim().split(/\s+/);
	if (!VALID_WORD_COUNTS.has(words.length)) {
		throw new SigningError(
			`Invalid mnemonic: expected 12/15/18/21/24 words, got ${words.length}`,
		);
	}

	try {
		const miniSecret = entropyToMiniSecret(mnemonicToEntropy(mnemonic));
		const derive = sr25519CreateDerive(miniSecret);
		const keyPair = derive("");
		const signer = getPolkadotSigner(
			keyPair.publicKey,
			"Sr25519",
			keyPair.sign,
		);
		const address = ss58Address(keyPair.publicKey, 42);
		return { signer, address };
	} catch (err) {
		throw new SigningError(
			`Failed to derive signer from mnemonic: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
}

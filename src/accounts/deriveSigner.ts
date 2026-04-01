import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
	entropyToMiniSecret,
	mnemonicToEntropy,
	ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import type { PolkadotSigner } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";

export interface DerivedAccount {
	signer: PolkadotSigner;
	address: string;
}

export function deriveSigner(mnemonic: string): DerivedAccount {
	const miniSecret = entropyToMiniSecret(mnemonicToEntropy(mnemonic));
	const derive = sr25519CreateDerive(miniSecret);
	const keyPair = derive("");
	const signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);
	const address = ss58Address(keyPair.publicKey, 42);
	return { signer, address };
}

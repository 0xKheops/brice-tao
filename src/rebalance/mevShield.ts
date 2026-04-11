import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import type { bittensor } from "@polkadot-api/descriptors";
import { Twox128 } from "@polkadot-api/substrate-bindings";
import { MlKem768 } from "mlkem";
import type {
	PolkadotSigner,
	TxFinalizedPayload,
	TypedApi,
} from "polkadot-api";

export async function getNextKey(
	api: TypedApi<typeof bittensor>,
): Promise<Uint8Array | undefined> {
	const key = await api.query.MevShield.NextKey.getValue({ at: "best" });
	return key ?? undefined;
}

async function encryptTransaction(
	plaintext: Uint8Array,
	publicKey: Uint8Array,
): Promise<Uint8Array> {
	const keyHash = Twox128(publicKey); // 16 bytes

	const mlKem = new MlKem768();
	const [kemCt, sharedSecret] = await mlKem.encap(publicKey);

	const nonce = randomBytes(24);
	const chacha = xchacha20poly1305(sharedSecret, nonce);
	const aeadCt = chacha.encrypt(plaintext);

	// Wire format: key_hash(16) || kem_len(2 LE) || kem_ct || nonce(24) || aead_ct
	const kemLenBytes = new Uint8Array(2);
	new DataView(kemLenBytes.buffer).setUint16(0, kemCt.length, true);

	const result = new Uint8Array(
		keyHash.length + 2 + kemCt.length + nonce.length + aeadCt.length,
	);
	let offset = 0;
	result.set(keyHash, offset);
	offset += keyHash.length;
	result.set(kemLenBytes, offset);
	offset += 2;
	result.set(kemCt, offset);
	offset += kemCt.length;
	result.set(nonce, offset);
	offset += nonce.length;
	result.set(aeadCt, offset);
	return result;
}

export async function submitShieldedTx(
	api: TypedApi<typeof bittensor>,
	signer: PolkadotSigner,
	innerSignedExtrinsicBytes: Uint8Array,
	publicKey: Uint8Array,
	nonce: number,
): Promise<TxFinalizedPayload> {
	const ciphertext = await encryptTransaction(
		innerSignedExtrinsicBytes,
		publicKey,
	);

	const tx = api.tx.MevShield.submit_encrypted({ ciphertext });
	return tx.signAndSubmit(signer, {
		nonce,
		mortality: { mortal: true, period: 8 },
	});
}

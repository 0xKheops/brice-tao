import { beforeEach, describe, expect, it, vi } from "bun:test";

const Twox128Mock = vi.fn();
const randomBytesMock = vi.fn();
const xchacha20poly1305Mock = vi.fn();
const encapMock = vi.fn();
const MlKem768Mock = vi.fn();

vi.mock("@polkadot-api/substrate-bindings", () => ({
	Twox128: Twox128Mock,
}));

vi.mock("@noble/ciphers/utils.js", () => ({
	randomBytes: randomBytesMock,
}));

vi.mock("@noble/ciphers/chacha.js", () => ({
	xchacha20poly1305: xchacha20poly1305Mock,
}));

vi.mock("mlkem", () => ({
	MlKem768: MlKem768Mock,
}));

import { getNextKey, submitShieldedTx } from "./mevShield.ts";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("mevShield utilities", () => {
	it("returns undefined when NextKey storage is empty", async () => {
		const getValue = vi.fn().mockResolvedValue(null);
		const api = {
			query: { MevShield: { NextKey: { getValue } } },
		} as unknown as Parameters<typeof getNextKey>[0];

		const key = await getNextKey(api);

		expect(key).toBeUndefined();
		expect(getValue).toHaveBeenCalledWith({ at: "best" });
	});

	it("returns key bytes when NextKey storage is populated", async () => {
		const expected = Uint8Array.from([9, 8, 7, 6]);
		const getValue = vi.fn().mockResolvedValue(expected);
		const api = {
			query: { MevShield: { NextKey: { getValue } } },
		} as unknown as Parameters<typeof getNextKey>[0];

		const key = await getNextKey(api);

		expect(key).toEqual(expected);
	});

	it("builds encrypted payload in expected wire format and submits tx", async () => {
		const keyHash = new Uint8Array(16).fill(11);
		const kemCt = Uint8Array.from([21, 22, 23]);
		const sharedSecret = new Uint8Array(32).fill(31);
		const nonce = new Uint8Array(24).fill(7);
		const aeadCt = Uint8Array.from([41, 42]);
		const signer = {
			publicKey: new Uint8Array(32),
			type: "sr25519",
			signTx: vi.fn(),
			signBytes: vi.fn(),
		};
		const submitResult = {
			txHash: "0xabc",
			ok: true,
			events: [],
			block: { hash: "0xdef", number: 1, index: 0 },
		};
		const encryptMock = vi.fn().mockReturnValue(aeadCt);
		const signAndSubmit = vi.fn().mockResolvedValue(submitResult);
		const submitEncrypted = vi.fn(() => ({ signAndSubmit }));
		const api = {
			tx: { MevShield: { submit_encrypted: submitEncrypted } },
		} as unknown as Parameters<typeof submitShieldedTx>[0];

		Twox128Mock.mockReturnValue(keyHash);
		randomBytesMock.mockReturnValue(nonce);
		xchacha20poly1305Mock.mockReturnValue({ encrypt: encryptMock });
		encapMock.mockResolvedValue([kemCt, sharedSecret]);
		MlKem768Mock.mockImplementation(() => ({ encap: encapMock }));

		const innerSignedExtrinsic = Uint8Array.from([1, 2, 3, 4]);
		const publicKey = Uint8Array.from([99, 100]);
		const nonceIndex = 12;

		const result = await submitShieldedTx(
			api,
			signer as unknown as Parameters<typeof submitShieldedTx>[1],
			innerSignedExtrinsic,
			publicKey,
			nonceIndex,
		);

		const expectedCiphertext = Uint8Array.from([
			...keyHash,
			3,
			0,
			...kemCt,
			...nonce,
			...aeadCt,
		]);

		expect(result.txHash).toBe(submitResult.txHash);
		expect(result.block).toEqual(submitResult.block);
		expect(encapMock).toHaveBeenCalledWith(publicKey);
		expect(Twox128Mock).toHaveBeenCalledWith(publicKey);
		expect(xchacha20poly1305Mock).toHaveBeenCalledWith(sharedSecret, nonce);
		expect(encryptMock).toHaveBeenCalledWith(innerSignedExtrinsic);
		expect(submitEncrypted).toHaveBeenCalledWith({
			ciphertext: expectedCiphertext,
		});
		expect(signAndSubmit).toHaveBeenCalledWith(signer, {
			nonce: nonceIndex,
			mortality: { mortal: true, period: 8 },
		});
	});

	it("encodes KEM ciphertext length as little-endian uint16", async () => {
		const keyHash = new Uint8Array(16).fill(1);
		const kemCt = new Uint8Array(300).fill(2);
		const sharedSecret = new Uint8Array(32).fill(3);
		const nonce = new Uint8Array(24).fill(4);
		const aeadCt = Uint8Array.from([5]);
		const signAndSubmit = vi.fn().mockResolvedValue({ ok: true });
		const submitEncrypted = vi.fn(() => ({ signAndSubmit }));
		const api = {
			tx: { MevShield: { submit_encrypted: submitEncrypted } },
		} as unknown as Parameters<typeof submitShieldedTx>[0];

		Twox128Mock.mockReturnValue(keyHash);
		randomBytesMock.mockReturnValue(nonce);
		xchacha20poly1305Mock.mockReturnValue({
			encrypt: vi.fn().mockReturnValue(aeadCt),
		});
		encapMock.mockResolvedValue([kemCt, sharedSecret]);
		MlKem768Mock.mockImplementation(() => ({ encap: encapMock }));

		await submitShieldedTx(
			api,
			{
				publicKey: new Uint8Array(32),
				type: "sr25519",
				signTx: vi.fn(),
				signBytes: vi.fn(),
			} as unknown as Parameters<typeof submitShieldedTx>[1],
			Uint8Array.from([8]),
			Uint8Array.from([9]),
			0,
		);

		const submitted = submitEncrypted.mock.calls.at(0)?.at(0) as
			| { ciphertext: Uint8Array }
			| undefined;
		expect(submitted).toBeDefined();
		if (!submitted) {
			throw new Error("expected encrypted payload to be submitted");
		}
		const ciphertext = submitted.ciphertext;
		expect(ciphertext[16]).toBe(44);
		expect(ciphertext[17]).toBe(1);
		expect(ciphertext.length).toBe(
			16 + 2 + kemCt.length + nonce.length + aeadCt.length,
		);
	});
});

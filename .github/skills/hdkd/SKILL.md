---
name: hdkd
description: "@polkadot-labs/hdkd domain knowledge: hierarchical deterministic key derivation for Polkadot/Substrate, Sr25519/Ed25519/ECDSA signers from mnemonics, Substrate BIP39 derivation, SURI parsing, SS58 addresses. USE FOR: any task involving key derivation from mnemonics, creating signers for polkadot-api, managing keypairs, or deriving accounts for Substrate chains."
---

# @polkadot-labs/hdkd — Domain Knowledge

Hierarchical Deterministic Key Derivation (HDKD) for the Polkadot ecosystem. Supports Sr25519, Ed25519, and ECDSA signature schemes. Used to create `PolkadotSigner` instances for `polkadot-api`.

Two packages:
- `@polkadot-labs/hdkd` — key derivation functions (`createDerive` per curve)
- `@polkadot-labs/hdkd-helpers` — mnemonic/entropy utilities, curve primitives, SS58 encoding

---

## Installation

```bash
bun add @polkadot-labs/hdkd @polkadot-labs/hdkd-helpers
```

---

## Key Derivation Functions

Each returns a `derive(path) → KeyPair` function:

| Export | Signature Scheme | Package |
|--------|-----------------|---------|
| `sr25519CreateDerive` | Sr25519 (Schnorrkel) | `@polkadot-labs/hdkd` |
| `ed25519CreateDerive` | Ed25519 | `@polkadot-labs/hdkd` |
| `ecdsaCreateDerive` | ECDSA (secp256k1) | `@polkadot-labs/hdkd` |

### Types

```typescript
type CreateDeriveFn = (seed: Hex) => (path: string) => KeyPair

type KeyPair = {
  publicKey: Uint8Array
  sign: (message: Hex) => Uint8Array
}
```

---

## Helper Utilities (`@polkadot-labs/hdkd-helpers`)

| Export | Purpose |
|--------|---------|
| `mnemonicToEntropy(mnemonic, wordlist?)` | Convert mnemonic phrase to entropy bytes |
| `entropyToMiniSecret(entropy, password?)` | Convert entropy to 32-byte mini secret (Substrate BIP39) |
| `mnemonicToMiniSecret(mnemonic, password?)` | Shorthand for the above two combined |
| `DEV_PHRASE` | Dev mnemonic: `"bottom drive obey lake curtain smoke basket hold race lonely fit walk"` |
| `DEV_MINI_SECRET` | Pre-computed mini secret for `DEV_PHRASE` |
| `parseSuri(suri)` | Parse a Substrate URI (`phrase//hard/soft///password`) |
| `sr25519` / `ed25519` / `ecdsa` | Curve implementations (`getPublicKey`, `sign`, `verify`) |
| `accountId(publicKey)` | Derive AccountId (blake2b-256 for 33-byte keys, passthrough for 32-byte) |
| `ss58Address(publicKey, prefix?)` | Encode public key as SS58 address |

### Substrate BIP39 vs Standard BIP39

Substrate uses a **non-standard** BIP39 derivation. Instead of `PBKDF2(mnemonic → seed)`, it does `PBKDF2(entropy → miniSecret)`:

```typescript
// entropy → PBKDF2(sha512, entropy, "mnemonic" + password, 2048 iterations) → first 32 bytes
```

Always use `entropyToMiniSecret` (or `mnemonicToMiniSecret`) — never standard BIP39 seed derivation.

---

## Derivation Paths

- `""` — root account (no derivation)
- `"//hard"` — hard derivation (`//` prefix, cannot derive child from parent public key)
- `"/soft"` — soft derivation (`/` prefix)
- `"//hard/soft"` — chained derivation
- `"//Alice"`, `"//Bob"` — dev accounts

---

## `withNetworkAccount` — SS58 Address Helper

Extends a `KeyPair` with network-specific address information:

```typescript
import { withNetworkAccount } from "@polkadot-labs/hdkd"

const keyPair = derive("//Alice")
const account = withNetworkAccount(keyPair, 42) // prefix 42 = generic Substrate
// account.accountId — Uint8Array
// account.ss58Address — string ("5GrwvaEF...")
// account.ss58PublicKey — string
```

---

## Complete Examples

### Sr25519 Signer from Mnemonic (Most Common)

```typescript
import { getPolkadotSigner } from "polkadot-api/signer"
import { sr25519CreateDerive } from "@polkadot-labs/hdkd"
import {
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers"

const miniSecret = entropyToMiniSecret(mnemonicToEntropy(MNEMONIC))
const derive = sr25519CreateDerive(miniSecret)
const keyPair = derive("//default")

const signer = getPolkadotSigner(
  keyPair.publicKey,
  "Sr25519",
  keyPair.sign,
)
```

### Dev Accounts (Alice/Bob/Charlie)

```typescript
import { sr25519CreateDerive } from "@polkadot-labs/hdkd"
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers"
import { getPolkadotSigner } from "polkadot-api/signer"

const miniSecret = entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE))
const derive = sr25519CreateDerive(miniSecret)

const alice = derive("//Alice")
const bob = derive("//Bob")

const aliceSigner = getPolkadotSigner(alice.publicKey, "Sr25519", alice.sign)
```

### Ed25519 from Mnemonic

```typescript
import { ed25519CreateDerive } from "@polkadot-labs/hdkd"
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers"
import { getPolkadotSigner } from "polkadot-api/signer"

const miniSecret = entropyToMiniSecret(mnemonicToEntropy(MNEMONIC))
const derive = ed25519CreateDerive(miniSecret)
const keyPair = derive("//myaccount")

const signer = getPolkadotSigner(keyPair.publicKey, "Ed25519", keyPair.sign)
```

### Ed25519 from Raw Private Key (No HDKD)

```typescript
import { getPolkadotSigner } from "polkadot-api/signer"
import { ed25519 } from "@noble/curves/ed25519.js"

const SECRET_KEY = new Uint8Array(32)

const signer = getPolkadotSigner(
  ed25519.getPublicKey(SECRET_KEY),
  "Ed25519",
  (input) => ed25519.sign(input, SECRET_KEY),
)
```

---

## Bittensor-Specific Derivation

Bittensor uses Sr25519. Common paths:

- `""` — root account
- `"//hotkey"` — hard-derived hotkey
- `"//coldkey"` — hard-derived coldkey
- `"//0"`, `"//1"` — indexed accounts

---

## References

- Repository: https://github.com/polkadot-labs/hdkd
- PAPI signer docs: https://papi.how/signers/raw

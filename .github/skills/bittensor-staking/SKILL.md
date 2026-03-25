---
name: bittensor-staking
description: "Bittensor staking domain knowledge sourced from opentensor/subtensor: staking, unstaking, swaps, transfers, moves, balance queries, swap simulation, MEV Shield, and all TypeScript extrinsic shapes via polkadot-api. USE FOR: any task involving TAO/Alpha staking, unstaking, cross-subnet moves, swap estimation, slippage protection, or MEV-shielded transactions on the Bittensor network."
---

# Bittensor Staking — Domain Knowledge

Comprehensive reference for staking operations on the Bittensor network (pallet `SubtensorModule`) using `polkadot-api`. All TypeScript shapes come from the subtensor e2e test suite.

---

## Key Concepts

- **TAO**: The native token of Bittensor (1 TAO = 1e9 RAO)
- **Alpha**: Subnet-specific stake token. Staking TAO converts it to Alpha on a specific subnet
- **netuid**: Subnet identifier (u16). Root subnet is `0`
- **hotkey**: Validator key that receives delegation
- **coldkey**: Owner key that controls funds and signs transactions
- **U64F64**: Fixed-point format used for raw stake shares in storage

### Unit Helper

```typescript
const TAO = 1_000_000_000n
function tao(value: number): bigint {
  return TAO * BigInt(value)
}
```

---

## Querying Balances & Stake

### Free Balance (TAO)

```typescript
const account = await api.query.System.Account.getValue(ss58Address)
const freeBalance: bigint = account.data.free
```

### Stake (Alpha) for a hotkey/coldkey/netuid

Returns the integer part of the U64F64 value:

```typescript
function u64f64ToInt(raw: bigint): bigint {
  return raw >> 64n
}

const raw = await api.query.SubtensorModule.Alpha.getValue(hotkey, coldkey, netuid)
const stake = u64f64ToInt(raw)
```

### Raw Stake (U64F64)

Use this when you need the raw value for extrinsics like `remove_stake` or `transfer_stake`:

```typescript
const stakeRaw: bigint = await api.query.SubtensorModule.Alpha.getValue(hotkey, coldkey, netuid)
```

### StakeInfo via Runtime API

Returns detailed stake info including emission data:

```typescript
const info = await api.apis.StakeInfoRuntimeApi.get_stake_info_for_hotkey_coldkey_netuid(
  hotkeySs58,
  coldkeySs58,
  netuid,
)
// info: { hotkey, coldkey, netuid, stake, locked, emission, tao_emission, drain, is_registered }
```

Bulk query for a coldkey:

```typescript
const allStakes = await api.apis.StakeInfoRuntimeApi.get_stake_info_for_coldkey(coldkeySs58)
```

### Subnet Pool Data

```typescript
const subnetTao = await api.query.SubtensorModule.SubnetTAO.getValue(netuid)       // TAO reserve
const subnetAlphaIn = await api.query.SubtensorModule.SubnetAlphaIn.getValue(netuid) // Alpha reserve
const totalHotkeyAlpha = await api.query.SubtensorModule.TotalHotkeyAlpha.getValue(hotkey, netuid)
```

---

## Minimum Stake & Rate Limits

- **DefaultMinStake**: On-chain minimum stake amount enforced in `validate_add_stake`
- **NominatorMinRequiredStake**: Factor multiplied by `DefaultMinStake` for nominations (~0.1 TAO with factor 100_000_000)
- **StakeThreshold**: Minimum total stake for validator operations
- **Staking Fee**: ~0.3% (factor `0.997` on stake amount)
- **Rate Limiting**: `StakingOperationRateLimiter` per (hotkey, coldkey, netuid) — requests too fast will be rejected

---

## Staking Extrinsics

### Add Stake (TAO → Alpha)

```typescript
const tx = api.tx.SubtensorModule.add_stake({
  hotkey: hotkeyAddress,
  netuid: netuid,
  amount_staked: tao(100),
})
await tx.signAndSubmit(signer)
```

### Add Stake with Price Limit

Protects against slippage by specifying a maximum price:

```typescript
const tx = api.tx.SubtensorModule.add_stake_limit({
  hotkey: hotkeyAddress,
  netuid: netuid,
  amount_staked: tao(100),
  limit_price: limitPriceRao,    // max price in RAO
  allow_partial: true,           // allow partial fill if limit hit
})
await tx.signAndSubmit(signer)
```

### Remove Stake (Alpha → TAO)

Amount is in **Alpha units** (use raw U64F64 value):

```typescript
const stakeRaw = await api.query.SubtensorModule.Alpha.getValue(hotkey, coldkey, netuid)
const unstakeAmount = stakeRaw / 2n  // unstake half

const tx = api.tx.SubtensorModule.remove_stake({
  hotkey: hotkeyAddress,
  netuid: netuid,
  amount_unstaked: unstakeAmount,
})
await tx.signAndSubmit(signer)
```

### Remove Stake with Price Limit

```typescript
const tx = api.tx.SubtensorModule.remove_stake_limit({
  hotkey: hotkeyAddress,
  netuid: netuid,
  amount_unstaked: unstakeAmount,
  limit_price: limitPriceRao,
  allow_partial: true,
})
await tx.signAndSubmit(signer)
```

### Remove All Stake with Optional Price Limit

Unstakes everything on a given subnet:

```typescript
const tx = api.tx.SubtensorModule.remove_stake_full_limit({
  hotkey: hotkeyAddress,
  netuid: netuid,
  limit_price: limitPriceRao,  // optional price protection
})
await tx.signAndSubmit(signer)
```

### Unstake All (All Subnets)

Removes all stake from all subnets for a hotkey, converting back to TAO:

```typescript
const tx = api.tx.SubtensorModule.unstake_all({
  hotkey: hotkeyAddress,
})
await tx.signAndSubmit(signer)
```

### Unstake All Alpha (Non-Root Only)

Removes alpha stake from all dynamic subnets (not root), moving it to root:

```typescript
const tx = api.tx.SubtensorModule.unstake_all_alpha({
  hotkey: hotkeyAddress,
})
await tx.signAndSubmit(signer)
```

---

## Move, Transfer & Swap Stake

### Move Stake (Same Coldkey, Different Hotkey/Subnet)

```typescript
const tx = api.tx.SubtensorModule.move_stake({
  origin_hotkey: originHotkeyAddress,
  destination_hotkey: destinationHotkeyAddress,
  origin_netuid: originNetuid,
  destination_netuid: destinationNetuid,
  alpha_amount: alphaAmount,
})
await tx.signAndSubmit(signer)
```

### Transfer Stake (Different Coldkey)

```typescript
const tx = api.tx.SubtensorModule.transfer_stake({
  destination_coldkey: destinationColdkeyAddress,
  hotkey: hotkeyAddress,
  origin_netuid: originNetuid,
  destination_netuid: destinationNetuid,
  alpha_amount: alphaAmount,
})
await tx.signAndSubmit(signer)
```

### Swap Stake (Same Hotkey + Coldkey, Different Subnet)

```typescript
const tx = api.tx.SubtensorModule.swap_stake({
  hotkey: hotkeyAddress,
  origin_netuid: originNetuid,
  destination_netuid: destinationNetuid,
  alpha_amount: alphaAmount,
})
await tx.signAndSubmit(signer)
```

### Swap Stake with Price Limit

```typescript
const tx = api.tx.SubtensorModule.swap_stake_limit({
  hotkey: hotkeyAddress,
  origin_netuid: originNetuid,
  destination_netuid: destinationNetuid,
  alpha_amount: alphaAmount,
  limit_price: limitPriceRao,
  allow_partial: true,
})
await tx.signAndSubmit(signer)
```

---

## Swap Simulation (Estimate)

Use runtime API calls to simulate swaps without executing them. Returns estimated amounts, fees, and slippage.

### Simulate TAO → Alpha

```typescript
const result = await api.apis.SwapApi.sim_swap_tao_for_alpha(netuid, taoAmount)
// result: { tao_amount, alpha_amount, tao_fee, alpha_fee, tao_slippage, alpha_slippage }
```

### Simulate Alpha → TAO

```typescript
const result = await api.apis.SwapApi.sim_swap_alpha_for_tao(netuid, alphaAmount)
// result: { tao_amount, alpha_amount, tao_fee, alpha_fee, tao_slippage, alpha_slippage }
```

### Alpha Price

The current price of Alpha for a subnet (ratio of TAO reserve to Alpha reserve):

```typescript
const subnetTao = await api.query.SubtensorModule.SubnetTAO.getValue(netuid)
const subnetAlphaIn = await api.query.SubtensorModule.SubnetAlphaIn.getValue(netuid)
// price ≈ subnetTao / subnetAlphaIn (concentrated liquidity AMM)
```

### Slippage Protection Strategy

1. Simulate the swap to get expected output and slippage
2. Set `limit_price` to your maximum acceptable price
3. Use `allow_partial: true` to get partial fills when the limit is hit
4. Use `add_stake_limit` / `remove_stake_limit` / `swap_stake_limit` variants

---

## Root Claims

### Claim Root Dividends

```typescript
const tx = api.tx.SubtensorModule.claim_root({
  subnets: [netuid1, netuid2],
})
await tx.signAndSubmit(signer)
```

### Query Root Claimable

```typescript
const claimable = await api.query.SubtensorModule.RootClaimable.getValue(hotkeyAddress)
// Map of netuid → claimable amount
```

### Root Claim Type

```typescript
// Get claim type: "Swap" | "Keep" | { type: "KeepSubnets", subnets: number[] }
const claimType = await api.query.SubtensorModule.RootClaimType.getValue(coldkeyAddress)

// Set claim type
const tx = api.tx.SubtensorModule.set_root_claim_type({
  claim_type: "Swap",  // or "Keep" or { KeepSubnets: [1, 2, 3] }
})
await tx.signAndSubmit(signer)
```

---

## MEV Shield (pallet-shield / MevShield)

Post-quantum encrypted transaction submission to prevent MEV (Miner Extractable Value). Uses **ML-KEM-768** (post-quantum KEM) + **XChaCha20-Poly1305** AEAD encryption.

### Dependencies

```
bun add mlkem @noble/ciphers @polkadot/util-crypto
```

### How It Works

1. Read `NextKey` from `api.query.MevShield.NextKey` (ML-KEM-768 public key, 1184 bytes)
2. Sign the inner extrinsic (increment nonce if using same account for wrapper)
3. Encrypt: ML-KEM encapsulate → XChaCha20-Poly1305 encrypt
4. Submit `api.tx.MevShield.submit_encrypted({ ciphertext })` with mortal era ≤ 8 blocks
5. Block author decrypts and includes inner extrinsic in the same block

### Key Rotation

Keys rotate every block:
- `NextKey` ← next-next author's key (user-facing, encrypt to this)
- `PendingKey` ← promoted from NextKey each block
- `CurrentKey` ← promoted from PendingKey each block

### Read NextKey

Query at `"best"` (not finalized) because keys rotate every block and finalized lags ~2 blocks:

```typescript
import { Binary } from "polkadot-api"
import { hexToU8a } from "@polkadot/util"

async function getNextKey(api: TypedApi<typeof subtensor>): Promise<Uint8Array | undefined> {
  const key = await api.query.MevShield.NextKey.getValue({ at: "best" })
  if (!key) return undefined
  if (key instanceof Binary) return key.asBytes()
  return hexToU8a(key as string)
}
```

### Encrypt Transaction

```typescript
import { MlKem768 } from "mlkem"
import { xchacha20poly1305 } from "@noble/ciphers/chacha"
import { randomBytes } from "@noble/ciphers/utils"
import { xxhashAsU8a } from "@polkadot/util-crypto"

async function encryptTransaction(
  plaintext: Uint8Array,
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  const keyHash = xxhashAsU8a(publicKey, 128)             // 16 bytes

  const mlKem = new MlKem768()
  const [kemCt, sharedSecret] = await mlKem.encap(publicKey)

  const nonce = randomBytes(24)                            // 24 bytes
  const chacha = xchacha20poly1305(sharedSecret, nonce)
  const aeadCt = chacha.encrypt(plaintext)

  // Wire format: key_hash(16) || kem_len(2 LE) || kem_ct || nonce(24) || aead_ct
  const kemLenBytes = new Uint8Array(2)
  new DataView(kemLenBytes.buffer).setUint16(0, kemCt.length, true)

  return new Uint8Array([...keyHash, ...kemLenBytes, ...kemCt, ...nonce, ...aeadCt])
}
```

### Submit Shielded Transaction

```typescript
import { Binary } from "polkadot-api"

async function submitShieldedTx(
  api: TypedApi<typeof subtensor>,
  client: PolkadotClient,
  signer: PolkadotSigner,
  innerSignedExtrinsicBytes: Uint8Array,
  publicKey: Uint8Array,
  nonce?: number,
): Promise<void> {
  const ciphertext = await encryptTransaction(innerSignedExtrinsicBytes, publicKey)

  const tx = api.tx.MevShield.submit_encrypted({
    ciphertext: Binary.fromBytes(ciphertext),
  })
  await tx.signAndSubmit(signer, {
    ...(nonce !== undefined ? { nonce } : {}),
    mortality: { mortal: true, period: 8 },
  })
}
```

### Complete MEV Shield Flow

```typescript
// 1. Read the next key
const nextKey = await getNextKey(api)
if (!nextKey) throw new Error("No NextKey available")

// 2. Get the current nonce
const nonce = await api.query.System.Account.getValue(senderAddress)
  .then(a => a.nonce)

// 3. Sign the inner extrinsic with nonce + 1
//    (nonce is used by the wrapper, nonce+1 by the inner tx)
const innerTxHex = await api.tx.SubtensorModule.add_stake({
  hotkey: hotkeyAddress,
  netuid: netuid,
  amount_staked: tao(100),
}).sign(signer, { nonce: nonce + 1 })

// 4. Encrypt and submit
const innerTxBytes = hexToU8a(innerTxHex)
await submitShieldedTx(api, client, signer, innerTxBytes, nextKey, nonce)
```

### Ciphertext Wire Format

```
key_hash(16) || kem_len(2 LE) || kem_ct(1088) || nonce(24) || aead_ct(variable)
```

- `key_hash`: `xxhash128(NextKey)` — 16 bytes
- `kem_len`: length of `kem_ct` as u16 little-endian — 2 bytes
- `kem_ct`: ML-KEM-768 ciphertext — 1088 bytes
- `nonce`: random XChaCha20 nonce — 24 bytes
- `aead_ct`: XChaCha20-Poly1305 ciphertext (plaintext + 16 byte tag)
- Max total: 8192 bytes

### Runtime Config

- `ShieldAnnounceAtMs: 7_000` — key announced at 7s into slot
- `ShieldGraceMs: 2_000` — old key accepted for 2s grace period
- `ShieldDecryptWindowMs: 3_000` — last 3s reserved for decrypt+execute

---

## Summary of Key Imports

```typescript
import { TypedApi, PolkadotClient, PolkadotSigner, Binary } from "polkadot-api"
import { subtensor, MultiAddress } from "@polkadot-api/descriptors"
import { MlKem768 } from "mlkem"
import { xchacha20poly1305 } from "@noble/ciphers/chacha"
import { randomBytes } from "@noble/ciphers/utils"
import { xxhashAsU8a } from "@polkadot/util-crypto"
import { hexToU8a } from "@polkadot/util"
```

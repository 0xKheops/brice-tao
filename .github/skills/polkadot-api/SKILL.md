---
name: polkadot-api
description: "polkadot-api (PAPI) v2 domain knowledge: client setup, typed API, providers, queries, transactions, events, constants, runtime calls, code generation CLI, and compatibility checks. USE FOR: any task involving Substrate/Polkadot chain interactions via polkadot-api — connecting to chains, querying storage, submitting extrinsics, watching blocks/events, or configuring the papi CLI."
---

# polkadot-api (PAPI) v2 — Domain Knowledge

TypeScript-first library for interacting with Substrate/Polkadot chains. Features light-client support, fully typed APIs generated from on-chain metadata, and a code-generation CLI (`papi`).

---

## Architecture Flow

1. **Code generation**: `papi add` downloads chain metadata → `papi generate` creates typed descriptors in `.papi/descriptors` → installed as `@polkadot-api/descriptors`
2. **Connection**: Create a `JsonRpcProvider` (WS or Smoldot) → pass to `createClient()`
3. **Typed interactions**: `client.getTypedApi(chainDescriptor)` → fully typed API for queries, transactions, events, constants, and runtime calls
4. **Signing**: Create a `PolkadotSigner` → pass to `tx.signAndSubmit(signer)`

---

## CLI & Code Generation (`papi`)

Available as `npx papi` or `bunx papi`.

### Adding a chain

```bash
# From a well-known chain name
npx papi add dot -n polkadot

# From a WebSocket URL
npx papi add bittensor -w wss://entrypoint-finney.opentensor.ai

# From a chain spec file
npx papi add mychain -c ./chain-spec.json

# Skip codegen (batch adds)
npx papi add chain1 -w wss://... --skip-codegen
npx papi add chain2 -w wss://... --skip-codegen
npx papi  # run codegen once
```

### Updating metadata

```bash
npx papi update            # all chains
npx papi update bittensor  # specific chain
```

### Generated output

- `.papi/polkadot-api.json` — config listing registered chains
- `.papi/metadata/<key>.scale` — SCALE-encoded metadata per chain
- `.papi/descriptors/` — local package installed as `@polkadot-api/descriptors`

### Importing descriptors

```typescript
import { bittensor } from "@polkadot-api/descriptors"
import { bittensor, MultiAddress } from "@polkadot-api/descriptors"
```

---

## Providers

### WebSocket Provider

```typescript
import { getWsProvider } from "polkadot-api/ws-provider"

const provider = getWsProvider("wss://entrypoint-finney.opentensor.ai")

// Multiple endpoints (auto-failover)
const provider = getWsProvider([
  "wss://entrypoint-finney.opentensor.ai",
  "wss://fallback.example.com",
])
```

### Smoldot (Light Client) Provider

```typescript
import { getSmProvider } from "polkadot-api/sm-provider"
import { chainSpec } from "polkadot-api/chains/polkadot"
import { start } from "polkadot-api/smoldot"

const smoldot = start()
const chain = await smoldot.addChain({ chainSpec })
const provider = getSmProvider(chain)
```

---

## Creating a Client

```typescript
import { createClient } from "polkadot-api"
import { getWsProvider } from "polkadot-api/ws-provider"

const client = createClient(
  getWsProvider("wss://entrypoint-finney.opentensor.ai")
)
```

### PolkadotClient API

| Method | Return Type | Description |
|--------|-------------|-------------|
| `getChainSpecData()` | `Promise<{name, genesisHash, properties}>` | Chain spec data |
| `finalizedBlock$` | `Observable<BlockInfo>` | Stream of finalized blocks |
| `getFinalizedBlock()` | `Promise<BlockInfo>` | Latest finalized block |
| `bestBlocks$` | `Observable<BlockInfo[]>` | Best block chain |
| `getBlockBody(hash)` | `Promise<HexString[]>` | Block extrinsics |
| `getBlockHeader(hash?)` | `Promise<BlockHeader>` | Decoded block header |
| `getTypedApi(descriptors)` | `TypedApi` | Runtime-typed API |
| `getUnsafeApi()` | `UnsafeApi` | Untyped API (escape hatch) |
| `submit(tx, at?)` | `Promise<TxFinalizedPayload>` | Submit signed extrinsic |
| `destroy()` | `void` | Disconnect and clean up |
| `_request(method, params)` | `Promise<any>` | Raw JSON-RPC call |

### Getting the Typed API

```typescript
import { bittensor } from "@polkadot-api/descriptors"

const api = client.getTypedApi(bittensor)
```

---

## Typed API

```typescript
type TypedApi = {
  query: StorageApi
  tx: TxApi
  txFromCallData: TxFromBinary
  event: EvApi
  apis: RuntimeCallsApi
  constants: ConstApi
  compatibilityToken: Promise<CompatibilityToken>
}
```

### Storage Queries

```typescript
// Simple value (no keys)
const blockNumber = await api.query.System.Number.getValue()

// Watch for changes
api.query.System.Number.watchValue("finalized").subscribe(console.log)

// Keyed storage
const account = await api.query.System.Account.getValue(address)
console.log(`Free balance: ${account.data.free}`)

// Multiple values
const accounts = await api.query.System.Account.getValues([
  [addr1],
  [addr2],
])

// All entries in a storage map
const allAccounts = await api.query.System.Account.getEntries()
for (const { keyArgs, value } of allAccounts) {
  console.log(`${keyArgs[0]}: ${value.data.free}`)
}

// Query at specific block
const account = await api.query.System.Account.getValue(addr, {
  at: "best",  // or a specific block hash
})
```

### Transactions

```typescript
import { MultiAddress } from "@polkadot-api/descriptors"

// Create a transaction
const tx = api.tx.Balances.transfer_keep_alive({
  dest: MultiAddress.Id("5Destination..."),
  value: 1_000_000_000n,
})

// Estimate fees
const fees = await tx.getEstimatedFees("5Sender...")

// Sign and submit (Promise-based)
const result = await tx.signAndSubmit(signer)
console.log(`Success: ${result.ok}`)
console.log(`Block: #${result.block.number} (${result.block.hash})`)

// Sign and submit (Observable-based for lifecycle tracking)
tx.signSubmitAndWatch(signer).subscribe({
  next: (event) => {
    switch (event.type) {
      case "signed": console.log("Signed:", event.txHash); break
      case "broadcasted": console.log("Broadcasted"); break
      case "txBestBlocksState":
        if (event.found) console.log("Found in best block!"); break
      case "finalized":
        console.log(`Finalized in block #${event.block.number}`)
        console.log(`Success: ${event.ok}`)
        break
    }
  },
  error: (err) => console.error("Failed:", err),
})
```

#### Transaction Options

```typescript
const result = await tx.signAndSubmit(signer, {
  tip: 1_000_000n,
  mortality: { mortal: true, period: 64 },
  at: "finalized",
  nonce: 42,
})
```

#### Error Handling

```typescript
import { InvalidTxError } from "polkadot-api"

try {
  await tx.signAndSubmit(signer)
} catch (err) {
  if (err instanceof InvalidTxError) {
    console.log("Transaction invalid:", err.error)
  }
}
```

### Events

```typescript
// Pull events from latest finalized block
const events = await api.event.Balances.Transfer.pull()

// Watch events across finalized blocks
api.event.Balances.Transfer.watch().subscribe((event) => {
  console.log(`${event.payload.from} → ${event.payload.to}: ${event.payload.amount}`)
})

// Filter events from transaction result
const result = await tx.signAndSubmit(signer)
const transfers = api.event.Balances.Transfer.filter(result.events)
```

### Constants

```typescript
// Async
const version = await api.constants.System.Version()

// Sync (with compatibility token)
const token = await api.compatibilityToken
const version = api.constants.System.Version(token)
```

### Compatibility Checks

```typescript
import { CompatibilityLevel } from "polkadot-api"

const level = await api.query.System.Account.getCompatibilityLevel()
// CompatibilityLevel.Identical | BackwardsCompatible | Partial | Incompatible

if (await api.tx.Balances.transfer_keep_alive.isCompatible(
  CompatibilityLevel.BackwardsCompatible
)) {
  // Safe to use
}
```

---

## PolkadotSigner Interface

```typescript
interface PolkadotSigner {
  publicKey: Uint8Array
  signTx: (
    callData: Uint8Array,
    signedExtensions: Record<string, { identifier: string; value: Uint8Array; additionalSigned: Uint8Array }>,
    metadata: Uint8Array,
    atBlockNumber: number,
    hasher?: (data: Uint8Array) => Uint8Array,
  ) => Promise<Uint8Array>
  signBytes: (data: Uint8Array) => Promise<Uint8Array>
}
```

### `getPolkadotSigner` Helper

```typescript
import { getPolkadotSigner } from "polkadot-api/signer"

const signer = getPolkadotSigner(
  publicKey,       // Uint8Array
  signingType,     // "Ed25519" | "Sr25519" | "Ecdsa"
  signFn,          // (input: Uint8Array) => Promise<Uint8Array> | Uint8Array
)
```

---

## Key Imports Summary

| Import | From |
|--------|------|
| `createClient` | `polkadot-api` |
| `InvalidTxError`, `CompatibilityLevel` | `polkadot-api` |
| `getWsProvider` | `polkadot-api/ws-provider` |
| `getSmProvider` | `polkadot-api/sm-provider` |
| `getPolkadotSigner` | `polkadot-api/signer` |
| `start` | `polkadot-api/smoldot` |
| Chain descriptors, `MultiAddress` | `@polkadot-api/descriptors` |

---

## References

- Official docs: https://papi.how/
- Repository: https://github.com/polkadot-api/polkadot-api

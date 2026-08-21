# @trinaryex/sdk

SDK for trading on **Trinary Exchange** (a Sui / `triexbook` DeepBook-style market).
Players and bots read market + account data through `api.trinary.exchange` (API key)
and place trades by signing on-chain transactions with their own wallet or keypair.

> **Status: pre-alpha — read core complete.** The full read surface (discovery,
> hubs, order books, balances, order status) and balance-manager lifecycle are
> implemented against the published gateway; deposits, item withdrawals, and
> order placement are stubbed (`TRIEX_NOT_IMPLEMENTED`) pending Phases 2–3. See
> [DESIGN.md](./DESIGN.md). Targets **testnet** (the `stillness` world) only.

## Two planes, two auth models

- **Reads** (discovery, order books, hub details, balances) → HTTP to
  `api.trinary.exchange` with an `x-api-key` header.
- **Writes** (create account, deposit, withdraw, place orders) → Sui PTBs signed
  by **your** wallet/keypair via an `executor`. The API key never moves funds.

One deliberate exception: **currency (CRED) balances are fullnode reads**, not
indexer reads — the inventory endpoint serves items only, and deficit math for
order placement needs head-current values anyway.

Get an API key at <https://trinary.exchange/settings> (docs:
<https://docs.trinary.exchange/docs/api-keys>).

## Install

```bash
npm install @trinaryex/sdk @mysten/sui zod
```

`@mysten/sui` and `zod` are peer dependencies.

## Quick start

```ts
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { TriexClient } from '@trinaryex/sdk'

// Mysten's public fullnodes serve the unified gRPC(-Web) API.
const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
})
const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!)

const client = new TriexClient({
  suiClient,
  apiKey: process.env.TRIEX_API_KEY!,
  address: keypair.toSuiAddress(),
  // Bot / keypair executor. Browser wallets pass their signAndExecute here.
  executor: (tx) =>
    suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showObjectChanges: true, showEffects: true },
    }),
})

// Market reads (indexer)
const feed = await client.market.discover({ limit: 20 })
const hub = await client.market.hub(storageUnitId)
const { items } = await client.market.itemsAtHub(storageUnitId)
const book = await client.market.orderbook({ storageUnitId, assetId: '70810' })

// Balances — items per hub (indexer), CRED (fullnode, head-current)
const inv = await client.balances.atHub({ storageUnitId })
const cred = await client.balances.currency()

// Order status (needs a balance manager)
const { orders } = await client.orders.openOrders({ limit: 50 })

// Write (on-chain, idempotent)
const { balanceManagerId, created } = await client.account.ensure()
```

### Read-only

```ts
import { ReadOnlyClient } from '@trinaryex/sdk'

const ro = new ReadOnlyClient({ apiKey: process.env.TRIEX_API_KEY! })
const feed = await ro.discover({ assetId: '70810', side: 'sell' })
const book = await ro.orderbook({ storageUnitId, assetId: '70810' })
```

`ReadOnlyClient` is indexer-only (no fullnode), so identity params are always
explicit and currency balances are not available on it.

## API surface

| Group | Method | Story | Status |
|---|---|---|---|
| `account` | `get` / `ensure` | create BM if missing | ✅ |
| `account` | `depositCurrency` / `depositItems` | fund BM | stub (Phase 2) |
| `account` | `withdrawCurrency` / `withdrawItems` | drain BM | partial / stub |
| `balances` | `atHub` | items: warehouse / marketplace / hangar | ✅ |
| `balances` | `currency` | CRED: wallet + balance manager | ✅ (fullnode) |
| `market` | `discover` / `hub` / `itemsAtHub` / `resolvePool` / `orderbook` / `poolMetadata` | market data | ✅ |
| `orders` | `openOrders` / `fills` / `trades` | order status | ✅ |
| `orders` | `limit` / `market` | place orders | stub (Phase 3) |

Amounts, prices, and quantities are `bigint` in base units; timestamps are epoch
milliseconds. Items are identified by `assetId` (numeric item-type id as a
string). Response types are inferred from zod schemas pinned against the
published gateway spec.

## Errors

Every failure is a `TriexClientError` with a stable `code` (`TriexError` enum):

```ts
import { TriexClientError, TriexError } from '@trinaryex/sdk'

try {
  await client.market.orderbook({ storageUnitId, assetId })
} catch (e) {
  if (e instanceof TriexClientError && e.code === TriexError.PoolNotFound) {
    // no market for this item at this hub
  }
}
```

## Consistency

The indexer is eventually-consistent (seconds behind head). On-chain writes are
authoritative and atomic — a stale read can only ever cause a transaction to
abort and roll back, never lose funds. Balance-manager resolution and currency
balances read the fullnode directly (head-current). Prefer object IDs returned
from writes over an immediate re-read. See [DESIGN.md §12](./DESIGN.md).

## Develop

```bash
npm install
npm run tscheck
npm test
npm run build
```

## License

MIT

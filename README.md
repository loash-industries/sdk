# @trinaryex/sdk

SDK for trading on **Trinary Exchange** (a Sui / `triexbook` DeepBook-style market).
Players and bots read market + account data through `api.trinary.exchange` (API key)
and place trades by signing on-chain transactions with their own wallet or keypair.

> **Status: scaffold / pre-alpha.** Read delegation and balance-manager
> lifecycle are wired; deposits, item withdrawals, and order placement are
> stubbed (`TRIEX_NOT_IMPLEMENTED`) pending Phases 2–3. See [DESIGN.md](./DESIGN.md).
> Most indexer reads also depend on gateway routes that are not yet enabled
> (Phase 0). Targets **testnet** (the `stillness` world) only.

## Two planes, two auth models

- **Reads** (discovery, order books, hub details, balances) → HTTP to
  `api.trinary.exchange` with an `x-api-key` header.
- **Writes** (create account, deposit, withdraw, place orders) → Sui PTBs signed
  by **your** wallet/keypair via an `executor`. The API key never moves funds.

Get an API key at <https://trinary.exchange/settings> (docs:
<https://docs.trinary.exchange/docs/api-keys>).

## Install

```bash
npm install @trinaryex/sdk @mysten/sui zod
```

`@mysten/sui` and `zod` are peer dependencies.

## Quick start

```ts
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { TriexClient } from '@trinaryex/sdk'

const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') })
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

// Read (indexer)
const discovery = await client.market.discover({ limit: 20 })
const book = await client.market.orderbook({ storageUnitId, typeId })

// Write (on-chain, idempotent)
const { balanceManagerId, created } = await client.account.ensure()
```

### Read-only

```ts
import { ReadOnlyClient } from '@trinaryex/sdk'

const ro = new ReadOnlyClient({ apiKey: process.env.TRIEX_API_KEY! })
const orders = await ro.discover({ typeId })
```

## API surface

| Group | Method | Story | Status |
|---|---|---|---|
| `account` | `get` / `ensure` | create BM if missing | wired |
| `account` | `depositCurrency` / `depositItems` | fund BM | stub (Phase 2) |
| `account` | `withdrawCurrency` / `withdrawItems` | drain BM | partial / stub |
| `balances` | `forCharacter` | items + CRED | wired (indexer pending) |
| `market` | `discover` / `hub` / `itemsAtHub` / `orderbook` | market data | wired (indexer pending) |
| `orders` | `limit` / `market` | place orders | stub (Phase 3) |
| `orders` | `openOrders` / `fills` / `trades` | order status | wired (indexer pending) |

## Errors

Every failure is a `TriexClientError` with a stable `code` (`TriexError` enum):

```ts
import { TriexClientError, TriexError } from '@trinaryex/sdk'

try {
  await client.orders.limit({ /* … */ })
} catch (e) {
  if (e instanceof TriexClientError && e.code === TriexError.InsufficientBalance) {
    // top up and retry
  }
}
```

## Consistency

The indexer is eventually-consistent (seconds behind head). On-chain writes are
authoritative and atomic — a stale read can only ever cause a transaction to
abort and roll back, never lose funds. Prefer object IDs returned from writes
over an immediate re-read. See [DESIGN.md §12](./DESIGN.md).

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT

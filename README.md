# @trinaryex/sdk

[![npm version](https://img.shields.io/npm/v/%40trinaryex%2Fsdk)](https://www.npmjs.com/package/@trinaryex/sdk)
[![license: MIT](https://img.shields.io/npm/l/%40trinaryex%2Fsdk)](#license)

The official TypeScript trading SDK for
[**Trinary Exchange**](https://trinary.exchange/), the player-built
**EVE Frontier marketplace** — a Sui-based order-book market for trading
items and currency across EVE Frontier trade hubs, built on the
[Trinary Exchange CLOB Move contracts](https://github.com/loash-industries/trinary-exchange).
Players and bots read live **EVE Frontier market data** through the
[Trinary Exchange API](https://docs.trinary.exchange/) and trade by signing
on-chain transactions with their own wallet or keypair.

- 🛰️ Browse the markets: **<https://trinary.exchange/>**
- 📚 Full API documentation: **<https://docs.trinary.exchange/>**

Built for exactly the things you'd want to build on an exchange:

- **market analytics** — discovery feed, order books, spreads, VWAP, history streaming
- **trading bots** — atomic order placement with automatic funding, fills, settled-proceeds claiming, cancels
- **CLI tools** — everything is plain async TypeScript with typed errors
- **agentic trading** — stable error codes plus human-readable on-chain abort translation

> **Status: v1.0.0 — released.** The full read and write surface (deposits,
> withdrawals, orders, cancels, claims) is verified end-to-end against the
> live gateway and chain: a scripted trading lifecycle with real fills, fees,
> and settled-proceeds claims, on top of 93 unit tests. Targets **testnet**
> (the `stillness` world). See [DESIGN.md](./DESIGN.md).

## Two planes, two auth models

| Plane | Auth | What |
|---|---|---|
| **Reads** | API key (`x-api-key`) | discovery, order books, hubs, item balances, order status — billed per-request in compute units |
| **Writes** | Your Sui signature | create account, deposit, withdraw, place/cancel orders — the API key never moves funds |

One deliberate exception: **currency (CRED) balances are fullnode reads**, not
API reads — order funding math needs head-current values.

Get an API key at <https://trinary.exchange/settings> (docs:
<https://docs.trinary.exchange/docs/api-keys>). The docs' samples use the
`TRINARY_API_KEY` env var; this README follows that convention.

## Install

```bash
npm install @trinaryex/sdk @mysten/sui zod
```

`@mysten/sui` (v2) and `zod` are peer dependencies.

## Quick start

```ts
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { TriexClient } from '@trinaryex/sdk'

const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
})
const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!)

const client = new TriexClient({
  suiClient,
  apiKey: process.env.TRINARY_API_KEY!,
  address: keypair.toSuiAddress(),
  // The SDK normalizes v2 core-client results AND legacy {digest, objectChanges}
  // shapes, and surfaces on-chain aborts as typed errors. Include effects +
  // objectTypes so created objects (e.g. your trading account) are captured.
  executor: (tx) =>
    suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      include: { effects: true, objectTypes: true },
    }),
})

// Reads
const feed = await client.market.discover({ limit: 20 })
const book = await client.market.orderbook({ storageUnitId, assetId: '70810' })

// Writes (atomic PTBs; the trading account is created on demand)
await client.orders.limit({
  storageUnitId,
  assetId: '70810',
  side: 'buy',
  price: 2_500_000_000n, // CRED base units per item
  quantity: 10n,
})
```

Browser wallets work the same way — pass dapp-kit's `signAndExecuteTransaction`
as the `executor`.

### Read-only (no wallet, no fullnode)

```ts
import { ReadOnlyClient } from '@trinaryex/sdk'

const ro = new ReadOnlyClient({ apiKey: process.env.TRINARY_API_KEY! })
const feed = await ro.discover({ assetId: '70810', side: 'sell' })
```

## Recipes

### Market analytics

```ts
import { aggregateLevels, midPrice, spread, vwap, iterateTrades } from '@trinaryex/sdk'

const book = await ro.orderbook({ storageUnitId, assetId })
console.log('mid', midPrice(book), 'spread', spread(book)?.bps, 'bps')
console.log('bid levels', aggregateLevels(book.bids))

// Stream a balance manager's full trade history (auto-pagination) …
const history = []
for await (const trade of iterateTrades(ro.indexer, balanceManagerId)) {
  history.push(trade) // { price, baseQuantity, quoteQuantity, fee, side, tradedAt, … }
}
// … and summarize it.
console.log('lifetime VWAP', vwap(history))
```

### Trading bot loop

```ts
import { estimateMarketBuyCost } from '@trinaryex/sdk'

// 1. Fund + place in ONE atomic transaction: the SDK deposits only the
//    deficit (existing balance-manager funds are consumed first), creates
//    the trading account if missing, and rolls everything back on failure.
await client.orders.limit({ storageUnitId, assetId, side: 'sell', price, quantity })

// Market buys need a worst-case budget from the current book:
const est = estimateMarketBuyCost(book.asks, quantity, meta.feeRateScaled)
await client.orders.market({ storageUnitId, assetId, side: 'buy', quantity, quoteBudget: est.total })

// 2. Watch state. The indexer trails the chain by seconds — untilIndexed()
//    packages the poll-until-visible pattern (typed Timeout on give-up).
import { untilIndexed } from '@trinaryex/sdk'
const placed = await untilIndexed(async () => {
  const { orders } = await client.orders.openOrders({ limit: 20 })
  return orders.find((o) => o.assetId === assetId && o.side === 'sell')
}, { label: 'the resting order' })
const { fills } = await client.orders.fills({ after: lastSeen })

// 3. After fills: proceeds sit SETTLED in the pool until claimed.
const claimable = await client.account.sweepable()
if (claimable.pools.length) await client.account.claimSettled()

// 4. Withdraw to the wallet / hangar when done.
await client.account.withdrawCurrency()
await client.account.withdrawItems({ storageUnitId, items: [{ assetId }] })

// Housekeeping.
await client.orders.cancel({ storageUnitId, assetId, orderId })
await client.orders.cancelAll({ storageUnitId, assetId })
```

### Agentic / CLI error handling

Every SDK failure is a `TriexClientError` with a stable `code` — each method's
`@throws` JSDoc lists exactly which codes it can raise, and on-chain aborts are
translated into actionable text:

```ts
import { TriexClientError, TriexError, explainMoveAbort } from '@trinaryex/sdk'

try {
  await client.orders.limit(params)
} catch (e) {
  if (!(e instanceof TriexClientError)) throw e
  switch (e.code) {
    case TriexError.RateLimited:         // CU budget hit — wait e.retryAfterMs
    case TriexError.InsufficientBalance: // top up and retry
    case TriexError.PoolNotFound:        // no market for this item at this hub
    case TriexError.TransactionFailed:   // on-chain abort, e.message explains why
      console.error(e.message)           // e.g. "…Max 100 open orders per balance manager…"
  }
}

// Or translate raw Sui errors from anywhere:
explainMoveAbort(rawError) // "No liquidity available (EEmptyOrderbook)" | null
```

| Code | Raised when | Recovery |
|---|---|---|
| `Unauthorized` | API key missing/revoked/wrong tier (HTTP 401/403) | fix `TRINARY_API_KEY` |
| `RateLimited` | compute-unit budget exhausted (HTTP 429) | wait `e.retryAfterMs`, retry |
| `IndexerError` | 5xx / unexpected HTTP failure (`e.status` set) | retry with backoff |
| `UnexpectedResponse` | response didn't match the pinned schema | report — API drift |
| `HubNotFound` / `PoolNotFound` / `BalanceManagerNotFound` | unknown id for the target resource | check inputs |
| `InsufficientBalance` | wallet/hangar/BM can't fund the operation | deposit / top up |
| `CollectionMismatch` | item receipts from a different deployment | wrong network/receipts |
| `CharacterNotFound` | hangar flows need an on-chain character | pass `characterId` / create one |
| `TransactionFailed` | on-chain abort (message carries the translated reason) | act on the message |
| `AddressRequired` / `ExecutorRequired` / `ApiKeyRequired` / `ValidationFailed` | client-side config/input problems | fix locally |

## API surface

| Group | Methods |
|---|---|
| `account` | `get` · `ensure` · `depositCurrency` · `depositItems` · `withdrawCurrency` · `withdrawItems` · `sweepable` · `claimSettled` · `owners` |
| `balances` | `atHub` (items: warehouse/marketplace/hangar) · `currency` (CRED wallet + BM, fullnode) |
| `market` | `discover` · `hub` · `itemsAtHub` · `resolvePool` · `orderbook` · `poolMetadata` |
| `market` (locations) | `hubLocations` · `itemLocations` · `nearbyHubs` · `nearbyHubsBySystem` · `hubsEnriched` · `assemblyOwners` · `assembliesEnriched` · `solarSystemNames` |
| `orders` | `limit` · `market` · `cancel` · `cancelAll` · `modify` · `openOrders` · `fills` · `trades` |
| helpers | `aggregateLevels` · `midPrice` · `spread` · `depth` · `vwap` · `estimateMarketBuyCost` · `iterateDiscovery/Fills/Trades` · `untilIndexed` · `explainMoveAbort` · `toBase` / `fromBase` |

Runnable examples live in [`examples/`](./examples).

## Units & money

- All prices, quantities, and amounts are **`bigint` in raw base units**;
  timestamps are epoch **milliseconds**. Items are identified by `assetId`
  (numeric item-type id as a string).
- Item pools price in CRED base units per item (no price scaling). Pool
  metadata carries `feeRateScaled` (× 1e9; `20_000_000` = 2%) and the
  base/quote `decimals` for display conversion via `toBase`/`fromBase`.
- Only buyers pay fees. A limit bid deposits
  `quote × (1e9 + feeRateScaled) / 1e9` — computed for you.
- Order expiry defaults to good-til-cancelled (`GTC_EXPIRE`).

## Consistency model

The indexer is eventually-consistent (seconds behind head). On-chain writes
are authoritative and atomic — a stale read can only make a transaction abort
and roll back, never lose funds. The SDK reads everything that funds
transactions (balance-manager resolution, currency balances, receipts, hangar
slots) from the **fullnode**, head-current. Prefer ids returned from writes
(`TxResult.createdObjects`) over immediate re-reads.

## Develop

```bash
npm install
npm run tscheck && npm test          # unit tests, including the gateway gate
npm run build

# Contract checks (no API key needed — /swagger.json is public):
npm run check:gateway                # against the vendored contract
npm run check:gateway -- --live      # against api.trinary.exchange right now
npm run refresh:gateway              # update the vendored copy

# Live verification (needs .env — see .env.sample):
node --env-file=.env scripts/smoke.mjs        # read surface vs the live gateway
node --env-file=.env scripts/integration.mjs  # write paths on testnet (uses gas)
```

### Lock-step with the gateway

Every request this SDK issues is checked against the gateway's **published
OpenAPI document**, not against a hand-maintained list.
`scripts/gateway-surface.mjs` reads the contract on one side and parses
`src/queries.ts` with the TypeScript compiler on the other, then compares them.
Because call sites are read statically, the check needs no API key, no network
and no live account — it runs inside the unit-test budget.

Drift comes in two shapes, and only one announces itself:

- **A moved endpoint** 404s on the first real call. Loud, easy.
- **A renamed query parameter** does not. A gateway ignores keys it does not
  recognise rather than rejecting them, so the request still returns `200` with
  a full body — a filter that stopped filtering is indistinguishable from a
  filter that matched everything, and every layer above believes it asked a
  narrower question than it did.

The gate reports four things: endpoints the contract does not publish, query
parameters the endpoint does not declare, required parameters the SDK never
sends, and call sites too dynamic to read statically — that last one counts as
a gap in coverage rather than a pass.

`test/gateway.test.ts` runs it against a vendored copy of the contract, so PR
CI stays hermetic and deterministic, and drives the comparison with doctored
inputs to prove the gate fails when it should. A vendored copy cannot see the
gateway moving underneath us, so a scheduled job runs the same check against
the live document — see `.github/workflows/gateway_drift.yml`.

## Links

- [Trinary Exchange](https://trinary.exchange/) — the EVE Frontier
  marketplace: live order books, trade hubs, and market data for the EVE
  Frontier economy
- [API documentation](https://docs.trinary.exchange/) — REST reference,
  guides, and [API keys](https://docs.trinary.exchange/docs/api-keys) for the
  Trinary Exchange trading API
- [Trinary Exchange CLOB contracts](https://github.com/loash-industries/trinary-exchange)
  — the Sui Move order-book contracts this SDK talks to
- [`@trinaryex/sdk` on npm](https://www.npmjs.com/package/@trinaryex/sdk)
- [Design notes](./DESIGN.md) — architecture, scope, and verification history

## License

MIT

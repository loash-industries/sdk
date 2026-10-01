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

// Stream a trading account's full trade history (auto-pagination) …
const history = []
for await (const trade of iterateTrades(ro.indexer, tradingAccountId)) {
  history.push(trade) // { price, baseQuantity, quoteQuantity, fee, side, tradedAt, … }
}
// … and summarize it.
console.log('lifetime VWAP', vwap(history))
```

### Trading bot loop

```ts
import { estimateMarketBuyCost } from '@trinaryex/sdk'

// 1. Fund + place in ONE atomic transaction: the SDK deposits only the
//    deficit (existing trading-account funds are consumed first), creates
//    the trading account if missing, and rolls everything back on failure.
await client.orders.limit({ storageUnitId, assetId, side: 'sell', price, quantity })

// Market buys need a budget from the current book, at YOUR taker rate
// (fee tiers lower it as your trailing fee turnover grows):
const fees = await client.orders.fees({ storageUnitId, assetId })
const taker = fees.account?.takerFeeRate ?? fees.entryTakerFeeRate
const est = estimateMarketBuyCost(book.asks, quantity, taker)
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
await client.orders.cancelMany({ storageUnitId, assetId, orderIds })
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
      console.error(e.message)           // e.g. "…Max 100 open orders per trading account…"
  }
}

// Or translate raw Sui errors from anywhere:
explainMoveAbort(rawError) // "No liquidity available (EEmptyOrderbook)" | null

// …or get the parts separately instead of one prose string:
explainMoveAbortDetailed(rawError)
// { module: 'order_info', constant: 'EPOSTOrderCrossesOrderbook', code: 5,
//   explanation: 'POST-ONLY order would cross the book — use a plain limit order',
//   resolution: 'resolved', source: 'packages/triex/sources/book/order_info.move:18', … }
```

A failed transaction's `effects.status.error` carries only the raw `u64` abort code —
no constant name — so the SDK parses that string and resolves the code against
`MOVE_ABORT_CATALOG`, generated from the contract sources. `resolution` tells you
whether the abort was `resolved`, came from a dependency package
(`external-module`), or is a code the catalog doesn't know yet (`unknown-code`).

| Code | Raised when | Recovery |
|---|---|---|
| `Unauthorized` | API key missing/revoked/wrong tier (HTTP 401/403) | fix `TRINARY_API_KEY` |
| `RateLimited` | compute-unit budget exhausted (HTTP 429) | wait `e.retryAfterMs`, retry |
| `IndexerError` | 5xx / unexpected HTTP failure (`e.status` set) | retry with backoff |
| `UnexpectedResponse` | response didn't match the pinned schema | report — API drift |
| `HubNotFound` / `PoolNotFound` / `TradingAccountNotFound` | unknown id for the target resource | check inputs |
| `TransactionFailed` | the transaction aborted on-chain | `e.message` carries the decoded abort |
| `InsufficientBalance` | wallet/hangar/BM can't fund the operation | deposit / top up |
| `CollectionMismatch` | item receipts from a different deployment | wrong network/receipts |
| `CharacterNotFound` | hangar flows need an on-chain character | pass `characterId` / create one |
| `TransactionFailed` | on-chain abort (message carries the translated reason) | act on the message |
| `AddressRequired` / `ExecutorRequired` / `ApiKeyRequired` / `ValidationFailed` | client-side config/input problems | fix locally |

## API surface

| Group | Methods |
|---|---|
| `account` | `get` · `ensure` · `register` · `depositCurrency` · `depositItems` · `withdrawCurrency` · `withdrawItems` · `sweepable` · `claimSettled` · `owners` · `mintCap` · `revokeCap` · `caps` |
| `balances` | `atHub` (items: warehouse/marketplace/hangar) · `currency` (CRED wallet + BM, fullnode) |
| `market` | `discover` · `hub` · `itemsAtHub` · `resolvePool` · `orderbook` · `poolMetadata` · `createPool` · `claimOperatorShare` |
| `market` (locations) | `hubLocations` · `itemLocations` · `nearbyHubs` · `nearbyHubsBySystem` · `hubsEnriched` · `assemblyOwners` · `assembliesEnriched` · `solarSystemNames` |
| `orders` | `fees` · `limit` · `market` · `cancel` · `cancelMany` · `cancelAll` · `modify` · `openOrders` · `fills` · `trades` |
| `spatial` | `system` · `systems` · `nearbySystems` · `systemsNearCoordinates` · `autocompleteSystems` · `stats` |
| `orgs` | `get` · `batch` · `directory` · `forPlayer` · `search` · `proposals` · `seats` · `tradingAccount` · `accessibleKeyspaces` · `vaultsAtHub` |
| `org(id)` handle | `.governance` · `.members` · `.metadata` · `.types` · `.treasury` · `.orders` · `.vault` — see below |
| helpers | `aggregateLevels` · `midPrice` · `spread` · `depth` · `vwap` · `estimateMarketBuyCost` · `estimateMarketSellProceeds` · `computeBidQuoteDeposit` · `computeAskProceeds` · `computeQuoteFee` · `iterateDiscovery/Fills/Trades/OrgDirectory` · `untilIndexed` · `explainMoveAbort` / `explainMoveAbortDetailed` · `toBase` / `fromBase` |

Runnable examples live in [`examples/`](./examples).

## Organizations & governance (Armature)

An organization is a **tree of DAOs** — a root plus its units — and every write
goes through a governance pipeline whose shape depends on who is calling. Acting
as one means binding both the organization *and* a seat within it:

```ts
const org = await client.org(orgId)   // any unit id resolves the whole tree
org.seats                             // boards you sit on, highest authority first
org.as(officersDaoId)                 // act through a different seat you hold
```

### The same call is not the same transaction

```ts
const outcome = await org.members.add(['0x…'])
switch (outcome.status) {
  case 'executed': break                       // your vote cleared quorum — done
  case 'proposed': outcome.proposalId; break   // the board still has to vote
  case 'blocked':  outcome.reason; break       // no path available, and why
}
```

`blocked` is a **returned value, not a throw** — "you are not on this board" is
an ordinary answer. Real failures still throw `TriexClientError`. Use
`org.governance.resolve(action)` to ask without signing, and
`org.governance.paths(action)` for the full trace of why.

Whether a lone vote suffices is a question about **per-type config**, not about
rank: it clears quorum only when `boardSize × quorum ≤ 10000` and the execution
delay is zero. `org.governance.read()` returns those configs.

### The rest of the handle

| Group | Methods |
|---|---|
| `governance` | `read` · `resolve` · `paths` · `run` · `runBatch` · `runComposite` · `canComposite` · `vote` · `execute` · `tryExpire` · `proposals` |
| `members` | `add` · `remove` · `setBoard` |
| `metadata` | `update` |
| `types` | `enable` · `updateConfig` · `enableComposite` · `enableSendCoin` · `enableTrading` |
| `treasury` | `balances` · `balance` · `itemBalance` · `deposit` · `send` · `sendToOrg` |
| `orders` | `ensureAccount` · `limit` · `cancel` · `buyFromTreasury` · `sellFromDaoVault` · `sweepCoin` · `sweepItems` · `sweepAll` |
| `vault` | `atHub` · `resolve` · `info` · `balance` · `init` · `deposit` · `withdraw` · `grant` · `revoke` · `deinit` |

Four things worth knowing before you call them:

- **Funding a treasury is permissionless.** `treasury.deposit()` needs no seat
  and no vote, and returns a plain `TxResult`. Paying out returns `RunOutcome`
  because it is governance. The return types are the authorization model.
- **Trading never degrades into a proposal.** A limit order deferred by a week
  is priced against a book that no longer exists, and a funded buy split into
  two proposals loses its atomic deposit-then-place guarantee — so these
  `blocked` instead.
- **Shared storage is keyed by (storage unit, organization).** There is no "the
  vault at this hub": anyone can register one at any SSU. `vault.resolve()`
  answers for *your* organization.
- **`types.enableTrading({ bindToBaseType })` is irreversible.** It binds the
  coin-pool order types to one base coin permanently. Leave it unset.

## Units & money

- All prices, quantities, and amounts are **`bigint` in raw base units**;
  timestamps are epoch **milliseconds**. Items are identified by `assetId`
  (numeric item-type id as a string).
- Item pools price in CRED base units per item (no price scaling). Pool
  metadata carries the base/quote `decimals` for display conversion via
  `toBase`/`fromBase`, and `feeRateScaled` — the pool's entry-tier taker rate.
- Fees are quote-denominated, `floor(quote × rate / 1e9)`, and **both sides
  pay**: bids on top of what they owe (taker fee when they match, maker fee
  escrowed while they rest), asks out of their proceeds. Rates come from the
  pool's fee class (multicoin launch ladder: 2.2% taker / 1.8% maker, falling
  with your trailing 30-epoch fee turnover). `orders.fees()` reads the ladder,
  your tier, and the cancel retention (the share of a bid's escrowed maker fee
  kept when you cancel, modify down, or it expires) from the chain.
- A limit bid is funded for `notional + floor(notional × bidEscrowFeeRate /
  1e9)` — the pool's highest rate, so it can never be under-funded; anything
  unused stays in the trading account. Sells need no CRED.
- Order expiry defaults to good-til-cancelled (`GTC_EXPIRE`).

## Consistency model

The indexer is eventually-consistent (seconds behind head). On-chain writes
are authoritative and atomic — a stale read can only make a transaction abort
and roll back, never lose funds. The SDK reads everything that funds
transactions (trading-account resolution, currency balances, receipts, hangar
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

### Regenerating the abort catalog

`src/moveAbortCatalog.generated.ts` is generated from the Move sources in the
[contracts repo](https://github.com/loash-industries/trinary-exchange). It is
committed, so building and testing the SDK never needs that checkout — only
regenerating does, after an error constant is added, removed or renumbered:

```bash
npm run generate:error-codes                              # assumes ../trinary-exchange
npm run generate:error-codes -- --contracts <path>        # or $TRIEX_CONTRACTS
npm run check:error-codes                                 # fail if the catalog is stale
```

`check:error-codes` needs the contracts checkout, so it is a local/release step
rather than a CI one. Drift is caught in CI a different way: the curated messages in
`src/moveAbort.ts` are keyed by `MoveAbortName`, a union generated from the
contracts, so a renamed or deleted constant fails `npm run tscheck`.

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

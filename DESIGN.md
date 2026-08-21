# `@trinaryex/sdk` — Trinary Exchange Trading SDK

**Status:** Phases 0–1 complete (2026-08-21): gateway routes live, read core implemented
against pinned schemas (RQ-1/RQ-4 resolved). Open questions resolved 2026-08-15.
**Package:** `@trinaryex/sdk` (repo: `sdk/`) — an umbrella SDK; the trading surface is the
first module, with room to grow into a higher-level, full-featured client.
**Audience:** players and bots trading on Trinary Exchange via an API key.
**Target (MVP):** **testnet only**, the **`stillness`** tenant; **only the most-recent (v1)
`triexbook` contracts** are supported. Item↔currency (CRED) markets via `multicoin_pool`
("pools"); coin-pools are out of scope for now.
**Models after:** [`@trinaryex/keyspace`](https://www.npmjs.com/package/@trinaryex/keyspace)
(client + `executor` pattern, `queries`/`transactions` split, zod validation, vite build,
semantic-release).

---

## 1. What this SDK is (and isn't)

Trinary Exchange is a Sui-based, DeepBook-style market for an EVE-Frontier game economy.
Players trade **items** (multicoin balances, priced in the **CRED** trade currency) and
**currency** at **trade hubs** (Smart Storage Units / SSUs) through on-chain order books
(the `triexbook` DeepBook fork), settling through a per-player **balance manager** (the
on-chain trading account).

The SDK gives a player/bot one object to:

- **Read** market + account state through `api.trinary.exchange` (the `etl-api` indexer),
  authenticated with an **API key** (`x-api-key`).
- **Write** (mutate) by building Sui **programmable transaction blocks (PTBs)** that the
  caller's **wallet or keypair signs** — exactly the keyspace `executor` pattern.

> **The two planes have two different auth models.** The API key authorizes *reads only*.
> Every state change (create account, deposit, withdraw, place order) is an **on-chain
> transaction authorized by the player's Sui signature** — the API key never moves funds.
> This is the single most important thing to communicate to SDK users.

### Non-goals (for MVP)

- No tribe/DAO governance-wrapped trading (the `armature_trading` `board_voting` path in
  triex-app-api). MVP is **personal** balance-manager trading only.
- No cancel/modify order, no claim-settled/sweep-all conveniences (beyond the withdraw
  primitives), no price-history/analytics endpoints.
- No custody. The SDK never holds keys; signing is delegated to an `executor`.
- No websocket/relay live order-book streaming (the app's `TradeContext` relay
  subscriptions). MVP is request/response against the indexer.

---

## 2. MVP scope → endpoint / transaction map

Each user story below is tagged **READ** (indexer or fullnode) or **WRITE** (on-chain PTB).
The "Gateway" column is the **current** state in
`dynamic-config-registry/gateway-routes/etl-api.json` (as of 2026-08-21).

| # | User story | Plane | Indexer endpoint / Move entrypoint | Gateway today |
|---|---|---|---|---|
| 1 | Create trading account **iff** none exists (balance manager) | READ+WRITE | READ on-chain `listOwnedObjects` (authoritative; `GET /v1/inventory/balance-manager` stays disabled) → WRITE `balance_manager::new()` (+ `transferObjects` to self) | n/a (on-chain read) |
| 2 | Fetch item balances | READ | `GET /v1/inventory/balances` — **hub-scoped** (`storage_unit_id` required): warehouse (wallet receipts, by `owner_address`), marketplace (BM, by `balance_manager_id`), hangar (by `inventory_key` owner-cap id) | **enabled** (50 CU) |
| 3 | Fetch trade-currency (CRED) balance | READ | **fullnode** — wallet coins (`listCoins`) + BM `BalanceKey<CRED>` dynamic field; the indexer inventory endpoint serves *items only* | n/a (fullnode) |
| 4 | Deposit items from hangar → trading account | READ+WRITE | READ `GET /v1/hubs/{hub_id}/vault` (vaultConfigId + collectionId) + on-chain owner-cap/char resolution → WRITE the **direct-from-hangar sequence** (borrow_owner_cap → receipt::deposit_for_receipt → return_owner_cap → balance_manager::deposit_multicoin); see §6.1 | **enabled** (vault) |
| 5 | Deposit currency → trading account | WRITE | `balance_manager::deposit<CRED>` (wallet coin selected/merged/split) | n/a (on-chain) |
| 6 | Discover items with live buy/sell orders across the universe | READ | `GET /v1/discovery` — **open orders sorted by recency**, with filters (hubs/item/side/bm/public) | **enabled** (150 CU) |
| 7 | Fetch trade-hub details (public/private, owner, location) | READ | `GET /v1/hubs/{hub_id}/vault` + `GET /v1/hubs/{hub_id}/location` (+ `GET /v1/collections/{collection_id}/hub` reverse lookup). `/location` **404s semantically** for unrevealed hubs (most of them) → `TradeHubDetail.location` is nullable. Tribe/fuel are NOT in these responses (post-MVP: hubs economics/enriched routes) | **enabled** |
| 8 | Fetch items with buy/sell orders at a specific storage unit | READ | `GET /v1/hubs/{hub_id}/items` (`has_bids`/`has_asks` flags) | **enabled** |
| 9 | Fetch order book for one item at that storage unit | READ | `GET /v1/hubs/{hub_id}/vault` → `GET /v1/pools/resolve` (**`collection_id`+`asset_id`**, not hub+item) → `GET /v1/pools/{pool_id}/orderbook` (returns resting **orders**, not levels) | **enabled** |
| 10 | Create **limit** buy/sell order | READ+WRITE | READ resolve chain + `GET /v1/pools/{pool_id}/metadata` (fee is 1e9-scaled `fee`, not bps) → WRITE `multicoin_pool::place_limit_order<Quote>` + deposit deficit | **enabled** (reads) |
| 11 | Create **market** buy/sell order | READ+WRITE | as #10 but `multicoin_pool::place_market_order<Quote>` (no price/expiry) | **enabled** (reads) |
| 14 | Read own open orders / fills / trades (bots) | READ | `GET /v1/balance-managers/{bm}/open-orders`, `/fills`, `/trades` (epoch-ms `before`/`after` paging) | **enabled** |
| 12 | Withdraw items from BM → storage unit | WRITE | `balance_manager::withdraw_all_multicoin` → `receipt::redeem_receipt(...ssu, character...)` | n/a (on-chain) |
| 13 | Withdraw currency from BM → wallet | WRITE | `balance_manager::withdraw_all<CRED>` + `transferObjects` to self | n/a (on-chain) |

**Phase 0 status (2026-08-21): done.** The market surface (pools, hubs, collections,
balance-manager reads, discovery) was enabled in DCR `62acb22`;
`GET /v1/inventory/balances` followed in `feat/publish-inventory-balances` (already
published to the running gateway). Two inventory routes stay deliberately disabled under
the sluice trust model (D11 — the gateway attaches no caller identity):
`/v1/inventory/balance-manager` (SDK reads on-chain instead — authoritative, §12) and
`/v1/inventory/receipt-objects` (wallet-receipt discovery is PTB *input* resolution and
belongs on the fullnode). Note `/v1/discovery` was repriced 30 → 150 CU (2 rps sustained
on the free/standard tier).

> **"Indexer-only" scopes market/account *data* reads, not PTB input resolution.** Building
> the item deposit/withdraw PTBs (#4, #12) requires live object references — owner-cap
> `version`/`digest` for `tx.receivingRef`, character/SSU owner-cap object IDs — which are
> resolved from the **fullnode `suiClient`**, not the indexer. These are always head-current
> (no lag) and are not "reads" in the indexer sense. The BM-existence check (#1) is likewise
> best done on-chain (`listOwnedObjects`) to avoid the double-create race (§13).

---

## 3. Architecture

```
                    ┌────────────────────────────────────────────┐
   player / bot     │                 @trinaryex/sdk               │
   (owns Sui key) ──┤                                              │
                    │   TriexClient (high-level facade)            │
                    │   ├── account   (balance manager lifecycle)  │
                    │   ├── balances  (item + currency reads)      │
                    │   ├── market    (discovery, hubs, orderbook) │
                    │   └── orders    (limit/market, deposit/wdrw) │
                    │                                              │
                    │   queries.ts  ──READ──►  api.trinary.exchange│───► etl-api (indexer)
                    │     (fetch + x-api-key + zod validate)       │      (Postgres read models)
                    │                                              │
                    │   transactions.ts ──build PTB──► executor()  │───► player's wallet / keypair
                    │     (pure @mysten/sui Transaction builders)  │      └─► Sui network (triexbook)
                    └────────────────────────────────────────────┘
```

- **Reads** are pure HTTP to the gateway; the SDK adds `x-api-key`, validates responses with
  zod, and returns typed objects. No on-chain reads in MVP (per the indexer-only decision).
- **Writes** are built as `@mysten/sui` `Transaction` objects by pure functions in
  `transactions.ts`, then handed to a caller-supplied `executor(tx)` that signs+executes.
  The SDK reads whatever object IDs / amounts it needs from the **indexer** first (BM id,
  pool id, vault collection id, deposit deficit), then assembles the PTB.

### Why the executor pattern (copied from keyspace)

The SDK stays custody-free and wallet-agnostic. Two canonical executors:

```ts
// Browser wallet (@mysten/dapp-kit)
executor: (tx) => signAndExecuteTransaction({ transaction: tx, options: { showObjectChanges: true } })

// Bot / server keypair (Node)
executor: async (tx) => {
  return suiClient.signAndExecuteTransaction({
    signer: keypair, transaction: tx, options: { showObjectChanges: true, showEffects: true },
  })
}
```

`showObjectChanges: true` is **required** for `ensureTradingAccount()` (to capture the newly
created `BalanceManager` object id) — same contract keyspace enforces for `createAcl`.

Optional: a `sponsor` hook to route execution through the gas-station (sponsored/gasless) so
bots don't need SUI for gas. Post-MVP; the executor signature leaves room (§11, §9 Later).

---

## 4. Package layout (mirrors keyspace)

```
sdk/
├── src/
│   ├── index.ts            # public surface (re-exports)
│   ├── TriexClient.ts      # main facade: account/balances/market/orders groups
│   ├── ReadOnlyClient.ts   # indexer-only client (no executor / no signing)
│   ├── config.ts           # network + package-id + tenant resolution, defaults
│   ├── queries.ts          # indexer HTTP client (fetch + x-api-key + zod parse)
│   ├── onchain.ts          # fullnode balance reads (wallet CRED, BM BalanceKey<CRED>)
│   ├── transactions.ts     # pure PTB builders (balance_manager, pool, receipt)
│   ├── money.ts            # price scaling, fee/deposit math, decimals helpers
│   ├── types.ts            # config, executor, domain types
│   ├── schemas.ts          # zod schemas for indexer responses (versioned)
│   └── errors.ts           # TriexError enum + TriexClientError class
├── test/                   # vitest/jest unit tests (mock indexer + tx snapshot tests)
├── package.json            # ESM, exports map, peerDeps, semantic-release
├── vite.config.ts          # lib build (ES only) + vite-plugin-dts
├── tsconfig*.json
├── .releaserc.json         # semantic-release (npm publish @trinaryex/sdk)
├── DESIGN.md               # this document
└── README.md              # quick-start + API reference (write after MVP lands)
```

**Toolchain, matched to keyspace:** TypeScript ESM, `vite` lib build (ES only) +
`vite-plugin-dts`, `vitest` (keyspace uses jest; prefer **vitest** to match DCR conventions),
`eslint`/`prettier`, `semantic-release` with conventional commits, published public to npm.
`@mysten/sui` and `zod` are **peerDependencies**; the SDK bundles nothing heavy.

**Org conventions to honor** (`get_conventions scope:general`): path-based `v{N}` API
versioning (we only *consume* v1), **all timestamps are epoch-millisecond numbers** (parse
indexer timestamps as such, expose orders' `expireTimestamp` in ms), conventional-commit /
trunk-based git, no secrets committed.

---

## 5. Public API design

A **layered** design so the package can grow "higher level" later:

- **Low level (stable, testable):** `queries.ts` (one function per indexer endpoint) and
  `transactions.ts` (one pure PTB builder per Move entrypoint). No I/O coupling.
- **High level (ergonomic facade):** `TriexClient` groups methods by domain and orchestrates
  "read to resolve → build PTB → execute" flows.

### 5.1 Construction

```ts
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { TriexClient } from '@trinaryex/sdk'

const client = new TriexClient({
  // @mysten/sui v2 unified client (`.core` API) — no SuiClient/getFullnodeUrl.
  suiClient: new SuiGrpcClient({
    network: 'testnet',
    baseUrl: 'https://fullnode.testnet.sui.io:443',
  }),
  apiKey: process.env.TRIEX_API_KEY!,            // reads → x-api-key
  indexerUrl: 'https://api.trinary.exchange',    // default
  network: 'testnet',                            // selects package-id bundle
  executor: (tx) => signAndExecuteTransaction({ transaction: tx, options: { showObjectChanges: true } }),
  // packageIds optional — resolved from `network` defaults, overridable:
  // packageIds: { triexbook, multicoin, warehouseReceipts, credCoinType, clock: '0x6', ... }
})
```

`ReadOnlyClient` takes the same config minus `suiClient`/`executor` and exposes the
indexer-backed read surface with explicit identity params — for dashboards/bots that only
observe. Currency balances (a fullnode read) live on `TriexClient.balances.currency()` only.

### 5.2 Methods → user stories

```ts
// account (balance manager lifecycle)
client.account.get(address): Promise<TradingAccount | null>            // #1 read (on-chain)
client.account.ensure(): Promise<{ balanceManagerId: string; created: boolean }>  // #1 write (idempotent)

// balances — items are hub-scoped indexer reads; currency is a fullnode read
client.balances.atHub({ storageUnitId, inventoryKey? }): Promise<InventoryBalances>  // #2 (warehouse/marketplace/hangar)
client.balances.currency(address?): Promise<CurrencyBalances>          // #3 (wallet + BM CRED, head-current)

// deposits / withdrawals (#4, #5, #12, #13)
client.account.depositCurrency({ amount }): Promise<TxResult>                  // #5
client.account.depositItems({ storageUnitId, items: [{ assetId, amount }] }): Promise<TxResult>  // #4
client.account.withdrawCurrency({ amount? }): Promise<TxResult>                // #13 (default: all)
client.account.withdrawItems({ storageUnitId, characterId, items }): Promise<TxResult>  // #12

// market discovery / hub info (#6, #7, #8, #9)
client.market.discover(filters?): Promise<DiscoveryResult>            // #6
client.market.hub(hubId): Promise<TradeHubDetail>                     // #7 (vault + location/owner/visibility)
client.market.itemsAtHub(hubId): Promise<HubItemsPage>                // #8
client.market.resolvePool({ storageUnitId, assetId }): Promise<string>  // #9a (vault → resolve)
client.market.orderbook({ storageUnitId, assetId }): Promise<Orderbook>  // #9 (resting orders, not levels)
client.market.poolMetadata(poolId): Promise<PoolMetadata>             // #10/#11 (decimals + 1e9-scaled fee)

// order status (#14) — epoch-ms before/after paging
client.orders.openOrders(params?): Promise<OpenOrdersPage>
client.orders.fills(params?): Promise<FillsPage>
client.orders.trades(params?): Promise<TradesPage>

// orders (#10, #11) — each auto-ensures BM + deposits any deficit in one PTB
client.orders.limit({ storageUnitId, assetId, side, price, quantity, expireAt? }): Promise<TxResult>   // #10
client.orders.market({ storageUnitId, assetId, side, quantity, quoteBudget? }): Promise<TxResult>      // #11
```

`side: 'buy' | 'sell'` maps to `isBid`; items are identified by `assetId` (the indexer's
numeric item-type id, a string). `TxResult = { digest: string; objectChanges?: ... }`.
Amounts are `bigint` in base units; the SDK converts human ↔ base using coin/item `decimals`
and applies **price scaling** and **bid-fee overhead** in `money.ts` (see §7). Domain types
are inferred from the pinned zod wire schemas (`schemas.ts`) — single source of truth.

---

## 6. On-chain transaction builders (`transactions.ts`)

Confirmed Move entrypoints (from `triex-app-api` — personal, non-governance path). All are
pure functions `(args) => Transaction`; the facade fills object IDs from indexer reads.

| Builder | Move target | Notes |
|---|---|---|
| `newBalanceManager` | `${triexbook}::balance_manager::new()` | returns BM; `transferObjects([bm], self)` when freshly created |
| `depositCoin` | `${triexbook}::balance_manager::deposit<T>(bm, coin)` | coin prepared via list/merge/split of wallet coins |
| `depositMulticoinObject` | `${triexbook}::balance_manager::deposit_multicoin(bm, object)` | deposit an owned multicoin `Balance` object (wallet receipts) into BM |
| `withdrawAllCoin` | `${triexbook}::balance_manager::withdraw_all<T>(bm)` → `transferObjects` | #13 |
| `withdrawAllMulticoin` | `${triexbook}::balance_manager::withdraw_all_multicoin(bm, collectionId, assetId)` | #12 step 1 |
| `redeemReceipt` | `${warehouseReceipts}::receipt::redeem_receipt(balance, ssu, character, vaultConfig, collection, isOwner)` | #12 step 2 (BM item → hangar) |
| `ownerProof` | `${triexbook}::balance_manager::generate_proof_as_owner(bm)` | required before placing/withdrawing |
| `placeLimitOrderItem` | `${triexbook}::multicoin_pool::place_limit_order<Quote>(pool, bm, proof, orderType, selfMatch, price, qty, isBid, expireTs, clock)` | items (multicoin) |
| `placeMarketOrderItem` | `${triexbook}::multicoin_pool::place_market_order<Quote>(pool, bm, proof, selfMatch, qty, isBid, clock)` | items (multicoin) |
| `cancelOrderItem` | `${triexbook}::multicoin_pool::cancel_order<Quote>(pool, bm, proof, orderId, clock)` | post-MVP but confirmed present |

> `<Quote>` is the CRED coin type (`credCoinType`). Item markets are `multicoin_pool`; the
> item is identified by `collectionId` + `assetId` (u64), not a Move type parameter.

**PTB composition rules learned from the app:**
- One BM per player, **created on demand** inside the same PTB as the first order, then
  transferred to self. `ensure()` makes this explicit/idempotent.
- Orders are built as **atomic** PTBs: `[ensure BM] → deposit deficit → generate_proof →
  place_order`. If placement aborts, the deposit rolls back.
- `clock` is the shared object `0x6`. `expireTimestamp` is **epoch ms**.
- Coin selection helper (`prepareWalletCoinInput`): `listCoins` → accumulate → `mergeCoins`
  → `splitCoins(amount)`; throws a typed `InsufficientBalance` error if short.

### 6.1 Direct-from-hangar item sourcing (resolves OQ-4)

A player can fund an item sell order **directly from their hangar** in the same PTB — the app
does this in `useTriexbookMulticoinOrders.ts`. The SDK ports this as `sourceItemsIntoBm(...)`,
covering a deposit deficit from two sources in order:

1. **Wallet multicoin receipts.** Find owned `${multicoin}::multicoin::Balance` objects for the
   `assetId` in the right collection, then for each:
   `balance_manager::deposit_multicoin(bm, object)`.
2. **SSU / character hangar inventory** (only if a deficit remains). For each relevant owner cap
   (SSU owner cap and/or character owner cap):

   ```
   [cap, borrowReceipt] = character::borrow_owner_cap<CapType>(character, receivingRef(capRef))
   [receipt]            = receipt::deposit_for_receipt<CapType>(
                              ssuObject, character, cap, vaultConfigId,
                              vaultCollectionId, assetId /*u64*/, amount /*u32*/)
   character::return_owner_cap<CapType>(character, cap, borrowReceipt)
   balance_manager::deposit_multicoin(bm, receipt)
   ```

**Inputs the SDK must resolve first:**
- `vaultConfigId`, `vaultCollectionId` — from `GET /v1/hubs/{hub_id}/vault` (indexer) keyed off
  the SSU (`storageUnitId` → `0x`-padded 64-hex object id).
- `characterId` + owner-cap object IDs — on-chain (`fetchCharacterInfo` equivalent via
  `suiClient`), plus the cap object's `version`/`digest` for `tx.receivingRef` (fullnode read).
- `worldPackageId` (and `worldOriginalPackageId` for the cap type arg) — from the `stillness`
  package-id set (§8).

The **withdraw-items** path (#12) is the mirror: `withdraw_all_multicoin` → `redeem_receipt`
back into the SSU/hangar (needs `ssu`, `character`, `vaultConfig`, `collection`, `isOwner`).

> This adds `worldPackageId`/`worldOriginalPackageId` and the SSU-owner-cap resolution to the
> SDK's responsibilities — heavier than a plain coin deposit. It's the most involved builder
> in the MVP and the first integration-test target on a live testnet SSU.

---

## 7. Money math (`money.ts`)

- **Coin (currency-pair) pools:** `quote = base * price / TRIEXBOOK_PRICE_SCALING`
  where `TRIEXBOOK_PRICE_SCALING = 1_000_000_000` (1e9).
- **Multicoin (item) pools:** scaling factor `1` → `quote = price * quantity` (confirmed
  against the production app, which passes the unscaled price straight to
  `place_limit_order`; TRIEX_SYSTEM_DESIGN §7's blanket "all prices ×1e9" describes coin
  pools).
- **Bid deposit overhead:** v1 pools charge a **quote-denominated fee**; a bid must deposit
  `quote × (1e9 + feeRateScaled) / 1e9` (floor-of-total — matches the app's
  `computeBidQuoteDeposit` and the on-chain per-fill floor). `feeRateScaled` is pool
  metadata's raw `fee` (scaled by 1e9; `20_000_000` = 2%, the default volatile fee) — the
  endpoint exposes **no bps field**. Only buyers pay fees; asks are fee-free. Market bids
  require an explicit `quoteBudget` (the app requires `quoteDepositAmount > 0`).
- **Decimals:** CRED and each item type carry `decimals` (pool metadata's
  `base_asset_decimals` / `quote_asset_decimals`); the SDK exposes both `bigint` base-unit
  and helper `toBase(human, decimals)` / `fromBase(base, decimals)`.
- **Pool version:** the SDK **always assumes v1** (it supports only the most-recent
  contracts), so v1 fee treatment is hard-coded. No multi-version branching (resolves OQ-6).

> Getting scaling/fees wrong silently over/under-funds orders. `money.ts` is the highest-risk
> unit-test target: snapshot tests against known app values.

---

## 8. Configuration & package IDs (`config.ts`)

**Canonical source (resolves OQ-2):** package IDs live in `triex-app-api`
`src/constants/tenants.ts` under the **`stillness`** tenant (the testnet world; also
`DEFAULT_TENANT`). `triex-app-api` already exposes them at
`GET /api/v1/package-ids?tenant=stillness` (env-override-applied, `Cache-Control: max-age=60`)
— **but that endpoint returns Move *package* IDs only; registry / shared-object IDs are
excluded**. The current stillness trading IDs (for the SDK `testnet` preset):

```
triexPackageId            0x291b9da738dffedd18d7c5049e5e6792270202e03f3c9d9db4c7097670bf6eb2
triexRegistryId           0x14a58f254b8243bf3f74c057d81cc310498b3d0fe3781650ad58405d7e5f17e4   (shared obj — not in /package-ids)
multicoinPackageId        0x99a4c039477ac7e7affcb5a5609dd23c29ab69e9436e740d94a4e168c2506cfb
warehouseReceiptsPackageId 0x0c9d4414aa12eaa1ebf9d32437c1e6403fbf941ffcdca5b9ca16d1769313417e
credCoinType              0xfbcbd9155669e157ce3999e073930b4c4b67255c3cf88d0d80c76342a31e6710::cred::CRED
worldPackageId            0x8b8a46ed766fa1358ce7c5c51f6a164b13d627a63e45343f69ed0ba0446c1aa1   (= worldOriginalPackageId)
clock                     0x6
```

**SDK strategy:** ship a `testnet`/`stillness` **preset baked into the release** (single
supported world + always-latest contracts per §Contract versioning), each field overridable
via `packageIds`. Optionally hydrate the *package* IDs at runtime from
`/api/v1/package-ids?tenant=stillness` **iff** that route is externalized through the gateway
(it's a `triex-app-api` route, not `etl-api` — needs a gateway route to be reachable at
`api.trinary.exchange`; otherwise it's origin-only). Registry/shared-object IDs
(`triexRegistryId`, vault registry, etc.) stay baked in since `/package-ids` omits them.

---

## 9. Phasing / milestones

- **Phase 0 — Gateway enablement. ✅ DONE 2026-08-21.** Market surface enabled in DCR
  `62acb22`; `GET /v1/inventory/balances` in `feat/publish-inventory-balances` (published
  to the running gateway). Two inventory routes stay disabled by design (D11) with
  fullnode alternatives — see §2. Remaining nit: merge the balances branch to `main` so
  the next `push-gateway.sh` run doesn't revert it.
- **Phase 1 — Read core. ✅ DONE 2026-08-21.** `queries.ts` + `schemas.ts` (pinned against
  the committed etl-api upstream spec — RQ-1) + `ReadOnlyClient`: discovery, hub details,
  items-at-hub, pool resolve (vault → collection+asset chain), orderbook, pool metadata,
  hub-scoped item balances, order-status reads. Currency balances implemented as fullnode
  reads (`onchain.ts`, ported from the app's production hooks). Domain types inferred from
  the zod schemas.
- **Phase 2 — Account lifecycle + deposits/withdrawals.** `transactions.ts` for BM create,
  deposit currency/items, withdraw currency/items; facade `account.*` methods. `money.ts`.
- **Phase 3 — Orders.** limit + market, buy + sell (item/CRED `multicoin_pool`);
  direct-from-hangar item sourcing (§6.1); deficit-deposit composition; atomic PTBs.
- **Phase 3.5 — Order-status reads (in MVP).** `balance-managers/{bm}/open-orders`, `/fills`,
  `/trades` — pulled into MVP for bots (story #14). Cheap once the balance-manager routes are
  enabled in Phase 0.
- **Phase 4 — Packaging & docs.** README quick-start, examples (browser wallet + bot
  keypair), semantic-release → publish `@trinaryex/sdk@0.x`.
- **Later (post-MVP):** cancel/modify orders, sweep-all convenience, tribe/governance trading,
  **gas-station sponsored (gasless) execution** (optional `sponsor` hook), live orderbook
  streaming, mainnet, coin-pools (currency-pair markets).

---

## 10. Auth & developer onboarding

- **Reads:** developer supplies an **API key** in the `x-api-key` header. Keys are minted
  through the Developer API Keys panel / `stele` (surfaced in the app's `/settings`), billed
  per-request in **Compute Units** against a rate-limit tier (`free`/`standard`/`growth`/…;
  see `rate-limit-tiers/tiers.json`). SDK docs link **https://docs.trinary.exchange/docs/api-keys**,
  which directs users to **trinary.exchange/settings** to create the key (resolves OQ-3).
- **Writes:** developer supplies a Sui **signer** (wallet in browser, keypair for bots) via
  `executor`. The SDK never sees private keys. Bots need SUI for gas unless sponsored.

---

## 11. Decisions & remaining questions

### Resolved (2026-08-15)

- **OQ-1 — Gateway enablement is work-to-do, not a policy blocker.** We own the routes and
  will expose them; Phase 0 just needs doing (dev → prd). CU costs default to the values
  already in `etl-api.json`.
- **OQ-2 — Package IDs:** source of truth is the `stillness` tenant in `triex-app-api`
  (`GET /api/v1/package-ids?tenant=stillness`, package IDs only). SDK bakes a `testnet`
  preset; registry/shared IDs baked in (see §8).
- **OQ-3 — Docs:** https://docs.trinary.exchange/docs/api-keys → create key at
  trinary.exchange/settings (§10).
- **OQ-4 — Direct-from-hangar sourcing** fully mapped from `useTriexbookMulticoinOrders.ts`
  (borrow_owner_cap → receipt::deposit_for_receipt → return_owner_cap → deposit_multicoin);
  see §6.1.
- **OQ-5 — Ignore coin-pools.** MVP trades **item↔CRED** via `multicoin_pool` ("pools" family
  only). Coin-pools deferred.
- **OQ-6 — Always v1.** SDK supports only the newest contracts; no version branching (§7).
- **OQ-7 — Gas:** left to the caller's `executor`; sponsored/gasless is a **post-MVP** feature
  (optional `sponsor` hook).
- **OQ-8 — testnet only** (stillness).
- **OQ-9 — `/v1/discovery`** = open orders sorted by recency with filters; it's the discovery
  primitive for #6. Finalize `DiscoveryResult` against its response shape in Phase 1.
- **OQ-10 — Order-status reads are IN the MVP** (story #14, Phase 3.5).
- **OQ-11 — Identity:** for now assume **one address ↔ one character ↔ one BM**; the balances
  read stitches wallet + hangar + BM under that assumption.

### Resolved (2026-08-21, Phase 0/1)

- **RQ-1 — Response schemas: pinned** in `schemas.ts` against the committed upstream spec
  (`dynamic-config-registry/upstream-specs/etl-api.json`). Notable deltas from the draft:
  `pools/resolve` is keyed by `collection_id`+`asset_id` (hub flows resolve the vault
  first); the orderbook returns resting **orders**, not aggregated levels; pool metadata
  exposes the fee as a 1e9-scaled `fee` string (no bps field); hub vault/location carry
  no tribe/fuel fields (post-MVP).
- **RQ-4 — `inventory/balances` keying:** hub-scoped (`storage_unit_id` required, one hub
  per call); sections selected by explicit params — `owner_address` → warehouse,
  `balance_manager_id` → marketplace, `inventory_key` (owner-cap id) → hangar. It serves
  **items only** — CRED (#3) is NOT in the endpoint, so currency balances are fullnode
  reads (`balances.currency()`), which write-flow deficit math wants anyway (§12).

### Remaining (resolve during Phase 2/3)

- **RQ-2:** Is `GET /api/v1/package-ids` reachable via `api.trinary.exchange`, or origin-only?
  If not routed through the gateway, the SDK just uses the baked-in preset (fine for MVP).
- **RQ-3:** `receipt::deposit_for_receipt` cap-type argument (`<CapType>`) and which owner cap
  (SSU vs character) applies for a **personal, non-tribe** player at their own SSU vs a public
  hub. Confirm on a live stillness SSU during Phase 2 integration testing.

---

## 12. Indexer lag & consistency

The indexer (etl-api) trails chain head by a few seconds. **This is not a correctness problem
for writes; it's a UX/efficiency concern with two edges to design around.**

**Why writes are safe regardless of lag.** Every mutation is validated against *actual
on-chain state* by Sui validators, and each order is an **atomic PTB** (deposit + proof +
place bundled). A stale indexer read can only ever produce a transaction that **aborts and
rolls back** — never a corrupt state or lost funds:

- Deposit deficit computed from a stale **too-low** balance → harmless over-deposit (funds sit
  safely in the BM, usable by the next order).
- Deposit deficit from a stale **too-high** balance → the order aborts on-chain; retryable.
- Market/limit order sized against a few-seconds-old book → ordinary market slippage.

**Edge 1 — double balance-manager creation (story #1).** "One BM per player" is a *convention*,
not on-chain-enforced, so a stale "no BM" read right after creation could mint a second BM.
Mitigations (all adopted):
1. `account.ensure()` resolves the BM id via an **on-chain `listOwnedObjects`** (a cheap,
   head-current, correctness-critical single lookup), not the indexer.
2. The client **caches the BM id** after first create/read (read-your-writes).
3. Callers may pass a known `balanceManagerId` to skip discovery entirely.

**Edge 2 — read-your-writes for freshly created objects.** Every write returns object IDs from
`objectChanges` (new BM id, new order id). Bots should trust those over an immediate indexer
re-read. Optional `waitForTx`/confirm helper; optional short client-side cache (TTL) so a
just-submitted state isn't clobbered by a lagging read.

**Not affected by lag:** PTB *input* resolution (owner-cap `version`/`digest` for
`tx.receivingRef`, coin/receipt object selection) reads the **fullnode**, which is always
head-current. "Indexer-only" scopes market/account *data*, not transaction inputs.

**Docs stance:** the README states plainly that read endpoints are eventually-consistent
(seconds), on-chain writes are authoritative, and post-write reads should prefer returned
object IDs. For latency-sensitive bots, note the post-MVP live-stream option.

---

## 13. Appendix — current `etl-api` gateway route inventory

From `dynamic-config-registry/gateway-routes/etl-api.json` (65 routes), **as of 2026-08-21**
(DCR `62acb22` + `feat/publish-inventory-balances`). Phase 0 is done: everything the MVP
reads is live.

**Enabled — MVP reads** (CU costs as published):

```
GET /v1/discovery                                          (150 CU)  # story 6 — repriced 30 → 150 (2 rps sustained on free/standard)
GET /v1/inventory/balances                                 (50 CU)   # story 2 (items only; hub-scoped)
GET /v1/hubs/{hub_id}/vault                                (20 CU)   # stories 4,7,9 (vaultConfig/collection)
GET /v1/hubs/{hub_id}/location                             (20 CU)   # story 7 (location/owner/visibility)
GET /v1/hubs/{hub_id}/items                                (20 CU)   # story 8
GET /v1/collections/{collection_id}/hub                    (20 CU)   # story 7 reverse lookup
GET /v1/pools/resolve                                      (30 CU)   # stories 9,10,11 (collection+asset → poolId)
GET /v1/pools/{pool_id}/orderbook                          (30 CU)   # story 9
GET /v1/pools/{pool_id}/metadata                           (20 CU)   # stories 10,11 (1e9-scaled fee)
GET /v1/balance-managers/{balance_manager_id}/open-orders  (30 CU)   # story 14
GET /v1/balance-managers/{balance_manager_id}/fills        (30 CU)   # story 14
GET /v1/balance-managers/{balance_manager_id}/trades       (30 CU)   # story 14
```

(Also enabled beyond MVP need: `/v1/balance-managers/{bm}/sweepable`, `/owners`, the wider
pools/hubs/assets/activity families, `GET /v1/characters/*`, `GET /v1/orgs*`,
`GET /v1/search` (100 CU), `GET /v1/stats`, `GET /v1/trades/recent`.)

**Deliberately disabled (D11 — sluice attaches no caller identity):** the remaining
`inventory` family, including the seven POST container mutations and two GETs the SDK
replaces with fullnode reads — `GET /v1/inventory/balance-manager` (story 1: on-chain
`listOwnedObjects` is authoritative) and `GET /v1/inventory/receipt-objects` (story 4:
wallet-receipt discovery is PTB input resolution). `coin-pools/*` stays disabled by choice.

> Remember a merge to `main` does **not** update the running gateway — run
> `scripts/push-gateway.sh --env <env>` (per CLAUDE.md). The balances route is already
> published; its branch still needs merging to `main` so a future publish from a clean
> checkout doesn't revert it.

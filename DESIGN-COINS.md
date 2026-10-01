# Coin markets (`client.coins`) — design

**Status:** implemented (cycle 7). Lifts DESIGN.md OQ-5 ("ignore coin-pools").
**Contract:** trinary-exchange `packages/triex/sources` after PR #23
("refactor/merge-coin-pool-fork") — coin pools now live in the main `triex`
package: `pool.move`, `coin_order_query.move`, `vault/coin_vault.move`, sharing
`book/`, `state/`, `fee_policy.move` and `trading_account.move` with item pools.
**Code:** `src/coins/` — `transactions.ts` (pure builders), `onchain.ts`
(fullnode reads), `money.ts` (math), `funding.ts` (wallet → account),
`schemas.ts` + `types.ts`, `CoinsApi.ts` (facade).

A coin pool is `triex::pool::Pool<Base, Quote>` — a CLOB between two Move coin
types. Permissionless pools are quoted in CRED; admin pools may pair anything.

---

## 1. Where the data comes from

| Read | Source | Why |
|---|---|---|
| Coin list + market summary | `GET /v1/coins` (gateway, 30 CU) → `coins.list()` | the one coin route the gateway publishes |
| Pool id for a pair | simulate `pool::get_pool_id_by_asset<B,Q>(registry)` | `/v1/coin-pools/*` is not on the gateway |
| Pool types from an id | `getObject` → `…::pool::Pool<B, Q>` type params | one cheap read; cached per client |
| Book | simulate `coin_order_query::iter_orders` (paged, exclusive cursor, `min_expire = now`) | the module exists for exactly this; it is not an entry fun, so it is devInspected |
| Fees | simulate `pool_trade_params`, `pool_fee_schedule_next`, `pool_fee_class` → `fee_policy::cancel_retention_bps`, and `trade_params_for_account` / `account_fee_tier` / `account_fee_turnover` | the live `FeePolicy`, incl. staged schedules and maker rates the indexer does not expose |
| Account state | simulate `pool::account` + `pool::locked_balance` | settled / owed / locked, head-current |
| Open orders | simulate `pool::get_account_order_details` | |
| Dry-run | simulate `get_quantity_out_input_fee` / `get_quantity_out_for_account` | the contract's own quote |
| Coin balances | `listCoins` + trading-account `BalanceKey<T>` dynamic field | generic version of `balances.currency()` |

"Simulate" is `core.simulateTransaction({ include: { commandResults: true },
checksEnabled: false })` — the v2 devInspect, verified live on testnet (zero
sender, no gas objects needed). Return values are BCS-decoded with layouts
mirrored from the Move structs (`CoinOrderBcs`, `CoinOrderPageBcs`,
`CoinPoolAccountBcs`, `CoinFeeScheduleBcs`). A view that asserts (missing pool,
account never traded here) comes back as a failed simulation → `null` /
`PoolNotFound`.

`ReadOnlyClient` gained an optional `suiClient`; only `coins.*` uses it.

## 2. Entry points

### Wrapped

| Move | SDK |
|---|---|
| `pool::place_limit_order` (= `…_with_quote_fees`) | `coins.limit` · `coinTransactions.placeCoinLimitOrder` |
| `pool::place_market_order` (= `…_with_quote_fees`) | `coins.market` · `placeCoinMarketOrder` |
| `pool::swap_exact_quote_for_base` / `swap_exact_base_for_quote` | `coins.swap` · `swapExactQuoteForBase` / `swapExactBaseForQuote` |
| `pool::cancel_order` / `cancel_orders` / `cancel_all_orders` | `coins.cancel` / `cancelMany` / `cancelAll` |
| `pool::modify_order` | `coins.modify` |
| `pool::withdraw_settled_amounts` | `coins.claimSettled` (multi-pool, optional sweep to wallet) |
| `pool::create_permissionless_pool` | `coins.createPool` (500 CRED from the wallet) |
| `trading_account::deposit<T>` / `withdraw<T>` / `withdraw_all<T>` | `coins.deposit` / `coins.withdraw` (any coin; SUI via the gas coin) |
| views listed in §1 | `coins.resolvePool` · `orderbook` · `tradeParams` · `account` · `openOrders` · `quote` · `estimateMarket` · `balances` |

Builder-only (no facade): `swap_exact_*_with_trading_account` (need
`TradeCap` + `DepositCap` + `WithdrawCap` — delegated traders; an owner uses
`market`), `withdraw_settled_amounts_permissionless` (push settlement into
someone else's account), `coin::zero`, `currencyObjectId`.

### Excluded

| Move | Why |
|---|---|
| `swap_exact_quantity` | the generic form of the two wrapped swaps |
| `create_pool_admin`, `unregister_pool_admin`, `set_pool_fee_class`, `update_allowed_versions`, `withdraw_pool_fees` | `TriexAdminCap` |
| `update_pool_allowed_versions` | permissionless upgrade maintenance, not trading |
| `get_quote_quantity_out`, `get_base_quantity_out`, `*_input_fee`, `get_quantity_out` | aliases of the wrapped dry-run |
| `get_order`, `get_orders`, `account_open_orders` | covered by `openOrders` / `account` |
| `vault_balances`, `quote_fee_reserve_balance`, `locked_maker_fees`, `withdrawable_pool_fees`, `registered_pool`, `id`, `pool_fee_schedule` | pool accounting / admin introspection |
| stake, governance, flashloans, referrals | commented out in the contract |

Note the asymmetry with item pools: **coin cancel / cancel-many / cancel-all /
modify / settle take no `FeePolicy`**; `multicoin_pool`'s do.

## 3. Money model (cycle 7)

All integers raw; rates 1e9-scaled (`FLOAT_SCALING`), whole basis points.

- **Price:** `quote = floor(base × price / 1e9)` — `math::qty_to_quote`
  (math.move:17). Human price = `raw / 10^(9 + Dq − Db)`; pool creation keeps
  `|Dq − Db| ≤ 9` (pool.move:1502).
- **Sizes:** no lot or tick size exists any more. Price ∈ `[1, 2^63−1]`
  (constants.move:7-8). A resting order needs `quantity ≥ ceil(1e9 / price)`
  — `math::min_qty_for_nonzero_quote` (math.move:85), asserted in
  `order_info::validate_inputs` (order_info.move:476). Market orders skip it.
  The SDK validates both before signing. (etl's `min_size/lot_size/tick_size`
  fields are pre-cycle-7 leftovers.)
- **Fee unit:** `fee = floor(quote × min(rate, 1e9) / 1e9)` —
  `quote_fee::fee_from_scaled_rate` (quote_fee.move:35). Exported as
  `coinQuoteFee`.
- **Rates:** resolved per order from the shared `FeePolicy` by the pool's fee
  class and the trader's trailing turnover (pool.move:1598-1609). Genesis coin
  class: 1.10% taker / 0.90% maker at the entry rung (fee_policy.move:74-96;
  confirmed live: class 0). Ladders are monotone non-increasing on both sides
  (fee_schedule.move:143-144), so the entry rung bounds every tier; schedule
  changes are staged one epoch ahead (`pool_fee_schedule_next`).
- **Who pays (order_info.move:349-429):**
  - bid taker — `floor(t × Σfill quote)` charged **once on the aggregate**,
    on top of the quote owed;
  - bid maker — `floor(m × resting quote)` **escrowed at placement**
    (locked in the vault's fee reserve; refunded on cancel/modify/expiry minus
    `cancel_retention_bps`, 20% at genesis — order.move:279);
  - ask taker — floored once on the aggregate, **out of the proceeds**;
  - ask maker — per fill, out of the proceeds (fill.move:180).
  Asks therefore deposit only base.
- **Settlement:** `coin_vault::settle_trading_account` (coin_vault.move:171)
  withdraws `owed − settled` per asset from the trading account, so funds
  already settled in the pool offset what is pulled (the SDK ignores that
  offset — over-funding is safe, the remainder stays in the account).

### Bid deposit (never under-funded)

```
deposit = Q + floor(r × Q / 1e9),   Q = floor(quantity × price / 1e9)
r       = max(entry taker, entry maker, staged taker, staged maker)
```

Proof sketch: filled quote `Qf = Σ floor(fᵢ × pᵢ / 1e9)` with every
`pᵢ ≤ price`, resting quote `Qr = floor(rest × price / 1e9)`; `Qf + Qr ≤ Q`.
Owed = `Qf + floor(t·Qf) + Qr + floor(m·Qr) ≤ Q + floor(r·Q)` because floors
are subadditive. `test/coins-money.test.ts` brute-forces 2,000 random
order/fill splits against the exact settlement formula. Note
`Q + floor(r·Q/1e9) ≡ floor(Q·(1e9 + r)/1e9)` — the same shape as the item
`computeBidQuoteDeposit`; only the choice of `r` differs (taker-only from the
indexer there, live max-of-four here). `Q` floors where the app's
`computeCoinBidQuoteDeposit` ceils, so at the same rate the SDK never deposits
more than the app (at genesis the max-of-four is the 1.10% taker rate the app
uses).

### Market buy budget

`estimateCoinMarketOrder` replays `book::match_against_book` /
`order_info::match_maker` on the head-current book: makers in priority
order, at most `MAX_FILLS = 100` visited (constants.move:56), zero-quote
makers retired, zero-quote residues skipped, per-fill floored quote, taker fee
floored once at the conservative taker rate. `coins.market` holds exactly that
`totalQuote` unless `quoteBudget` is given; if the book moves against you the
settlement withdrawal aborts and the whole PTB rolls back.

### Swaps

`swap_exact_*` run a market order on a temporary trading account priced at
the **entry rung** (pool.move:381-435), so `coins.quote` without a
`tradingAccountId` is exactly what `coins.swap` is charged. `minOut` defaults
to that dry-run less 50 bps.

## 4. Composition

Mirrors triex-app-api `useTriexbookCoinOrders.ts`:
`[trading_account::new] → deposit deficit (deposit<T>) →
generate_proof_as_owner → pool::place_*_order<B,Q> → [transfer new account]`
in one PTB. Wallet coins are merged + split; SUI is split from `tx.gas`
(selecting SUI coin objects would collide with gas payment).

## 5. Open questions

- No coin pool exists on the cycle-7 testnet publish yet (no
  `pool::Pool` objects or `PoolCreated` events), so the write paths are
  verified by command-level tests and the read layouts by live decode of the
  shared structs only. Run a live limit/market/cancel once a pool exists.
- `/v1/coin-pools/*` (books, account open-orders/fills/trades, recent trades)
  stays off the gateway; coin fills/trade history are therefore not in the SDK.
  Publishing those routes would let `coins.fills/trades` follow the item shape.
- `/v1/coins` `market.fee` is the entry taker rate only; it is display data.

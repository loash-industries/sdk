import type {
  Transaction,
  TransactionArgument,
  TransactionObjectArgument,
  TransactionResult,
} from '@mysten/sui/transactions'
import {
  SUI_COIN_REGISTRY_OBJECT_ID,
  deriveObjectID,
  normalizeStructTag,
} from '@mysten/sui/utils'
import type { PackageIds } from '../types'

/**
 * Pure PTB builders for coin (currency-pair) pools —
 * `triex::pool::Pool<BaseAsset, QuoteAsset>` and
 * `triex::coin_order_query`. Each APPENDS Move calls to a caller-provided
 * `tx`; none execute. Verified against the cycle-7 contract
 * (trinary-exchange `packages/triex/sources/pool.move`,
 * `coin_order_query.move`).
 *
 * Differences from the item (`multicoin_pool`) builders worth knowing:
 *   - Two type arguments, `<Base, Quote>`, both full coin types.
 *   - Placement and swaps take the shared `FeePolicy`; cancel, cancel-many,
 *     cancel-all, modify and settle do NOT (unlike `multicoin_pool`).
 *   - Prices are 1e9-scaled (see `coins/money.ts`).
 */

/** Type arguments `<Base, Quote>` of one coin pool. */
export interface CoinPoolTypes {
  poolId: string
  baseCoinType: string
  quoteCoinType: string
}

const typeArgs = (p: CoinPoolTypes) => [p.baseCoinType, p.quoteCoinType]

// ─── Orders ──────────────────────────────────────────────────────────────────

export interface PlaceCoinLimitOrderArgs extends CoinPoolTypes {
  account: TransactionObjectArgument
  proof: TransactionObjectArgument
  /** Raw 1e9-scaled price. */
  price: bigint
  /** Base quantity (raw). */
  quantity: bigint
  isBid: boolean
  /** u8; 0 = none, 1 = IOC, 2 = FOK, 3 = POST_ONLY. Default 0. */
  orderType?: number
  /** u8; 0 = allowed, 1 = cancel taker, 2 = cancel maker. Default 0. */
  selfMatchingOption?: number
  /** Epoch milliseconds. */
  expireTimestamp: bigint
}

/**
 * `pool::place_limit_order<Base, Quote>(pool, policy, account, proof,
 * orderType, selfMatchingOption, price, quantity, isBid, expireTimestamp,
 * clock)` → `OrderInfo` (droppable; ignore it). Identical to
 * `place_limit_order_with_quote_fees`, which it delegates to.
 */
export function placeCoinLimitOrder(
  tx: Transaction,
  ids: PackageIds,
  args: PlaceCoinLimitOrderArgs,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::pool::place_limit_order`,
    typeArguments: typeArgs(args),
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      args.account,
      args.proof,
      tx.pure.u8(args.orderType ?? 0),
      tx.pure.u8(args.selfMatchingOption ?? 0),
      tx.pure.u64(args.price),
      tx.pure.u64(args.quantity),
      tx.pure.bool(args.isBid),
      tx.pure.u64(args.expireTimestamp),
      tx.object(ids.clock),
    ],
  })
}

export interface PlaceCoinMarketOrderArgs extends CoinPoolTypes {
  account: TransactionObjectArgument
  proof: TransactionObjectArgument
  quantity: bigint
  isBid: boolean
  selfMatchingOption?: number
}

/**
 * `pool::place_market_order<Base, Quote>(pool, policy, account, proof,
 * selfMatchingOption, quantity, isBid, clock)` — an IOC at MAX/MIN price;
 * any unfilled quantity is cancelled.
 */
export function placeCoinMarketOrder(
  tx: Transaction,
  ids: PackageIds,
  args: PlaceCoinMarketOrderArgs,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::pool::place_market_order`,
    typeArguments: typeArgs(args),
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      args.account,
      args.proof,
      tx.pure.u8(args.selfMatchingOption ?? 0),
      tx.pure.u64(args.quantity),
      tx.pure.bool(args.isBid),
      tx.object(ids.clock),
    ],
  })
}

interface CoinAccountArgs extends CoinPoolTypes {
  account: TransactionObjectArgument
  proof: TransactionObjectArgument
}

/** `pool::cancel_order<Base, Quote>(pool, account, proof, orderId u128, clock)`. */
export function cancelCoinOrder(
  tx: Transaction,
  ids: PackageIds,
  args: CoinAccountArgs & { orderId: bigint },
): void {
  tx.moveCall({
    target: `${ids.triex}::pool::cancel_order`,
    typeArguments: typeArgs(args),
    arguments: [
      tx.object(args.poolId),
      args.account,
      args.proof,
      tx.pure.u128(args.orderId),
      tx.object(ids.clock),
    ],
  })
}

/**
 * `pool::cancel_orders<Base, Quote>(pool, account, proof, vector<u128>, clock)`
 * — all-or-nothing: one bad id aborts the whole batch.
 */
export function cancelCoinOrders(
  tx: Transaction,
  ids: PackageIds,
  args: CoinAccountArgs & { orderIds: bigint[] },
): void {
  tx.moveCall({
    target: `${ids.triex}::pool::cancel_orders`,
    typeArguments: typeArgs(args),
    arguments: [
      tx.object(args.poolId),
      args.account,
      args.proof,
      tx.pure.vector('u128', args.orderIds),
      tx.object(ids.clock),
    ],
  })
}

/** `pool::cancel_all_orders<Base, Quote>(pool, account, proof, clock)`. */
export function cancelAllCoinOrders(
  tx: Transaction,
  ids: PackageIds,
  args: CoinAccountArgs,
): void {
  tx.moveCall({
    target: `${ids.triex}::pool::cancel_all_orders`,
    typeArguments: typeArgs(args),
    arguments: [
      tx.object(args.poolId),
      args.account,
      args.proof,
      tx.object(ids.clock),
    ],
  })
}

/**
 * `pool::modify_order<Base, Quote>(pool, account, proof, orderId, newQuantity,
 * clock)` — reduce a resting order (new < original, > filled, and the new
 * remainder ≥ `coinMinOrderQuantity(price)`).
 */
export function modifyCoinOrder(
  tx: Transaction,
  ids: PackageIds,
  args: CoinAccountArgs & { orderId: bigint; newQuantity: bigint },
): void {
  tx.moveCall({
    target: `${ids.triex}::pool::modify_order`,
    typeArguments: typeArgs(args),
    arguments: [
      tx.object(args.poolId),
      args.account,
      args.proof,
      tx.pure.u128(args.orderId),
      tx.pure.u64(args.newQuantity),
      tx.object(ids.clock),
    ],
  })
}

/**
 * `pool::withdraw_settled_amounts<Base, Quote>(pool, account, proof)` — move
 * the account's settled (post-fill / post-cancel) balances in this pool into
 * the trading account.
 */
export function withdrawSettledCoinAmounts(
  tx: Transaction,
  ids: PackageIds,
  args: CoinAccountArgs,
): void {
  tx.moveCall({
    target: `${ids.triex}::pool::withdraw_settled_amounts`,
    typeArguments: typeArgs(args),
    arguments: [tx.object(args.poolId), args.account, args.proof],
  })
}

/**
 * `pool::withdraw_settled_amounts_permissionless<Base, Quote>(pool, account)` —
 * anyone may push an account's settled balances into it (no proof). Aborts
 * when the account owes the pool anything or has nothing settled.
 */
export function withdrawSettledCoinAmountsPermissionless(
  tx: Transaction,
  ids: PackageIds,
  args: CoinPoolTypes & { account: TransactionObjectArgument },
): void {
  tx.moveCall({
    target: `${ids.triex}::pool::withdraw_settled_amounts_permissionless`,
    typeArguments: typeArgs(args),
    arguments: [tx.object(args.poolId), args.account],
  })
}

// ─── Swaps (wallet coins in, coins out — no trading account) ─────────────────

/** `0x2::coin::zero<T>()` — e.g. the `cred_in` placeholder swaps require. */
export function zeroCoin(tx: Transaction, coinType: string): TransactionResult {
  return tx.moveCall({
    target: '0x2::coin::zero',
    typeArguments: [coinType],
    arguments: [],
  })
}

export interface CoinSwapArgs extends CoinPoolTypes {
  /** The coin being spent: `Coin<Base>` for sells, `Coin<Quote>` for buys. */
  coinIn: TransactionObjectArgument
  /** A `Coin<CRED>`; returned unchanged (pass `zeroCoin(tx, cred)`). */
  credIn: TransactionObjectArgument
  /** Minimum output (quote for sells, base for buys) or the swap aborts. */
  minOut: bigint
}

/**
 * `pool::swap_exact_base_for_quote<Base, Quote>(pool, policy, baseIn, credIn,
 * minQuoteOut, clock)` → `[Coin<Base> leftover, Coin<Quote> out, Coin<CRED>]`.
 * Charged at the entry-rung taker rate (the temporary account has no history).
 */
export function swapExactBaseForQuote(
  tx: Transaction,
  ids: PackageIds,
  args: CoinSwapArgs,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::pool::swap_exact_base_for_quote`,
    typeArguments: typeArgs(args),
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      args.coinIn,
      args.credIn,
      tx.pure.u64(args.minOut),
      tx.object(ids.clock),
    ],
  })
}

/**
 * `pool::swap_exact_quote_for_base<Base, Quote>(pool, policy, quoteIn, credIn,
 * minBaseOut, clock)` → `[Coin<Base> out, Coin<Quote> leftover, Coin<CRED>]`.
 */
export function swapExactQuoteForBase(
  tx: Transaction,
  ids: PackageIds,
  args: CoinSwapArgs,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::pool::swap_exact_quote_for_base`,
    typeArguments: typeArgs(args),
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      args.coinIn,
      args.credIn,
      tx.pure.u64(args.minOut),
      tx.object(ids.clock),
    ],
  })
}

/** Delegated-cap swap inputs (`trading_account::mint_*_cap` holders). */
export interface CoinCapSwapArgs extends CoinPoolTypes {
  account: TransactionObjectArgument
  tradeCap: TransactionObjectArgument
  depositCap: TransactionObjectArgument
  withdrawCap: TransactionObjectArgument
  coinIn: TransactionObjectArgument
  minOut: bigint
}

/**
 * `pool::swap_exact_base_for_quote_with_trading_account<Base, Quote>(pool,
 * policy, account, tradeCap, depositCap, withdrawCap, baseIn, minQuoteOut,
 * clock)` → `[Coin<Base>, Coin<Quote>]`, priced at the account's own tier.
 * For delegated traders holding all three caps; an owner uses
 * `placeCoinMarketOrder` instead.
 */
export function swapExactBaseForQuoteWithTradingAccount(
  tx: Transaction,
  ids: PackageIds,
  args: CoinCapSwapArgs,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::pool::swap_exact_base_for_quote_with_trading_account`,
    typeArguments: typeArgs(args),
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      args.account,
      args.tradeCap,
      args.depositCap,
      args.withdrawCap,
      args.coinIn,
      tx.pure.u64(args.minOut),
      tx.object(ids.clock),
    ],
  })
}

/** The quote-in mirror of {@link swapExactBaseForQuoteWithTradingAccount}. */
export function swapExactQuoteForBaseWithTradingAccount(
  tx: Transaction,
  ids: PackageIds,
  args: CoinCapSwapArgs,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::pool::swap_exact_quote_for_base_with_trading_account`,
    typeArguments: typeArgs(args),
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      args.account,
      args.tradeCap,
      args.depositCap,
      args.withdrawCap,
      args.coinIn,
      tx.pure.u64(args.minOut),
      tx.object(ids.clock),
    ],
  })
}

// ─── Pool creation ───────────────────────────────────────────────────────────

/**
 * Object id of the shared `0x2::coin_registry::Currency<T>` for a coin type —
 * derived from the CoinRegistry (`0xc`) under `CurrencyKey<T> {}`. Pool
 * creation reads both coins' decimals from these. A coin still on legacy
 * `CoinMetadata` has none until `coin_registry::migrate_legacy_metadata` runs.
 */
export function currencyObjectId(coinType: string): string {
  return deriveObjectID(
    SUI_COIN_REGISTRY_OBJECT_ID,
    `0x2::coin_registry::CurrencyKey<${normalizeStructTag(coinType)}>`,
    // CurrencyKey<phantom T> is an empty struct → one dummy bool.
    new Uint8Array([0]),
  )
}

/**
 * `pool::create_permissionless_pool<Base, Quote>(registry, policy,
 * baseCurrency, quoteCurrency, creationFee: Coin<CRED>)` → pool `ID`. The fee
 * must be exactly `COIN_POOL_CREATION_FEE`; the quote must be
 * registry-approved; decimals may differ by at most 9; duplicate pairs (either
 * orientation) abort.
 */
export function createPermissionlessCoinPool(
  tx: Transaction,
  ids: PackageIds,
  args: {
    baseCoinType: string
    quoteCoinType: string
    creationFee: TransactionObjectArgument
  },
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::pool::create_permissionless_pool`,
    typeArguments: [args.baseCoinType, args.quoteCoinType],
    arguments: [
      tx.object(ids.triexRegistry),
      tx.object(ids.triexFeePolicy),
      tx.object(currencyObjectId(args.baseCoinType)),
      tx.object(currencyObjectId(args.quoteCoinType)),
      args.creationFee,
    ],
  })
}

// ─── Read-only calls (for simulation; see coins/onchain.ts) ─────────────────

/**
 * `pool::get_pool_id_by_asset<Base, Quote>(registry)` → `ID`. Aborts when the
 * pair has no pool (in that orientation).
 */
export function getCoinPoolIdByAsset(
  tx: Transaction,
  ids: PackageIds,
  args: { baseCoinType: string; quoteCoinType: string },
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::pool::get_pool_id_by_asset`,
    typeArguments: [args.baseCoinType, args.quoteCoinType],
    arguments: [tx.object(ids.triexRegistry)],
  })
}

/**
 * `coin_order_query::iter_orders<Base, Quote>(pool, startOrderId?,
 * endOrderId?, minExpireTimestamp?, limit, bids)` → `OrderPage` (book
 * priority, best first; `start` is an exclusive cursor).
 */
export function iterCoinOrders(
  tx: Transaction,
  ids: PackageIds,
  args: CoinPoolTypes & {
    startOrderId?: bigint | null
    endOrderId?: bigint | null
    minExpireTimestamp?: bigint | null
    limit: bigint
    bids: boolean
  },
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::coin_order_query::iter_orders`,
    typeArguments: typeArgs(args),
    arguments: [
      tx.object(args.poolId),
      tx.pure.option('u128', args.startOrderId ?? null),
      tx.pure.option('u128', args.endOrderId ?? null),
      tx.pure.option('u64', args.minExpireTimestamp ?? null),
      tx.pure.u64(args.limit),
      tx.pure.bool(args.bids),
    ],
  })
}

/** Append a read-only `pool::<fn><Base, Quote>(...)` call (simulation only). */
export function coinPoolView(
  tx: Transaction,
  ids: PackageIds,
  fn: string,
  pool: CoinPoolTypes,
  extraArgs: (tx: Transaction) => TransactionArgument[] = () => [],
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::pool::${fn}`,
    typeArguments: typeArgs(pool),
    arguments: [tx.object(pool.poolId), ...extraArgs(tx)],
  })
}

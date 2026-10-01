import { bcs } from '@mysten/sui/bcs'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from '@mysten/sui/utils'

import { TriexClientError, TriexError } from '../errors'
import { serializeBalanceKey } from '../onchain'
import type { PackageIds } from '../types'
import {
  coinPoolView,
  getCoinPoolIdByAsset,
  iterCoinOrders,
} from './transactions'
import type { CoinPoolTypes } from './transactions'
import type { CoinFeeRates } from './money'

/**
 * Fullnode reads for coin pools. The coin-pool indexer routes are not on the
 * public gateway, so books, open orders, account state and fee rates come
 * straight from the chain — head-current, which deposit math wants anyway.
 *
 * Most reads SIMULATE a PTB of `pool` / `coin_order_query` view functions
 * (`core.simulateTransaction` with `commandResults`, checks disabled — the
 * devInspect equivalent) and BCS-decode the return values. Nothing is signed
 * or executed. Layouts below mirror the cycle-7 Move structs:
 *   book/order.move          `Order`
 *   coin_order_query.move    `OrderPage { orders, has_next_page }`
 *   state/account.move       `Account`
 *   state/balances.move      `Balances { base, quote, cred }`
 *   state/fee_schedule.move  `FeeSchedule { tiers: vector<FeeTier> }`
 */

// ─── BCS layouts ─────────────────────────────────────────────────────────────

/** `order::Order` — a resting order as stored in the book. */
export const CoinOrderBcs = bcs.struct('Order', {
  trading_account_id: bcs.Address,
  order_id: bcs.u128(),
  price: bcs.u64(),
  is_bid: bcs.bool(),
  quantity: bcs.u64(),
  filled_quantity: bcs.u64(),
  epoch: bcs.u64(),
  /** Snapshotted maker rate, whole basis points. */
  maker_fee_rate: bcs.u16(),
  cancel_retention_bps: bcs.u16(),
  status: bcs.u8(),
  expire_timestamp: bcs.u64(),
})

/** `coin_order_query::OrderPage`. */
export const CoinOrderPageBcs = bcs.struct('OrderPage', {
  orders: bcs.vector(CoinOrderBcs),
  has_next_page: bcs.bool(),
})

/** `balances::Balances`. */
export const CoinBalancesBcs = bcs.struct('Balances', {
  base: bcs.u64(),
  quote: bcs.u64(),
  cred: bcs.u64(),
})

/** `account::Account` — one trading account's state inside one pool. */
export const CoinPoolAccountBcs = bcs.struct('Account', {
  open_orders: bcs.struct('VecSet', { contents: bcs.vector(bcs.u128()) }),
  taker_volume: bcs.u128(),
  maker_volume: bcs.u128(),
  settled_balances: CoinBalancesBcs,
  owed_balances: CoinBalancesBcs,
  pending_turnover: bcs.vector(
    bcs.struct('EpochAmount', { epoch: bcs.u64(), amount: bcs.u64() }),
  ),
})

/** `fee_schedule::FeeSchedule { tiers: vector<FeeTier> }`. */
export const CoinFeeScheduleBcs = bcs.struct('FeeSchedule', {
  tiers: bcs.vector(
    bcs.struct('FeeTier', {
      min_turnover: bcs.u128(),
      taker_fee: bcs.u64(),
      maker_fee: bcs.u64(),
    }),
  ),
})

// ─── Domain shapes ───────────────────────────────────────────────────────────

/** Order status codes (`constants::LIVE` … `EXPIRED`). */
export const COIN_ORDER_STATUS = [
  'live',
  'partially_filled',
  'filled',
  'canceled',
  'expired',
] as const

/** One resting coin-pool order (raw units). */
export interface CoinBookOrder {
  /** Move `u128` order id as a decimal string (exceeds 2^53). */
  orderId: string
  tradingAccountId: string
  isBid: boolean
  /** Raw 1e9-scaled price. */
  price: bigint
  /** Original quantity (base). */
  quantity: bigint
  filledQuantity: bigint
  remainingQuantity: bigint
  /** Epoch ms; MAX_U64 = good-til-cancelled. */
  expireTimestamp: bigint
  /** Maker rate snapshotted at placement, whole basis points. */
  makerFeeBps: number
  cancelRetentionBps: number
  status: (typeof COIN_ORDER_STATUS)[number] | 'unknown'
  /** Sui epoch the order was placed in. */
  epoch: bigint
}

export function toCoinBookOrder(
  o: ReturnType<typeof CoinOrderBcs.parse>,
): CoinBookOrder {
  const quantity = BigInt(o.quantity)
  const filled = BigInt(o.filled_quantity)
  return {
    orderId: BigInt(o.order_id).toString(),
    tradingAccountId: normalizeSuiAddress(o.trading_account_id),
    isBid: o.is_bid,
    price: BigInt(o.price),
    quantity,
    filledQuantity: filled,
    remainingQuantity: quantity - filled,
    expireTimestamp: BigInt(o.expire_timestamp),
    makerFeeBps: o.maker_fee_rate,
    cancelRetentionBps: o.cancel_retention_bps,
    status: COIN_ORDER_STATUS[o.status] ?? 'unknown',
    epoch: BigInt(o.epoch),
  }
}

const core = (suiClient: ClientWithCoreApi) => (suiClient as any).core

const ZERO_SENDER = normalizeSuiAddress('0x0')

// ─── Simulation helper ───────────────────────────────────────────────────────

/**
 * Simulate `tx` (checks disabled — the devInspect equivalent) and return each
 * command's return values as BCS bytes, or `null` when the simulation aborted
 * (e.g. a view that asserts on a missing pool/account).
 */
export async function simulateReturnValues(
  suiClient: ClientWithCoreApi,
  tx: Transaction,
  sender?: string,
): Promise<Uint8Array[][] | null> {
  tx.setSenderIfNotSet(sender ?? ZERO_SENDER)
  const res = await core(suiClient).simulateTransaction({
    transaction: tx,
    include: { commandResults: true, effects: true },
    checksEnabled: false,
  })
  if (!res || res.$kind === 'FailedTransaction' || res.FailedTransaction) {
    return null
  }
  const results: any[] = res.commandResults ?? []
  return results.map((r) =>
    (r?.returnValues ?? []).map((v: any) => v.bcs as Uint8Array),
  )
}

/** Like {@link simulateReturnValues} but a failed simulation is an error. */
async function simulateOrThrow(
  suiClient: ClientWithCoreApi,
  tx: Transaction,
  what: string,
  sender?: string,
): Promise<Uint8Array[][]> {
  const out = await simulateReturnValues(suiClient, tx, sender)
  if (!out) {
    throw new TriexClientError(
      TriexError.UnexpectedResponse,
      `Simulating ${what} failed on-chain (unknown pool/account, or a package version mismatch).`,
    )
  }
  return out
}

// ─── Pool resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the pool for a `(base, quote)` pair from the registry via
 * `pool::get_pool_id_by_asset` (simulated). Returns null when no pool exists
 * in that orientation — the registry refuses the reverse pair, so
 * `(quote, base)` is never a second market.
 */
export async function resolveCoinPoolId(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  pair: { baseCoinType: string; quoteCoinType: string },
): Promise<string | null> {
  const tx = new Transaction()
  getCoinPoolIdByAsset(tx, ids, pair)
  const out = await simulateReturnValues(suiClient, tx)
  const bytes = out?.[0]?.[0]
  return bytes ? normalizeSuiAddress(bcs.Address.parse(bytes)) : null
}

/**
 * Read a pool object's `<Base, Quote>` type arguments from its on-chain type
 * (`…::pool::Pool<B, Q>`). Throws `PoolNotFound` when the object is missing or
 * is not a coin pool.
 */
export async function fetchCoinPoolTypes(
  suiClient: ClientWithCoreApi,
  poolId: string,
): Promise<CoinPoolTypes> {
  const res = await core(suiClient)
    .getObject({ objectId: poolId })
    .catch(() => null)
  const type: string | undefined = res?.object?.type
  const tag = type ? safeParseStructTag(type) : null
  if (
    !tag ||
    tag.module !== 'pool' ||
    tag.name !== 'Pool' ||
    tag.typeParams.length !== 2
  ) {
    throw new TriexClientError(
      TriexError.PoolNotFound,
      `${poolId} is not a coin pool (triex::pool::Pool<Base, Quote>).`,
    )
  }
  return {
    poolId: normalizeSuiAddress(poolId),
    baseCoinType: normalizeStructTag(tag.typeParams[0]),
    quoteCoinType: normalizeStructTag(tag.typeParams[1]),
  }
}

function safeParseStructTag(type: string) {
  try {
    return parseStructTag(type)
  } catch {
    return null
  }
}

// ─── Balances ────────────────────────────────────────────────────────────────

/**
 * Balance of any coin type held inside a trading account: its `balances` Bag
 * entry `BalanceKey<T>` → `Balance<T>` (bare u64). 0n when absent. The
 * generic counterpart of `getTradingAccountCurrencyBalance` (CRED only).
 */
export async function getTradingAccountCoinBalance(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  tradingAccountId: string,
  coinType: string,
): Promise<bigint> {
  const accountObj = await core(suiClient)
    .getObject({ objectId: tradingAccountId, include: { json: true } })
    .catch(() => null)
  const bag = unwrapFields(accountObj?.object?.json?.balances)
  const bagId = idToString(bag?.id)
  if (!bagId) return 0n

  const df = await core(suiClient)
    .getDynamicField({
      parentId: bagId,
      name: {
        type: `${ids.triexOriginal}::trading_account::BalanceKey<${normalizeStructTag(coinType)}>`,
        bcs: serializeBalanceKey(),
      },
    })
    .catch(() => null)
  if (!df) return 0n
  return BigInt(bcs.u64().parse(df.dynamicField.value.bcs))
}

function unwrapFields(value: unknown): any {
  if (value && typeof value === 'object' && 'fields' in value) {
    return (value as any).fields
  }
  return value as any
}

function idToString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const v = value as any
    if (typeof v.id === 'string') return v.id
    if (typeof v.bytes === 'string') return v.bytes
    if (v.id) return idToString(v.id)
  }
  return null
}

// ─── Order book ──────────────────────────────────────────────────────────────

export interface CoinBookSide {
  orders: CoinBookOrder[]
  /** More orders rest beyond `depth`. */
  hasMore: boolean
}

/**
 * Read one side of a coin pool's book in priority order (best first) via
 * `coin_order_query::iter_orders`, paging until `depth` orders or the side
 * ends. Expired orders are excluded (`min_expire_timestamp = now`) — they are
 * not liquidity, matching just retires them.
 */
export async function fetchCoinBookSide(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  pool: CoinPoolTypes,
  bids: boolean,
  opts?: { depth?: number; pageSize?: number; now?: number },
): Promise<CoinBookSide> {
  const depth = opts?.depth ?? 100
  const pageSize = BigInt(Math.max(1, Math.min(opts?.pageSize ?? 100, depth)))
  const now = BigInt(opts?.now ?? Date.now())
  const orders: CoinBookOrder[] = []
  let cursor: bigint | null = null
  let hasMore = false

  while (orders.length < depth) {
    const tx = new Transaction()
    iterCoinOrders(tx, ids, {
      ...pool,
      startOrderId: cursor,
      minExpireTimestamp: now,
      limit: pageSize,
      bids,
    })
    const out = await simulateOrThrow(suiClient, tx, 'iter_orders')
    const page = CoinOrderPageBcs.parse(out[0][0])
    for (const o of page.orders) orders.push(toCoinBookOrder(o))
    hasMore = page.has_next_page
    if (!page.has_next_page || page.orders.length === 0) break
    cursor = BigInt(page.orders[page.orders.length - 1].order_id)
  }
  if (orders.length > depth) {
    orders.length = depth
    hasMore = true
  }
  return { orders, hasMore }
}

// ─── Account state ───────────────────────────────────────────────────────────

/** Raw `Balances` triple. */
export interface CoinPoolBalances {
  base: bigint
  quote: bigint
  cred: bigint
}

/** A trading account's state inside one coin pool. */
export interface CoinPoolAccount {
  poolId: string
  tradingAccountId: string
  /** Open order ids (u128 decimal strings). */
  openOrderIds: string[]
  takerVolume: bigint
  makerVolume: bigint
  /** Claimable now via `claimSettled` (fills, cancels, refunds). */
  settled: CoinPoolBalances
  /** Owed to the pool; netted against `settled` at the next settlement. */
  owed: CoinPoolBalances
  /**
   * Locked in this account's open orders (`pool::locked_balance` minus
   * `settled`): base for asks, quote + maker-fee escrow for bids.
   */
  lockedInOrders: CoinPoolBalances
}

const toBalances = (b: ReturnType<typeof CoinBalancesBcs.parse>) => ({
  base: BigInt(b.base),
  quote: BigInt(b.quote),
  cred: BigInt(b.cred),
})

/**
 * `pool::account` + `pool::locked_balance` for one trading account (one
 * simulation). Null when the account has never traded in this pool.
 */
export async function fetchCoinPoolAccount(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  pool: CoinPoolTypes,
  tradingAccountId: string,
  sender?: string,
): Promise<CoinPoolAccount | null> {
  const tx = new Transaction()
  const account = tx.object(tradingAccountId)
  coinPoolView(tx, ids, 'account', pool, () => [account])
  coinPoolView(tx, ids, 'locked_balance', pool, () => [account])
  const out = await simulateReturnValues(suiClient, tx, sender)
  if (!out) return null
  const acct = CoinPoolAccountBcs.parse(out[0][0])
  const settled = toBalances(acct.settled_balances)
  const [lb, lq, lc] = out[1].map((b) => BigInt(bcs.u64().parse(b)))
  const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n)
  return {
    poolId: pool.poolId,
    tradingAccountId: normalizeSuiAddress(tradingAccountId),
    openOrderIds: acct.open_orders.contents.map((id) => BigInt(id).toString()),
    takerVolume: BigInt(acct.taker_volume),
    makerVolume: BigInt(acct.maker_volume),
    settled,
    owed: toBalances(acct.owed_balances),
    lockedInOrders: {
      base: sub(lb, settled.base),
      quote: sub(lq, settled.quote),
      cred: sub(lc, settled.cred),
    },
  }
}

/**
 * Every order this trading account has resting in the pool
 * (`pool::get_account_order_details`). Empty when it has none.
 */
export async function fetchCoinAccountOrders(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  pool: CoinPoolTypes,
  tradingAccountId: string,
  sender?: string,
): Promise<CoinBookOrder[]> {
  const tx = new Transaction()
  coinPoolView(tx, ids, 'get_account_order_details', pool, (t) => [
    t.object(tradingAccountId),
  ])
  const out = await simulateOrThrow(
    suiClient,
    tx,
    'get_account_order_details',
    sender,
  )
  return bcs.vector(CoinOrderBcs).parse(out[0][0]).map(toCoinBookOrder)
}

// ─── Fees ────────────────────────────────────────────────────────────────────

/** Fee state for one coin pool, read from the shared `FeePolicy`. */
export interface CoinTradeParams {
  poolId: string
  /** The pool's pricing class in the `FeePolicy`. */
  feeClass: number
  /** Entry-rung (tier 0) rates in force now, 1e9-scaled. */
  entry: CoinFeeRates
  /**
   * The staged schedule's entry rung and the epoch it takes over. Equal to
   * the active one when nothing is pending.
   */
  next: CoinFeeRates & { effectiveEpoch: bigint }
  /** Share of released bid-maker escrow kept on cancel/modify/expiry, bps. */
  cancelRetentionBps: bigint
  /** This account's own rates/tier — present when an account was given. */
  account: (CoinFeeRates & { tier: bigint; turnover: bigint }) | null
}

/**
 * Entry-rung rates, the staged schedule, cancel retention, and (optionally)
 * one account's tier — a single simulation of `pool_trade_params`,
 * `pool_fee_schedule_next`, `pool_fee_class` → `fee_policy::cancel_retention_bps`,
 * and the `*_for_account` views.
 */
export async function fetchCoinTradeParams(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  pool: CoinPoolTypes,
  tradingAccountId?: string | null,
  sender?: string,
): Promise<CoinTradeParams> {
  const tx = new Transaction()
  const policy = tx.object(ids.triexFeePolicy)
  coinPoolView(tx, ids, 'pool_trade_params', pool, () => [policy]) // 0
  coinPoolView(tx, ids, 'pool_fee_schedule_next', pool, () => [policy]) // 1
  const [feeClass] = coinPoolView(tx, ids, 'pool_fee_class', pool) // 2
  tx.moveCall({
    target: `${ids.triex}::fee_policy::cancel_retention_bps`,
    arguments: [policy, feeClass],
  }) // 3
  if (tradingAccountId) {
    const account = tx.object(tradingAccountId)
    coinPoolView(tx, ids, 'trade_params_for_account', pool, () => [
      policy,
      account,
    ]) // 4
    coinPoolView(tx, ids, 'account_fee_tier', pool, () => [policy, account]) // 5
    coinPoolView(tx, ids, 'account_fee_turnover', pool, () => [account]) // 6
  }
  const out = await simulateOrThrow(suiClient, tx, 'pool fee views', sender)
  const u64 = (b: Uint8Array) => BigInt(bcs.u64().parse(b))

  const schedule = CoinFeeScheduleBcs.parse(out[1][0])
  const nextEntry = schedule.tiers[0]
  return {
    poolId: pool.poolId,
    feeClass: bcs.u16().parse(out[2][0]),
    entry: { takerFee: u64(out[0][0]), makerFee: u64(out[0][1]) },
    next: {
      takerFee: nextEntry ? BigInt(nextEntry.taker_fee) : u64(out[0][0]),
      makerFee: nextEntry ? BigInt(nextEntry.maker_fee) : u64(out[0][1]),
      effectiveEpoch: u64(out[1][1]),
    },
    cancelRetentionBps: u64(out[3][0]),
    account: tradingAccountId
      ? {
          takerFee: u64(out[4][0]),
          makerFee: u64(out[4][1]),
          tier: u64(out[5][0]),
          turnover: BigInt(bcs.u128().parse(out[6][0])),
        }
      : null,
  }
}

// ─── Dry-run quotes ──────────────────────────────────────────────────────────

/**
 * `pool::get_quantity_out_input_fee` (entry rung — what the wallet swaps are
 * charged) or `pool::get_quantity_out_for_account` (that account's tier).
 * Exactly one of `baseIn` / `quoteIn` must be positive. Returns the Move pair:
 * selling base → `[baseUnspent, quoteOut]`; buying with quote →
 * `[baseOut, quoteUnspent]`.
 */
export async function dryRunCoinQuantityOut(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  pool: CoinPoolTypes,
  args: { baseIn: bigint; quoteIn: bigint; tradingAccountId?: string | null },
  sender?: string,
): Promise<[bigint, bigint]> {
  const tx = new Transaction()
  const policy = tx.object(ids.triexFeePolicy)
  if (args.tradingAccountId) {
    const account = tx.object(args.tradingAccountId)
    coinPoolView(tx, ids, 'get_quantity_out_for_account', pool, (t) => [
      policy,
      account,
      t.pure.u64(args.baseIn),
      t.pure.u64(args.quoteIn),
      t.object(ids.clock),
    ])
  } else {
    coinPoolView(tx, ids, 'get_quantity_out_input_fee', pool, (t) => [
      policy,
      t.pure.u64(args.baseIn),
      t.pure.u64(args.quoteIn),
      t.object(ids.clock),
    ])
  }
  const out = await simulateOrThrow(suiClient, tx, 'get_quantity_out', sender)
  return [
    BigInt(bcs.u64().parse(out[0][0])),
    BigInt(bcs.u64().parse(out[0][1])),
  ]
}

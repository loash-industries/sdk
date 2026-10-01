import type { z } from 'zod'
import type { BookLevel } from '../book'
import type { OrderSide, TxResult } from '../types'
import type {
  CoinInfoSchema,
  CoinMarketSchema,
  CoinMintPolicySchema,
  CoinTreasuryHoldingSchema,
} from './schemas'
import type { CoinBookOrder } from './onchain'

// ─── Indexer shapes (inferred from the pinned wire schemas) ─────────────────

export type CoinInfo = z.output<typeof CoinInfoSchema>
export type CoinMarket = z.output<typeof CoinMarketSchema>
export type CoinTreasuryHolding = z.output<typeof CoinTreasuryHoldingSchema>
export type CoinMintPolicy = z.output<typeof CoinMintPolicySchema>

// ─── Pool selection ──────────────────────────────────────────────────────────

/**
 * Which coin pool a call targets. Give `poolId`, or `baseCoinType` (with
 * `quoteCoinType`, default CRED), or all three to skip every lookup. Coin
 * types are fully-qualified Move types (`0x…::module::NAME`).
 */
export interface CoinPoolSelector {
  poolId?: string
  baseCoinType?: string
  /** Defaults to the network's CRED type. */
  quoteCoinType?: string
}

/** A resolved coin pool: its id and its `<Base, Quote>` type arguments. */
export interface CoinPool {
  poolId: string
  baseCoinType: string
  quoteCoinType: string
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export interface CoinOrderbook extends CoinPool {
  /** Resting bids, best (highest) first, expired orders excluded. */
  bids: CoinBookOrder[]
  /** Resting asks, best (lowest) first, expired orders excluded. */
  asks: CoinBookOrder[]
  /** `bids` aggregated by price, book order. */
  bidLevels: BookLevel[]
  /** `asks` aggregated by price, book order. */
  askLevels: BookLevel[]
  /** More bids rest beyond the requested depth. */
  hasMoreBids: boolean
  hasMoreAsks: boolean
}

export interface CoinOrderbookParams extends CoinPoolSelector {
  /** Orders to read per side (default 100). */
  depth?: number
}

export interface CoinAccountParams extends CoinPoolSelector {
  /**
   * Trading account to read. `TriexClient` defaults to the player's own;
   * `ReadOnlyClient` requires it.
   */
  tradingAccountId?: string
}

export interface CoinTradeParamsParams extends CoinPoolSelector {
  /** Also resolve this account's own tier and rates. */
  tradingAccountId?: string
}

/** Dry-run of a wallet swap against the live book (no state change). */
export interface CoinSwapQuoteParams extends CoinPoolSelector {
  /** `buy` spends quote for base; `sell` spends base for quote. */
  side: OrderSide
  /** Raw amount of the coin being spent (quote for buys, base for sells). */
  amountIn: bigint
  /**
   * Price at this account's tier (`get_quantity_out_for_account`). Omit to
   * price at the entry rung — what `coins.swap` is actually charged.
   */
  tradingAccountId?: string
}

export interface CoinSwapQuote {
  side: OrderSide
  amountIn: bigint
  /** Net received: base for buys, quote after the taker fee for sells. */
  amountOut: bigint
  /** Part of `amountIn` the book could not absorb (returned to you). */
  unspent: bigint
}

export interface CoinMarketEstimateParams extends CoinPoolSelector {
  side: OrderSide
  /** Base quantity of the market order. */
  quantity: bigint
  /** Book depth to walk (default 100 = `COIN_MAX_FILLS`). */
  depth?: number
  /**
   * Taker rate (1e9-scaled) to price at. Defaults to the conservative
   * entry-rung taker rate (max of active and staged schedules).
   */
  takerFeeRateScaled?: bigint
}

export interface CoinBalancesParams {
  coinType: string
  /** Defaults to the configured player (`TriexClient`). */
  address?: string
}

/** One coin's balances for a player (fullnode, head-current). */
export interface CoinBalances {
  coinType: string
  /** Held as wallet `Coin` objects (raw). */
  wallet: bigint
  /** Held inside the trading account (raw); 0n when none exists. */
  tradingAccount: bigint
  tradingAccountId: string | null
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface CoinDepositParams {
  coinType: string
  amount: bigint
}

export interface CoinWithdrawParams {
  coinType: string
  /** Omit to withdraw the whole balance. */
  amount?: bigint
}

export interface CoinLimitOrderParams extends CoinPoolSelector {
  side: OrderSide
  /** Raw 1e9-scaled price (see `coinPriceToRaw`). */
  price: bigint
  /** Base quantity (raw); ≥ `coinMinOrderQuantity(price)`. */
  quantity: bigint
  /** Epoch ms; defaults to good-til-cancelled (MAX_U64). */
  expireAt?: bigint
  /** 0 = none (default), 1 = IOC, 2 = FOK, 3 = POST_ONLY. */
  orderType?: number
  /** 0 = allowed (default), 1 = cancel taker, 2 = cancel maker. */
  selfMatchingOption?: number
  /**
   * Override the quote held for a bid. Defaults to
   * `computeCoinBidDeposit(price, quantity, conservativeBidFeeRate(...))`.
   */
  quoteDeposit?: bigint
}

export interface CoinMarketOrderParams extends CoinPoolSelector {
  side: OrderSide
  /** Base quantity (raw). */
  quantity: bigint
  /**
   * Quote held for a market BUY (cost incl. taker fee). Defaults to the exact
   * cost against the current on-chain book (`estimateMarket(...).totalQuote`);
   * if the book moves against you the order aborts and rolls back — pass
   * extra headroom here to tolerate that. Unspent quote stays in the account.
   */
  quoteBudget?: bigint
  /** 0 = allowed (default), 1 = cancel taker, 2 = cancel maker. */
  selfMatchingOption?: number
}

export interface CoinSwapParams extends CoinPoolSelector {
  /** `buy` spends quote for base; `sell` spends base for quote. */
  side: OrderSide
  /** Raw amount of the coin being spent, taken from the wallet. */
  amountIn: bigint
  /**
   * Minimum output or the swap aborts. Defaults to the dry-run output less
   * `slippageBps`.
   */
  minOut?: bigint
  /** Tolerance applied to the dry-run when `minOut` is omitted (default 50). */
  slippageBps?: number
}

export interface CoinSwapResult extends TxResult {
  /** The `minOut` the swap enforced. */
  minOut: bigint
}

export interface CoinCancelOrderParams extends CoinPoolSelector {
  /** Move `u128` order id (decimal string or bigint). */
  orderId: bigint | string
}

export interface CoinCancelOrdersParams extends CoinPoolSelector {
  orderIds: Array<bigint | string>
}

export interface CoinModifyOrderParams extends CoinCancelOrderParams {
  /** New total quantity: < original, > filled. */
  newQuantity: bigint
}

export interface CoinClaimSettledParams {
  /** Pools to settle from, in one PTB. */
  pools: CoinPoolSelector[]
  /**
   * Also sweep these coin types from the trading account to the wallet after
   * settling (`withdraw_all<T>` each).
   */
  withdrawCoinTypes?: string[]
}

export interface CreateCoinPoolParams {
  baseCoinType: string
  /** Defaults to CRED (the registry-approved quote). */
  quoteCoinType?: string
}

export interface CreateCoinPoolResult extends TxResult {
  /** The new pool's id, when the executor surfaced created objects. */
  poolId: string | null
}

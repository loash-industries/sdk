import {
  TRIEX_PRICE_SCALING,
  computeQuoteFee,
  fromBase,
  toBase,
} from '../money'

/**
 * Money math for coin (currency-pair) pools — `triex::pool::Pool<Base, Quote>`.
 * Pure and deterministic, mirroring the cycle-7 Move source line for line so a
 * deposit computed here can never under-fund the order it backs (see
 * DESIGN-COINS.md §3 for the derivation and source references).
 *
 * Conventions (all raw on-chain integers, bigint):
 *   quote = floor(base × price / 1e9)        `math::qty_to_quote` (FLOAT_SCALING)
 *   fee   = floor(quote × min(rate, 1e9) / 1e9)  `quote_fee::fee_from_scaled_rate`
 * Rates are 1e9-scaled (`11_000_000` = 1.10%), whole basis points on-chain.
 *
 * Coin pools have no lot or tick size in cycle 7. The only size rule is the
 * price-derived minimum a RESTING order must meet
 * (`math::min_qty_for_nonzero_quote`, enforced by `order_info::validate_inputs`).
 */

/** Price scaling for coin pools (`FLOAT_SCALING`): quote = base × price / 1e9. */
export const COIN_PRICE_SCALING = TRIEX_PRICE_SCALING

/** `constants::MIN_PRICE` — lowest valid limit price. */
export const COIN_MIN_PRICE = 1n

/** `constants::MAX_PRICE` — highest valid limit price (2^63 − 1). */
export const COIN_MAX_PRICE = (1n << 63n) - 1n

/**
 * `constants::POOL_CREATION_FEE` — CRED (raw, 6 decimals) a permissionless
 * `create_permissionless_pool` must pay, exactly (500 CRED).
 */
export const COIN_POOL_CREATION_FEE = 500_000_000n

/**
 * `constants::MAX_FILLS` — makers one taker order visits at most (skipped and
 * expired makers count). A limit order that hits it is NOT inserted; a market
 * order simply stops.
 */
export const COIN_MAX_FILLS = 100

/** Quote for `quantity` base at `price` (both raw), floored — `math::qty_to_quote`. */
export function coinQuoteForBase(price: bigint, quantity: bigint): bigint {
  return (price * quantity) / COIN_PRICE_SCALING
}

/**
 * Quote fee on `quote` at a 1e9-scaled rate, floored, rate clamped at 100% —
 * exactly `quote_fee::fee_from_scaled_rate`. Coin and item pools share that
 * Move function, so this delegates to the item-side {@link computeQuoteFee}.
 */
export function coinQuoteFee(quote: bigint, feeRateScaled: bigint): bigint {
  return computeQuoteFee(quote, feeRateScaled)
}

/**
 * Smallest quantity a resting order at `price` may have:
 * `ceil(1e9 / price)` — `math::min_qty_for_nonzero_quote`. Anything smaller
 * aborts placement with `EOrderBelowMinimumSize`. 1 for prices ≥ 1e9.
 */
export function coinMinOrderQuantity(price: bigint): bigint {
  if (price <= 0n) return 1n
  return (COIN_PRICE_SCALING + price - 1n) / price
}

/**
 * Quote a **limit bid** must have in the trading account: the notional at the
 * limit price plus the fee on it, at `feeRateScaled`.
 *
 *   deposit = Q + floor(rate × Q / 1e9),   Q = floor(quantity × price / 1e9)
 *
 * This is an upper bound on what settlement withdraws
 * (`order_info::calculate_partial_fill_balances`): the filled part owes its
 * per-fill quote (each fill floors at a maker price ≤ the limit) plus the taker
 * fee floored once on the aggregate; the resting part owes its floored quote
 * plus the maker-fee escrow. Both quotes sum to ≤ Q, and two floors sum to ≤ the
 * floor of the sum, so pricing the whole Q at `max(taker, maker)` covers every
 * fill split. Pass that max — {@link conservativeBidFeeRate} — not one rate.
 */
export function computeCoinBidDeposit(
  price: bigint,
  quantity: bigint,
  feeRateScaled: bigint,
): bigint {
  const quote = coinQuoteForBase(price, quantity)
  return quote + coinQuoteFee(quote, feeRateScaled)
}

/** Entry-rung (tier 0) rates, 1e9-scaled — what an account with no turnover pays. */
export interface CoinFeeRates {
  takerFee: bigint
  makerFee: bigint
}

/**
 * Same rule as the item side's bid-escrow rate (shared `fee_policy` ladders).
 * The rate a bid deposit should be sized at so it covers ANY account, now or
 * after a staged schedule takes effect: the max of taker and maker over the
 * active entry rung and the staged (`next`) entry rung. Fee ladders are
 * monotone non-increasing (`fee_schedule::validate`), so the entry rung bounds
 * every tier; maker is not required to be ≤ taker, hence the max over both.
 * Market bids never rest, so pass `{ marketOrder: true }` to use taker only.
 */
export function conservativeBidFeeRate(
  entry: CoinFeeRates,
  next?: CoinFeeRates | null,
  opts?: { marketOrder?: boolean },
): bigint {
  const rates = [entry.takerFee]
  if (!opts?.marketOrder) rates.push(entry.makerFee)
  if (next) {
    rates.push(next.takerFee)
    if (!opts?.marketOrder) rates.push(next.makerFee)
  }
  return rates.reduce((a, b) => (b > a ? b : a), 0n)
}

/** What an ask nets from `grossQuote` after its fee is taken out of the proceeds. */
export function coinSellNet(grossQuote: bigint, feeRateScaled: bigint): bigint {
  return grossQuote - coinQuoteFee(grossQuote, feeRateScaled)
}

/** One resting maker as the matching walk sees it (book order, best first). */
export interface CoinMakerOrder {
  price: bigint
  remainingQuantity: bigint
}

export interface CoinMarketEstimate {
  side: 'buy' | 'sell'
  requestedQuantity: bigint
  /** Base units the book fills (≤ requested). */
  filledQuantity: bigint
  /** True when the book fully absorbs the requested quantity. */
  fillable: boolean
  /** Matched quote before fees: Σ floor(take × price / 1e9) over fills. */
  grossQuote: bigint
  /** Taker fee, floored once on `grossQuote`. */
  fee: bigint
  /**
   * Buy: quote the trading account must hold (gross + fee) — feed it to
   * `coins.market` as `quoteBudget`. Sell: quote received (gross − fee).
   */
  totalQuote: bigint
  /** Volume-weighted average fill price (raw, 1e9-scaled); null if nothing fills. */
  avgPrice: bigint | null
  /** Makers visited (≤ `COIN_MAX_FILLS`). */
  makersVisited: number
}

/**
 * Price a market order of `quantity` base against the opposite side of the
 * book exactly as `book::match_against_book` + `order_info::match_maker` will:
 * makers in book order, at most `COIN_MAX_FILLS` visited; a maker whose whole
 * remainder converts to zero quote is retired (no fill), a fill that converts
 * to zero quote is skipped; each fill's quote floors on its own, the taker fee
 * floors once on the total. `makers` must be the OPPOSITE side, best first,
 * already excluding expired orders (the on-chain book reads do this).
 */
export function estimateCoinMarketOrder(
  makers: ReadonlyArray<CoinMakerOrder>,
  side: 'buy' | 'sell',
  quantity: bigint,
  takerFeeRateScaled: bigint,
): CoinMarketEstimate {
  let remaining = quantity
  let grossQuote = 0n
  let visited = 0
  for (const maker of makers) {
    if (remaining <= 0n || visited >= COIN_MAX_FILLS) break
    visited++
    if (coinQuoteForBase(maker.price, maker.remainingQuantity) === 0n) continue
    const take =
      maker.remainingQuantity < remaining ? maker.remainingQuantity : remaining
    const quote = coinQuoteForBase(maker.price, take)
    if (quote === 0n) continue
    grossQuote += quote
    remaining -= take
  }
  const filledQuantity = quantity - remaining
  const fee = coinQuoteFee(grossQuote, takerFeeRateScaled)
  return {
    side,
    requestedQuantity: quantity,
    filledQuantity,
    fillable: remaining <= 0n,
    grossQuote,
    fee,
    totalQuote: side === 'buy' ? grossQuote + fee : grossQuote - fee,
    avgPrice:
      filledQuantity > 0n
        ? (grossQuote * COIN_PRICE_SCALING) / filledQuantity
        : null,
    makersVisited: visited,
  }
}

/** Decimal exponent of a pair's raw price: 9 + quoteDecimals − baseDecimals. */
export function coinPriceDecimals(
  baseDecimals: number,
  quoteDecimals: number,
): number {
  return 9 + quoteDecimals - baseDecimals
}

/**
 * Human "quote per whole base coin" → raw pool price. Coin pools encode
 * price as `P_human × 10^(9 + Dq − Db)`; pool creation caps |Dq − Db| at 9,
 * so the exponent is always within [0, 18].
 */
export function coinPriceToRaw(
  human: string | number,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  return toBase(human, coinPriceDecimals(baseDecimals, quoteDecimals))
}

/** Raw pool price → human "quote per whole base coin" decimal string. */
export function formatCoinPrice(
  raw: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): string {
  return fromBase(raw, coinPriceDecimals(baseDecimals, quoteDecimals))
}

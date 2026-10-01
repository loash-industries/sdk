/**
 * Money math for Trinary Exchange CLOB markets (Move contracts:
 * https://github.com/loash-industries/trinary-exchange). Getting scaling /
 * fees wrong silently over- or under-funds orders, so this module is pure,
 * deterministic, and the primary unit-test target (see test/money.test.ts).
 *
 * MVP trades item↔CRED via `multicoin_pool`, whose price scaling factor is `1`:
 *   quote = price * quantity
 * (Coin/currency-pair pools use TRIEX_PRICE_SCALING = 1e9; those are
 * out of MVP scope but the constant is kept for when they land.)
 *
 * Fees (cycle 7, `quote_fee.move` / `order_info.move` / `fill.move`): every
 * fee is quote-denominated, `floor(quote × rate / 1e9)`, and BOTH sides pay —
 * bids on top of the quote they owe (taker at match, maker escrowed at
 * placement), asks out of their quote proceeds. Rates come from the pool's
 * fee class in the shared `FeePolicy`, resolved against the account's
 * trailing fee turnover (tiers only ever lower the rate); read them with
 * `orders.fees()`.
 */

/** Price scaling for coin/currency-pair pools (`pool`). Not used by item pools. */
export const TRIEX_PRICE_SCALING = 1_000_000_000n

/** Price scaling for item (multicoin) pools. */
export const MULTICOIN_PRICE_SCALING = 1n

/**
 * Denominator of the on-chain fee rate (`FLOAT_SCALING`): every fee rate is
 * fee × 1e9 (22_000_000 = 2.2%, the multicoin entry taker rate).
 */
export const FEE_RATE_SCALING = 1_000_000_000n

/** Good-til-cancelled expiry sentinel (MAX_U64) — the default order expiry. */
export const GTC_EXPIRE = 18446744073709551615n

/** Convert a human decimal string/number to base units given `decimals`. */
export function toBase(human: string | number, decimals: number): bigint {
  const s = typeof human === 'number' ? human.toString() : human.trim()
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`toBase: invalid amount "${human}"`)
  }
  const [whole, frac = ''] = s.split('.')
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0')
}

/** Convert base units back to a human decimal string given `decimals`. */
export function fromBase(base: bigint, decimals: number): string {
  const negative = base < 0n
  const abs = negative ? -base : base
  const divisor = 10n ** BigInt(decimals)
  const whole = abs / divisor
  const frac = (abs % divisor)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '')
  const sign = negative ? '-' : ''
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`
}

/**
 * Quote (CRED base units) required for `quantity` items at `price` on an item
 * pool. `price` is already in quote base units per item (pre-scaling = 1).
 */
export function computeItemQuote(price: bigint, quantity: bigint): bigint {
  return (price * quantity * MULTICOIN_PRICE_SCALING) / 1n
}

/**
 * The quote fee on `quote` at a 1e9-scaled rate, rounded DOWN — exactly
 * `quote_fee::fee_from_scaled_rate` (rate clamped at 100%). Every cycle-7 fee
 * prices through it: bid taker and ask taker fees on the order's whole matched
 * quote, bid maker escrow on the resting notional, ask maker fees per fill.
 */
export function computeQuoteFee(quote: bigint, feeRateScaled: bigint): bigint {
  if (quote <= 0n || feeRateScaled <= 0n) return 0n
  const rate =
    feeRateScaled > FEE_RATE_SCALING ? FEE_RATE_SCALING : feeRateScaled
  return (quote * rate) / FEE_RATE_SCALING
}

/**
 * Total quote (CRED base units) a **bid** must hold in the trading account to
 * place a limit buy of `quantity` at `price`: the notional plus
 * `floor(notional × rate / 1e9)`.
 *
 * On-chain a bid owes its taker fee on the part that matches
 * (`floor(taker × matched quote)`) and escrows its maker fee on the part that
 * rests (`floor(maker × resting quote)`) — `order_info::
 * calculate_partial_fill_balances`. Since the two floors are subadditive, the
 * notional plus a fee at `max(taker, maker)` covers every split between
 * matching and resting, so pass that maximum as `feeRateScaled`
 * (`TradingFees.bidEscrowFeeRate` from `orders.fees()` already is). Unused
 * funds stay in the trading account.
 */
export function computeBidQuoteDeposit(
  price: bigint,
  quantity: bigint,
  feeRateScaled: bigint,
): bigint {
  const quote = computeItemQuote(price, quantity)
  return quote + computeQuoteFee(quote, feeRateScaled)
}

/**
 * What an **ask** of `quantity` at `price` receives: since cycle 7 sellers pay
 * too, out of their quote proceeds. An ask taker pays `floor(taker × matched
 * quote)` once on the aggregate; a resting ask pays `floor(maker × fill
 * quote)` per fill, which floors per fill and so never costs more than one
 * fee on the total. Pass the taker rate for an order that will cross, or
 * `max(taker, maker)` for a lower bound either way. Asks deposit only items —
 * no quote is needed up front.
 */
export function computeAskProceeds(
  price: bigint,
  quantity: bigint,
  feeRateScaled: bigint,
): { quote: bigint; fee: bigint; net: bigint } {
  const quote = computeItemQuote(price, quantity)
  const fee = computeQuoteFee(quote, feeRateScaled)
  return { quote, fee, net: quote - fee }
}

/**
 * @deprecated Cycle 7 charges the taker fee once on the order's whole
 * matched quote rather than per fill, so `estimateMarketBuyCost` is exact
 * for an unchanged book and the SDK no longer adds this buffer. Kept for
 * source compatibility: `quantity × feeRate / 1e9 + 2`.
 */
export function marketBuyRoundingBuffer(
  quantity: bigint,
  feeRateScaled: bigint,
): bigint {
  return (quantity * feeRateScaled) / FEE_RATE_SCALING + 2n
}

/**
 * Walk `levels` best-first (taking at most `quantity`) and sum the matched
 * quote. `fillable` is how much the book can satisfy.
 */
function walkBook(
  levels: ReadonlyArray<{ price: bigint; remainingQuantity: bigint }>,
  quantity: bigint,
  bestFirst: (a: bigint, b: bigint) => number,
): { quote: bigint; fillable: bigint } {
  const sorted = [...levels].sort((a, b) => bestFirst(a.price, b.price))
  let needed = quantity
  let quote = 0n
  for (const level of sorted) {
    if (needed <= 0n) break
    const take =
      level.remainingQuantity < needed ? level.remainingQuantity : needed
    quote += take * level.price
    needed -= take
  }
  return { quote, fillable: quantity - needed }
}

/**
 * Walk the asks (lowest price first) and estimate the cost of a market buy
 * for `quantity` items, including the taker fee — charged once on the whole
 * matched quote, so for an unchanged book this is exact. `fillable` is how
 * much the current book can satisfy — when it is below `quantity`, the
 * remainder has no resting liquidity and `total` covers only the fillable part.
 * Feed `total` (or your own bound) to `orders.market` as `quoteBudget`;
 * `feeRateScaled` is the account's taker rate (`TradingFees.account.
 * takerFeeRate`, or `entryTakerFeeRate` as an upper bound).
 */
export function estimateMarketBuyCost(
  asks: ReadonlyArray<{ price: bigint; remainingQuantity: bigint }>,
  quantity: bigint,
  feeRateScaled: bigint,
): { quote: bigint; fee: bigint; total: bigint; fillable: bigint } {
  const { quote, fillable } = walkBook(asks, quantity, (a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const fee = computeQuoteFee(quote, feeRateScaled)
  return { quote, fee, total: quote + fee, fillable }
}

/**
 * Walk the bids (highest price first) and estimate what a market sell of
 * `quantity` items nets: the gross matched quote minus the ask taker fee,
 * `floor(taker × gross)`, taken out of the proceeds once on the aggregate.
 */
export function estimateMarketSellProceeds(
  bids: ReadonlyArray<{ price: bigint; remainingQuantity: bigint }>,
  quantity: bigint,
  feeRateScaled: bigint,
): { quote: bigint; fee: bigint; net: bigint; fillable: bigint } {
  const { quote, fillable } = walkBook(bids, quantity, (a, b) =>
    a > b ? -1 : a < b ? 1 : 0,
  )
  const fee = computeQuoteFee(quote, feeRateScaled)
  return { quote, fee, net: quote - fee, fillable }
}

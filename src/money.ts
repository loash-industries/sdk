/**
 * Money math for triexbook markets. Getting scaling / fees wrong silently
 * over- or under-funds orders, so this module is pure, deterministic, and the
 * primary unit-test target (see test/money.test.ts).
 *
 * MVP trades item↔CRED via `multicoin_pool`, whose price scaling factor is `1`:
 *   quote = price * quantity
 * (Coin/currency-pair pools use TRIEXBOOK_PRICE_SCALING = 1e9; those are
 * out of MVP scope but the constant is kept for when they land.)
 */

/** Price scaling for coin/currency-pair pools (`pool`). Not used by item pools. */
export const TRIEXBOOK_PRICE_SCALING = 1_000_000_000n

/** Price scaling for item (multicoin) pools. */
export const MULTICOIN_PRICE_SCALING = 1n

/**
 * Denominator of the on-chain fee rate (`FLOAT_SCALING`): pool metadata's
 * `feeRateScaled` is fee × 1e9 (20_000_000 = 2%).
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
 * Total quote (CRED base units) a **bid** must deposit into the balance manager
 * to place a limit buy of `quantity` at `price`: the quote notional plus the
 * v1 quote-denominated fee (only buyers pay fees; asks are fee-free).
 *
 * `feeRateScaled` is pool metadata's raw 1e9-scaled taker fee
 * (`PoolMetadata.feeRateScaled`; 20_000_000 = 2%). Floor-of-total semantics —
 * `quote × (1e9 + fee) / 1e9` — exactly matching the production app
 * (`computeBidQuoteDeposit` in useTriexbookMulticoinOrders.ts) and
 * TRIEX_SYSTEM_DESIGN §4. On-chain fees are computed per-fill (floored), so
 * the floored total is always sufficient.
 */
export function computeBidQuoteDeposit(
  price: bigint,
  quantity: bigint,
  feeRateScaled: bigint,
): bigint {
  const quote = computeItemQuote(price, quantity)
  return (quote * (FEE_RATE_SCALING + feeRateScaled)) / FEE_RATE_SCALING
}

/**
 * Per-fill rounding buffer for market buys: on-chain fees floor per fill
 * while client estimates round on the total, so the on-chain cost can exceed
 * the estimate by up to `quantity × feeRate` units (+2 slack) — the app's
 * exact buffer, converted to the 1e9 fee scale.
 */
export function marketBuyRoundingBuffer(
  quantity: bigint,
  feeRateScaled: bigint,
): bigint {
  return (quantity * feeRateScaled) / FEE_RATE_SCALING + 2n
}

/**
 * Walk the asks (lowest price first) and estimate the worst-case quote cost of
 * a market buy for `quantity` items, including the taker fee. `fillable` is
 * how much the current book can satisfy — when it is below `quantity`, the
 * remainder has no resting liquidity and `total` covers only the fillable part.
 * Feed `total` (or your own bound) to `orders.market` as `quoteBudget`.
 */
export function estimateMarketBuyCost(
  asks: ReadonlyArray<{ price: bigint; remainingQuantity: bigint }>,
  quantity: bigint,
  feeRateScaled: bigint,
): { quote: bigint; fee: bigint; total: bigint; fillable: bigint } {
  let needed = quantity
  let quote = 0n
  for (const level of asks) {
    if (needed <= 0n) break
    const take =
      level.remainingQuantity < needed ? level.remainingQuantity : needed
    quote += take * level.price
    needed -= take
  }
  const fee = (quote * feeRateScaled) / FEE_RATE_SCALING
  return { quote, fee, total: quote + fee, fillable: quantity - needed }
}

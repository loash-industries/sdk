/**
 * Coin-pool money math. Worked values are taken from triex-app-api's
 * `coinTradeMath.test.ts` (the production UI) and the cycle-7 Move source;
 * the deposit bound is additionally checked by brute force against the exact
 * settlement formula (`order_info::calculate_partial_fill_balances`).
 */
import {
  COIN_MAX_FILLS,
  coinMinOrderQuantity,
  coinPriceToRaw,
  coinQuoteFee,
  coinQuoteForBase,
  coinSellNet,
  computeCoinBidDeposit,
  conservativeBidFeeRate,
  estimateCoinMarketOrder,
  formatCoinPrice,
} from '../src/coins/money'

const E9 = 1_000_000_000n
const bps = (n: bigint) => n * 100_000n // whole bps → 1e9-scaled rate

describe('coinQuoteForBase (math::qty_to_quote, FLOAT_SCALING)', () => {
  it('scales by 1e9 and floors', () => {
    // app: 4e9 base at price 2.5e9 → 10e9 quote exactly
    expect(coinQuoteForBase(2_500_000_000n, 4_000_000_000n)).toBe(
      10_000_000_000n,
    )
    // 7 raw base @ 1.5 → floor(10.5) = 10 (app: "sell rounding")
    expect(coinQuoteForBase(1_500_000_000n, 7n)).toBe(10n)
    // 1 raw base at price 1 → 0 (Move floors; the app's display helper ceils)
    expect(coinQuoteForBase(1n, 1n)).toBe(0n)
  })
})

describe('coinQuoteFee (quote_fee::fee_from_scaled_rate)', () => {
  it('floors and clamps exactly like the contract (app worked values)', () => {
    expect(coinQuoteFee(90n, bps(110n))).toBe(0n)
    expect(coinQuoteFee(4_500n, bps(110n))).toBe(49n)
    expect(coinQuoteFee(10_000_000_000n, bps(200n))).toBe(200_000_000n)
    // rates above 100% clamp to 100%
    expect(coinQuoteFee(1_000n, bps(20_000n))).toBe(1_000n)
    expect(coinQuoteFee(0n, bps(200n))).toBe(0n)
  })

  it('coinSellNet takes the fee out of the gross (app sellNetFromGross)', () => {
    expect(coinSellNet(99n, bps(200n))).toBe(98n)
    expect(coinSellNet(101n, bps(200n))).toBe(99n)
    expect(coinSellNet(100n, bps(200n))).toBe(98n)
    expect(coinSellNet(49n, bps(200n))).toBe(49n)
  })
})

describe('coinMinOrderQuantity (math::min_qty_for_nonzero_quote)', () => {
  it('is ceil(1e9 / price), 1 at or above one quote unit per base', () => {
    expect(coinMinOrderQuantity(1n)).toBe(E9)
    expect(coinMinOrderQuantity(300_000_000n)).toBe(4n)
    expect(coinMinOrderQuantity(E9)).toBe(1n)
    expect(coinMinOrderQuantity(2n * E9)).toBe(1n)
  })

  it('is exactly the smallest quantity converting to non-zero quote', () => {
    for (const price of [1n, 7n, 333_333_333n, 999_999_999n, E9 + 1n]) {
      const min = coinMinOrderQuantity(price)
      expect(coinQuoteForBase(price, min)).toBeGreaterThan(0n)
      if (min > 1n) expect(coinQuoteForBase(price, min - 1n)).toBe(0n)
    }
  })
})

describe('price conversion', () => {
  it('uses the 9 + Dq − Db exponent (app parsePriceToRaw / formatRawPrice)', () => {
    expect(coinPriceToRaw('2.5', 9, 9)).toBe(2_500_000_000n)
    expect(coinPriceToRaw('2500', 9, 6)).toBe(2_500_000_000n)
    expect(formatCoinPrice(2_500_000_000n, 9, 9)).toBe('2.5')
    expect(formatCoinPrice(2_500_000_000n, 9, 6)).toBe('2500')
  })
})

describe('computeCoinBidDeposit', () => {
  it('matches the app (computeCoinBidQuoteDeposit) on exact notionals', () => {
    // app: ceil(2e9 × 5e9 / 1e9) × (10_000 + 110) / 10_000
    const app = (10_000_000_000n * 10_110n) / 10_000n
    expect(computeCoinBidDeposit(2n * E9, 5n * E9, bps(110n))).toBe(app)
    expect(app).toBe(10_110_000_000n)
  })

  it('never exceeds the app value (the app ceils the notional)', () => {
    const p = 1_234_567_891n
    const q = 987_654_321n
    const appBase = (p * q + E9 - 1n) / E9
    const app = (appBase * (10_000n + 110n)) / 10_000n
    expect(computeCoinBidDeposit(p, q, bps(110n))).toBeLessThanOrEqual(app)
  })

  /**
   * Brute force: for random orders and random fill splits (each fill at a
   * maker price ≤ the limit), the quote settlement withdraws —
   *   Σ floor(fᵢ·pᵢ/1e9) + floor(t·Σ/1e9)        (filled, taker fee once)
   *   + floor(r·p/1e9) + floor(m·floor(r·p/1e9)/1e9)   (resting + maker escrow)
   * — never exceeds the deposit at max(t, m).
   */
  it('covers every fill split at max(taker, maker) — never under-funds', () => {
    let seed = 0x2545f491n
    const rand = (max: bigint): bigint => {
      seed =
        (seed * 6364136223846793005n + 1442695040888963407n) & (2n ** 64n - 1n)
      return max <= 0n ? 0n : (seed >> 11n) % max
    }
    for (let trial = 0; trial < 2_000; trial++) {
      const price = 1n + rand(5n * E9)
      const min = coinMinOrderQuantity(price)
      const quantity = min + rand(10n * E9)
      const taker = bps(1n + rand(300n))
      const maker = bps(rand(300n))

      let remaining = quantity
      let filledQuote = 0n
      const fills = Number(rand(6n))
      for (let i = 0; i < fills && remaining > 0n; i++) {
        const take = 1n + rand(remaining)
        const makerPrice = 1n + rand(price) // ≤ limit
        filledQuote += coinQuoteForBase(makerPrice, take)
        remaining -= take
      }
      const restingQuote = coinQuoteForBase(price, remaining)
      const owed =
        filledQuote +
        coinQuoteFee(filledQuote, taker) +
        restingQuote +
        coinQuoteFee(restingQuote, maker)

      const rate = taker > maker ? taker : maker
      expect(
        computeCoinBidDeposit(price, quantity, rate),
      ).toBeGreaterThanOrEqual(owed)
    }
  })
})

describe('conservativeBidFeeRate', () => {
  const entry = { takerFee: 11_000_000n, makerFee: 9_000_000n }
  it('takes the max over taker/maker of the active and staged entry rungs', () => {
    expect(conservativeBidFeeRate(entry)).toBe(11_000_000n)
    expect(
      conservativeBidFeeRate({ takerFee: 5_000_000n, makerFee: 9_000_000n }),
    ).toBe(9_000_000n)
    expect(
      conservativeBidFeeRate(entry, {
        takerFee: 12_000_000n,
        makerFee: 13_000_000n,
      }),
    ).toBe(13_000_000n)
  })

  it('ignores maker rates for market orders (they never rest)', () => {
    expect(
      conservativeBidFeeRate(
        { takerFee: 5_000_000n, makerFee: 9_000_000n },
        { takerFee: 6_000_000n, makerFee: 13_000_000n },
        { marketOrder: true },
      ),
    ).toBe(6_000_000n)
  })
})

describe('estimateCoinMarketOrder (book::match_against_book)', () => {
  const ask = (price: bigint, remainingQuantity: bigint) => ({
    price,
    remainingQuantity,
  })

  it('walks asks best-first (app marketBuyQuoteCost: 9)', () => {
    const asks = [ask(E9, 5n), ask(2n * E9, 5n)]
    const est = estimateCoinMarketOrder(asks, 'buy', 7n, 0n)
    expect(est.grossQuote).toBe(9n)
    expect(est.filledQuantity).toBe(7n)
    expect(est.fillable).toBe(true)
  })

  it('buy: fee on top of the gross (app computeCoinQuote buy)', () => {
    const est = estimateCoinMarketOrder(
      [ask(2n * E9, 10n * E9)],
      'buy',
      5n * E9,
      bps(200n),
    )
    expect(est.grossQuote).toBe(10_000_000_000n)
    expect(est.fee).toBe(200_000_000n)
    expect(est.totalQuote).toBe(10_200_000_000n)
    expect(est.avgPrice).toBe(2n * E9)
  })

  it('sell: fee floored once on the aggregate (app: 4_451 gross, 48 fee)', () => {
    const bids = Array.from({ length: 50 }, (_, i) =>
      ask(90_000_000_000n - BigInt(i), 1n),
    )
    const est = estimateCoinMarketOrder(bids, 'sell', 50n, bps(110n))
    expect(est.grossQuote).toBe(4_451n)
    expect(est.fee).toBe(48n)
    expect(est.totalQuote).toBe(4_403n)
  })

  it('reports a partial fill when the book is thin', () => {
    const est = estimateCoinMarketOrder([ask(E9, 3n)], 'buy', 10n, 0n)
    expect(est.filledQuantity).toBe(3n)
    expect(est.fillable).toBe(false)
  })

  it('retires a maker whose whole remainder is worth zero quote', () => {
    // 5 raw base at price 1 → 0 quote: retired (visited, nothing fills)
    const est = estimateCoinMarketOrder(
      [ask(1n, 5n), ask(E9, 10n)],
      'buy',
      3n,
      0n,
    )
    expect(est.grossQuote).toBe(3n)
    expect(est.filledQuantity).toBe(3n)
    expect(est.makersVisited).toBe(2)
  })

  it('steps over a maker the taker residue would fill for zero quote', () => {
    // 1 unit at 0.5 → floor(0.5) = 0: skipped; the next maker fills it.
    const est = estimateCoinMarketOrder(
      [ask(E9 / 2n, 10n), ask(E9, 10n)],
      'buy',
      1n,
      0n,
    )
    expect(est.grossQuote).toBe(1n)
    expect(est.avgPrice).toBe(E9)
    expect(est.makersVisited).toBe(2)
  })

  it('stops after COIN_MAX_FILLS makers', () => {
    const asks = Array.from({ length: 150 }, () => ask(E9, 1n))
    const est = estimateCoinMarketOrder(asks, 'buy', 150n, 0n)
    expect(est.makersVisited).toBe(COIN_MAX_FILLS)
    expect(est.filledQuantity).toBe(BigInt(COIN_MAX_FILLS))
  })
})

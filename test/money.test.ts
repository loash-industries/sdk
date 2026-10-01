import {
  toBase,
  fromBase,
  computeItemQuote,
  computeBidQuoteDeposit,
  computeQuoteFee,
  computeAskProceeds,
  estimateMarketBuyCost,
  estimateMarketSellProceeds,
} from '../src/money'

describe('toBase / fromBase', () => {
  it('round-trips whole and fractional amounts', () => {
    expect(toBase('1', 6)).toBe(1_000_000n)
    expect(toBase('1.5', 6)).toBe(1_500_000n)
    expect(toBase(2.25, 2)).toBe(225n)
    expect(fromBase(1_000_000n, 6)).toBe('1')
    expect(fromBase(1_500_000n, 6)).toBe('1.5')
    expect(fromBase(225n, 2)).toBe('2.25')
  })

  it('truncates excess fractional precision', () => {
    expect(toBase('1.23456789', 4)).toBe(12_345n)
  })

  it('rejects malformed input', () => {
    expect(() => toBase('abc', 6)).toThrow()
    expect(() => toBase('1.2.3', 6)).toThrow()
  })

  it('handles negatives in fromBase', () => {
    expect(fromBase(-1_500_000n, 6)).toBe('-1.5')
  })
})

describe('computeItemQuote', () => {
  it('is price * quantity for item pools (scaling = 1)', () => {
    expect(computeItemQuote(100n, 3n)).toBe(300n)
    expect(computeItemQuote(0n, 5n)).toBe(0n)
  })
})

describe('computeBidQuoteDeposit', () => {
  it('adds no fee when feeRateScaled is 0', () => {
    expect(computeBidQuoteDeposit(100n, 3n, 0n)).toBe(300n)
  })

  it('applies the 1e9-scaled fee with floor-of-total semantics', () => {
    // 2% (the default volatile fee): 300 * 1.02 = 306
    expect(computeBidQuoteDeposit(100n, 3n, 20_000_000n)).toBe(306n)
    // 0.5%: 1_000_000 * 1.005 = 1_005_000
    expect(computeBidQuoteDeposit(1_000n, 1_000n, 5_000_000n)).toBe(1_005_000n)
  })

  it('floors when the fee is fractional (matches the app + on-chain per-fill floor)', () => {
    // quote = 1; 1 * 1.02 = 1.02 → floor → 1 (fee floors to zero)
    expect(computeBidQuoteDeposit(1n, 1n, 20_000_000n)).toBe(1n)
    // quote = 99; 99 * 1.02 = 100.98 → floor → 100
    expect(computeBidQuoteDeposit(99n, 1n, 20_000_000n)).toBe(100n)
  })

  it('covers any match/rest split when given max(taker, maker)', () => {
    // 1000 notional: 400 matches at 2.2% taker, 600 rests at 1.8% maker.
    const owed =
      1_000n +
      computeQuoteFee(400n, 22_000_000n) +
      computeQuoteFee(600n, 18_000_000n)
    expect(
      computeBidQuoteDeposit(100n, 10n, 22_000_000n),
    ).toBeGreaterThanOrEqual(owed)
  })
})

describe('computeQuoteFee (quote_fee::fee_from_scaled_rate)', () => {
  it('floors quote × rate / 1e9', () => {
    expect(computeQuoteFee(4_500n, 11_000_000n)).toBe(49n) // 1.10% of 4500
    expect(computeQuoteFee(90n, 11_000_000n)).toBe(0n)
  })

  it('clamps the rate at 100% and ignores non-positive inputs', () => {
    expect(computeQuoteFee(10n, 5_000_000_000n)).toBe(10n)
    expect(computeQuoteFee(0n, 22_000_000n)).toBe(0n)
    expect(computeQuoteFee(10n, 0n)).toBe(0n)
  })
})

describe('computeAskProceeds', () => {
  it('takes the fee out of the proceeds (cycle-7 seller-side fees)', () => {
    // 300 gross at the 2.2% multicoin entry taker rate: fee floor(6.6) = 6
    expect(computeAskProceeds(100n, 3n, 22_000_000n)).toEqual({
      quote: 300n,
      fee: 6n,
      net: 294n,
    })
  })
})

describe('estimateMarketBuyCost / estimateMarketSellProceeds', () => {
  const levels = [
    { price: 12n, remainingQuantity: 5n },
    { price: 10n, remainingQuantity: 3n },
  ]

  it('buys walk the asks cheapest-first whatever order they arrive in', () => {
    // 3×10 + 2×12 = 54; fee floored once on the aggregate: floor(54 × 2.2%) = 1
    expect(estimateMarketBuyCost(levels, 5n, 22_000_000n)).toEqual({
      quote: 54n,
      fee: 1n,
      total: 55n,
      fillable: 5n,
    })
  })

  it('sells walk the bids richest-first and net the taker fee', () => {
    // 5×12 + 1×10 = 70; fee floor(70 × 2.2%) = 1
    expect(estimateMarketSellProceeds(levels, 6n, 22_000_000n)).toEqual({
      quote: 70n,
      fee: 1n,
      net: 69n,
      fillable: 6n,
    })
  })

  it('reports partial fillability on a thin book', () => {
    const est = estimateMarketSellProceeds(levels, 100n, 0n)
    expect(est.fillable).toBe(8n)
    expect(est.net).toBe(90n)
  })
})

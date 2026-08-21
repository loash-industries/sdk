import {
  toBase,
  fromBase,
  computeItemQuote,
  computeBidQuoteDeposit,
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
})

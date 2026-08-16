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
  it('adds no fee when feeBps is 0', () => {
    expect(computeBidQuoteDeposit(100n, 3n, 0)).toBe(300n)
  })

  it('adds a ceil-rounded quote-denominated fee', () => {
    // quote = 300; fee = ceil(300 * 30 / 10000) = ceil(0.9) = 1
    expect(computeBidQuoteDeposit(100n, 3n, 30)).toBe(301n)
    // quote = 1_000_000; fee = 1_000_000 * 50 / 10000 = 5000
    expect(computeBidQuoteDeposit(1_000n, 1_000n, 50)).toBe(1_005_000n)
  })
})

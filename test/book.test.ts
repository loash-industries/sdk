import {
  aggregateLevels,
  bestAsk,
  bestBid,
  depth,
  midPrice,
  spread,
  vwap,
} from '../src/book'
import { iterateDiscovery, iterateFills } from '../src/paging'
import type { Orderbook, OrderbookOrder } from '../src/types'

const order = (price: bigint, remaining: bigint): OrderbookOrder => ({
  orderId: `${price}-${remaining}`,
  quantity: remaining,
  filledQuantity: 0n,
  remainingQuantity: remaining,
  expireTimestamp: 0n,
  lastUpdatedTimestamp: 0n,
  status: 0,
  price,
})

const book: Orderbook = {
  poolId: '0xp',
  bids: [order(98n, 5n), order(98n, 2n), order(95n, 10n)],
  asks: [order(102n, 3n), order(105n, 4n)],
}

describe('book analytics', () => {
  it('aggregates same-price orders into levels', () => {
    expect(aggregateLevels(book.bids)).toEqual([
      { price: 98n, quantity: 7n, orderCount: 2 },
      { price: 95n, quantity: 10n, orderCount: 1 },
    ])
  })

  it('reads best bid/ask and mid/spread', () => {
    expect(bestBid(book)?.price).toBe(98n)
    expect(bestAsk(book)?.price).toBe(102n)
    expect(midPrice(book)).toBe(100n)
    expect(spread(book)).toEqual({ absolute: 4n, bps: 400 })
    expect(depth(book.bids)).toBe(17n)
  })

  it('returns null aggregates for one-sided books', () => {
    const oneSided: Orderbook = { poolId: '0xp', bids: [], asks: book.asks }
    expect(bestBid(oneSided)).toBeNull()
    expect(midPrice(oneSided)).toBeNull()
    expect(spread(oneSided)).toBeNull()
  })

  it('computes vwap over executions', () => {
    expect(
      vwap([
        { baseQuantity: 2n, quoteQuantity: 200n },
        { baseQuantity: 3n, quoteQuantity: 330n },
      ]),
    ).toBe(106n) // 530 / 5
    expect(vwap([])).toBeNull()
  })
})

describe('pagination generators', () => {
  it('iterateDiscovery follows nextCursor and stops at the end', async () => {
    const pages = [
      {
        orders: [{ orderId: '1' }, { orderId: '2' }],
        nextCursor: 'c2',
        prevCursor: null,
      },
      { orders: [{ orderId: '3' }], nextCursor: null, prevCursor: null },
    ]
    const calls: unknown[] = []
    const indexer = {
      discovery: async (f: any) => {
        calls.push(f?.cursor)
        return pages.shift()
      },
    } as any
    const seen: string[] = []
    for await (const o of iterateDiscovery(indexer, { limit: 2 })) {
      seen.push((o as any).orderId)
    }
    expect(seen).toEqual(['1', '2', '3'])
    expect(calls).toEqual([undefined, 'c2'])
  })

  it('iterateDiscovery honors maxItems', async () => {
    const indexer = {
      discovery: async () => ({
        orders: [{ orderId: 'x' }, { orderId: 'y' }],
        nextCursor: 'more',
        prevCursor: null,
      }),
    } as any
    const seen: unknown[] = []
    for await (const o of iterateDiscovery(indexer, {}, { maxItems: 3 })) {
      seen.push(o)
    }
    expect(seen).toHaveLength(3)
  })

  it('iterateFills advances the strictly-older `before` bound', async () => {
    const pages = [
      { fills: [{ filledAt: 300 }, { filledAt: 200 }], nextCursor: null },
      { fills: [{ filledAt: 100 }], nextCursor: null },
      { fills: [], nextCursor: null },
    ]
    const befores: unknown[] = []
    const indexer = {
      fills: async (_bm: string, p: any) => {
        befores.push(p?.before)
        return pages.shift()
      },
    } as any
    const seen: number[] = []
    for await (const f of iterateFills(indexer, '0xbm')) {
      seen.push((f as any).filledAt)
    }
    expect(seen).toEqual([300, 200, 100])
    expect(befores).toEqual([undefined, 200, 100])
  })
})

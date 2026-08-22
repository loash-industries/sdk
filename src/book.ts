import type { Fill, Orderbook, OrderbookOrder, Trade } from './types'

/**
 * Order-book analytics helpers. The indexer returns individual resting orders
 * (bids high-first, asks low-first); these pure functions turn them into the
 * aggregates market tools actually chart. All math is bigint and in raw base
 * units — combine with `fromBase` + pool-metadata decimals for display.
 */

export interface BookLevel {
  price: bigint
  /** Total REMAINING quantity resting at this price. */
  quantity: bigint
  orderCount: number
}

/** Collapse resting orders into price levels, preserving book order. */
export function aggregateLevels(orders: OrderbookOrder[]): BookLevel[] {
  const levels: BookLevel[] = []
  for (const order of orders) {
    const last = levels[levels.length - 1]
    if (last && last.price === order.price) {
      last.quantity += order.remainingQuantity
      last.orderCount++
    } else {
      levels.push({
        price: order.price,
        quantity: order.remainingQuantity,
        orderCount: 1,
      })
    }
  }
  return levels
}

/** Best (highest) bid, or null on an empty side. */
export function bestBid(book: Orderbook): OrderbookOrder | null {
  return book.bids[0] ?? null
}

/** Best (lowest) ask, or null on an empty side. */
export function bestAsk(book: Orderbook): OrderbookOrder | null {
  return book.asks[0] ?? null
}

/** Midpoint of the best bid/ask, or null unless both sides have depth. */
export function midPrice(book: Orderbook): bigint | null {
  const bid = bestBid(book)
  const ask = bestAsk(book)
  if (!bid || !ask) return null
  return (bid.price + ask.price) / 2n
}

/** Absolute spread and spread in basis points of the mid, or null. */
export function spread(
  book: Orderbook,
): { absolute: bigint; bps: number } | null {
  const bid = bestBid(book)
  const ask = bestAsk(book)
  if (!bid || !ask) return null
  const absolute = ask.price - bid.price
  const mid = (bid.price + ask.price) / 2n
  if (mid === 0n) return { absolute, bps: 0 }
  return { absolute, bps: Number((absolute * 10_000n) / mid) }
}

/** Total remaining quantity on one side of the book. */
export function depth(orders: OrderbookOrder[]): bigint {
  let total = 0n
  for (const o of orders) total += o.remainingQuantity
  return total
}

/**
 * Volume-weighted average price over fills/trades (quote units per base
 * unit), or null when nothing traded. Works on any slice with
 * `baseQuantity`/`quoteQuantity`.
 */
export function vwap(
  executions: ReadonlyArray<
    Pick<Fill | Trade, 'baseQuantity' | 'quoteQuantity'>
  >,
): bigint | null {
  let base = 0n
  let quote = 0n
  for (const f of executions) {
    base += f.baseQuantity
    quote += f.quoteQuantity
  }
  if (base === 0n) return null
  return quote / base
}

/** One OHLCV bucket built from executed trades. */
export interface Candle {
  /** Bucket start, epoch ms (aligned to the interval). */
  openTime: number
  open: bigint
  high: bigint
  low: bigint
  close: bigint
  /** Total base quantity traded in the bucket. */
  baseVolume: bigint
  /** Total quote (CRED) exchanged in the bucket. */
  quoteVolume: bigint
  /** Number of trades in the bucket. */
  tradeCount: number
}

/**
 * Bucket executed trades into OHLCV candles — the API has no price-history
 * endpoint, so analytics tools build candles client-side from
 * `iterateTrades`/`fills`. Accepts trades in any order (sorted internally,
 * oldest first); buckets with no trades are omitted, not zero-filled.
 */
export function bucketTrades(
  trades: ReadonlyArray<
    Pick<Trade, 'price' | 'baseQuantity' | 'quoteQuantity' | 'tradedAt'>
  >,
  intervalMs: number,
): Candle[] {
  if (intervalMs <= 0) throw new Error('intervalMs must be positive')
  const sorted = [...trades].sort((a, b) => a.tradedAt - b.tradedAt)
  const candles: Candle[] = []
  for (const t of sorted) {
    const openTime = Math.floor(t.tradedAt / intervalMs) * intervalMs
    const last = candles[candles.length - 1]
    if (last && last.openTime === openTime) {
      if (t.price > last.high) last.high = t.price
      if (t.price < last.low) last.low = t.price
      last.close = t.price
      last.baseVolume += t.baseQuantity
      last.quoteVolume += t.quoteQuantity
      last.tradeCount++
    } else {
      candles.push({
        openTime,
        open: t.price,
        high: t.price,
        low: t.price,
        close: t.price,
        baseVolume: t.baseQuantity,
        quoteVolume: t.quoteQuantity,
        tradeCount: 1,
      })
    }
  }
  return candles
}

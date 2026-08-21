import type { IndexerClient } from './queries'
import type {
  DiscoveryFilters,
  DiscoveryOrder,
  Fill,
  FillsParams,
  Trade,
  TradesParams,
} from './types'

/**
 * Auto-pagination helpers — async generators that follow the wire cursors so
 * analytics tools and bots can stream full histories without hand-rolling
 * pagination.
 *
 * Discovery pages by opaque `cursor`; fills/trades page by epoch-ms `before`
 * bounds (entries strictly older than the last one seen). `maxItems` caps the
 * walk (default 10_000) so an unbounded market can't run a caller dry —
 * remember every page costs CUs against the API key.
 */

export interface IterateOptions {
  /** Stop after yielding this many items (default 10_000). */
  maxItems?: number
}

/** Stream discovery orders (most-recent activity first) across pages. */
export async function* iterateDiscovery(
  indexer: IndexerClient,
  filters?: DiscoveryFilters,
  options?: IterateOptions,
): AsyncGenerator<DiscoveryOrder> {
  const max = options?.maxItems ?? 10_000
  let cursor = filters?.cursor
  let yielded = 0
  for (;;) {
    const page = await indexer.discovery({ ...filters, cursor })
    for (const order of page.orders) {
      yield order
      if (++yielded >= max) return
    }
    if (!page.nextCursor || page.orders.length === 0) return
    cursor = page.nextCursor
  }
}

/** Stream fills (newest first) for a balance manager across pages. */
export async function* iterateFills(
  indexer: IndexerClient,
  balanceManagerId: string,
  params?: FillsParams,
  options?: IterateOptions,
): AsyncGenerator<Fill> {
  const max = options?.maxItems ?? 10_000
  let before = params?.before
  let yielded = 0
  for (;;) {
    const page = await indexer.fills(balanceManagerId, { ...params, before })
    if (page.fills.length === 0) return
    for (const fill of page.fills) {
      yield fill
      if (++yielded >= max) return
    }
    // `before` is strictly-older, so the last timestamp seen advances the walk.
    before = page.fills[page.fills.length - 1].filledAt
  }
}

/** Stream trades (newest first) for a balance manager across pages. */
export async function* iterateTrades(
  indexer: IndexerClient,
  balanceManagerId: string,
  params?: TradesParams,
  options?: IterateOptions,
): AsyncGenerator<Trade> {
  const max = options?.maxItems ?? 10_000
  let before = params?.before
  let yielded = 0
  for (;;) {
    const page = await indexer.trades(balanceManagerId, { ...params, before })
    if (page.trades.length === 0) return
    for (const trade of page.trades) {
      yield trade
      if (++yielded >= max) return
    }
    before = page.trades[page.trades.length - 1].tradedAt
  }
}

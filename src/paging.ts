import type { OrgDirectoryEntry, OrgDirectoryParams } from './armature/types'
import type { IndexerClient } from './queries'
import type {
  DiscoveryFilters,
  DiscoveryOrder,
  Fill,
  FillsParams,
  HistoryPageParams,
  HubLocation,
  HubLocationFilters,
  LocationPageParams,
  OpenOrder,
  RecentTrade,
  RecentTradesParams,
  Trade,
  TradesParams,
} from './types'

/**
 * Auto-pagination helpers — async generators that follow the wire cursors so
 * analytics tools and bots can stream full histories without hand-rolling
 * pagination.
 *
 * Two cursor dialects, as the gateway serves them:
 *
 * - **Opaque `cursor`** (discovery, hub/item locations): pass `nextCursor`
 *   back as `cursor` until it is null.
 * - **Epoch-ms `before`** (open orders, fills, trades, recent trades): the
 *   page's `nextCursor` IS the timestamp of its last row; pass it back as
 *   `before` (strictly older). It is null once a page comes back short, so
 *   the walk stops without spending a request on an empty page. Rows sharing
 *   the boundary millisecond with a full page's last row are skipped by the
 *   server's strict bound — rare, and unavoidable through this API.
 *
 * `maxItems` caps the walk (default 10_000) so an unbounded market can't run a
 * caller dry — remember every page costs CUs against the API key.
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

/**
 * The epoch-ms `before` bound for the next page, or null when the walk is
 * done. The gateway's `nextCursor` is the last row's timestamp as a string;
 * fall back to the row itself if a cursor ever arrives unparseable.
 */
function nextBefore(
  nextCursor: string | null,
  lastTimestamp: number | undefined,
): number | null {
  if (nextCursor === null || lastTimestamp === undefined) return null
  const parsed = Number(nextCursor)
  return Number.isFinite(parsed) ? parsed : lastTimestamp
}

/** Stream fills (newest first) for a trading account across pages. */
export async function* iterateFills(
  indexer: IndexerClient,
  tradingAccountId: string,
  params?: FillsParams,
  options?: IterateOptions,
): AsyncGenerator<Fill> {
  const max = options?.maxItems ?? 10_000
  let before = params?.before
  let yielded = 0
  for (;;) {
    const page = await indexer.fills(tradingAccountId, { ...params, before })
    for (const fill of page.fills) {
      yield fill
      if (++yielded >= max) return
    }
    const next = nextBefore(page.nextCursor, page.fills.at(-1)?.filledAt)
    if (next === null) return
    before = next
  }
}

/** Stream trades (newest first) for a trading account across pages. */
export async function* iterateTrades(
  indexer: IndexerClient,
  tradingAccountId: string,
  params?: TradesParams,
  options?: IterateOptions,
): AsyncGenerator<Trade> {
  const max = options?.maxItems ?? 10_000
  let before = params?.before
  let yielded = 0
  for (;;) {
    const page = await indexer.trades(tradingAccountId, { ...params, before })
    for (const trade of page.trades) {
      yield trade
      if (++yielded >= max) return
    }
    const next = nextBefore(page.nextCursor, page.trades.at(-1)?.tradedAt)
    if (next === null) return
    before = next
  }
}

/** Stream a trading account's resting orders (newest activity first). */
export async function* iterateOpenOrders(
  indexer: IndexerClient,
  tradingAccountId: string,
  params?: HistoryPageParams,
  options?: IterateOptions,
): AsyncGenerator<OpenOrder> {
  const max = options?.maxItems ?? 10_000
  let before = params?.before
  let yielded = 0
  for (;;) {
    const page = await indexer.openOrders(tradingAccountId, {
      ...params,
      before,
    })
    for (const order of page.orders) {
      yield order
      if (++yielded >= max) return
    }
    const next = nextBefore(page.nextCursor, page.orders.at(-1)?.updatedAt)
    if (next === null) return
    before = next
  }
}

/**
 * Stream the universe-wide trade feed (newest first). Pages are at most 50
 * rows at 50 CU each, so a deep history walk is expensive — bound it with
 * `after` (only trades newer than a time) or `maxItems`.
 */
export async function* iterateRecentTrades(
  indexer: IndexerClient,
  params?: RecentTradesParams,
  options?: IterateOptions,
): AsyncGenerator<RecentTrade> {
  const max = options?.maxItems ?? 10_000
  let before = params?.before
  let yielded = 0
  for (;;) {
    const page = await indexer.recentTrades({ ...params, before })
    for (const trade of page.trades) {
      yield trade
      if (++yielded >= max) return
    }
    const next = nextBefore(page.nextCursor, page.trades.at(-1)?.tradedAt)
    if (next === null) return
    before = next
  }
}

/** Stream every indexed hub location matching `filters` (50 CU per page). */
export async function* iterateHubLocations(
  indexer: IndexerClient,
  filters?: HubLocationFilters,
  options?: IterateOptions,
): AsyncGenerator<HubLocation> {
  const max = options?.maxItems ?? 10_000
  let cursor = filters?.cursor
  let yielded = 0
  for (;;) {
    const page = await indexer.hubLocations({ ...filters, cursor })
    for (const location of page.locations) {
      yield location
      if (++yielded >= max) return
    }
    if (!page.nextCursor || page.locations.length === 0) return
    cursor = page.nextCursor
  }
}

/** Stream every hub location offering `assetId` for sale (50 CU per page). */
export async function* iterateItemLocations(
  indexer: IndexerClient,
  assetId: string,
  params?: LocationPageParams,
  options?: IterateOptions,
): AsyncGenerator<HubLocation> {
  const max = options?.maxItems ?? 10_000
  let cursor = params?.cursor
  let yielded = 0
  for (;;) {
    const page = await indexer.itemLocations(assetId, { ...params, cursor })
    for (const location of page.locations) {
      yield location
      if (++yielded >= max) return
    }
    if (!page.nextCursor || page.locations.length === 0) return
    cursor = page.nextCursor
  }
}

/**
 * Stream the organization discovery directory across pages.
 *
 * The endpoint caps `limit` at 50 and defaults to 8, so a full walk is many
 * requests at 50 CU each — keep `maxItems` tight unless you really want every
 * organization.
 */
export async function* iterateOrgDirectory(
  indexer: IndexerClient,
  params?: OrgDirectoryParams,
  options?: IterateOptions,
): AsyncGenerator<OrgDirectoryEntry> {
  const max = options?.maxItems ?? 10_000
  let cursor = params?.cursor
  let yielded = 0
  for (;;) {
    const page = await indexer.orgs.directory({ ...params, cursor })
    for (const entry of page.entries) {
      yield entry
      if (++yielded >= max) return
    }
    if (!page.nextCursor || page.entries.length === 0) return
    cursor = page.nextCursor
  }
}

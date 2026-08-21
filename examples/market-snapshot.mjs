/**
 * Market analytics example: take a live snapshot of the most active markets —
 * best bid/ask, mid, spread, depth — from nothing but an API key.
 *
 *   node --env-file=.env examples/market-snapshot.mjs
 *
 * (In your own project, import from '@trinaryex/sdk' instead of ../dist.)
 */
import {
  ReadOnlyClient,
  aggregateLevels,
  midPrice,
  spread,
  depth,
  fromBase,
} from '../dist/index.js'

const apiKey = process.env.TRINARY_API_KEY ?? process.env.TRIEX_API_KEY
const ro = new ReadOnlyClient({ apiKey })

// 1. What's trading right now, anywhere in the universe?
const feed = await ro.discover({ limit: 25 })
const markets = new Map()
for (const order of feed.orders) {
  if (!order.hubId) continue
  const key = `${order.hubId}:${order.assetId}`
  if (!markets.has(key)) markets.set(key, order)
}
console.log(`discovery: ${feed.orders.length} recent orders, ${markets.size} distinct markets\n`)

// 2. Snapshot each market's book.
for (const order of [...markets.values()].slice(0, 5)) {
  const { hubName, assetId, hubId } = order
  try {
    const book = await ro.orderbook({ storageUnitId: hubId, assetId })
    const meta = await ro.poolMetadata(book.poolId)
    const dec = meta.quoteAssetDecimals
    const fmt = (v) => (v === null ? '—' : fromBase(v, dec))

    console.log(`■ ${hubName ?? hubId.slice(0, 12)} · item ${assetId} (${meta.poolName})`)
    console.log(`  mid ${fmt(midPrice(book))} CRED · spread ${spread(book)?.bps ?? '—'} bps`)
    console.log(`  bids ${book.bids.length} orders / depth ${depth(book.bids)} · asks ${book.asks.length} / depth ${depth(book.asks)}`)
    const top = aggregateLevels(book.bids)[0]
    if (top) console.log(`  top bid level: ${fmt(top.price)} × ${top.quantity} (${top.orderCount} order(s))`)
    console.log()
  } catch (e) {
    console.log(`■ ${hubName ?? hubId} · item ${assetId} — ${e.message}\n`)
  }
}

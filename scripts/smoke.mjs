/**
 * Live smoke test against the published gateway + testnet fullnode.
 * Read-only; costs a few hundred CUs on the configured key. Run with:
 *
 *   npm run build && node --env-file=.env scripts/smoke.mjs
 *
 * Walks the real read surface end-to-end: discovery → hub detail → items →
 * pool resolve → orderbook → metadata → hub balances → order status, then the
 * fullnode currency read for a discovered balance manager. Exits non-zero if
 * any step fails.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc'
import {
  ReadOnlyClient,
  getBalanceManagerCurrencyBalance,
  getWalletCurrencyBalance,
  STILLNESS_PACKAGE_IDS,
} from '../dist/index.js'

const apiKey = process.env.TRINARY_API_KEY ?? process.env.TRIEX_API_KEY
if (!apiKey) {
  console.error('TRINARY_API_KEY missing — put it in .env')
  process.exit(1)
}

const ro = new ReadOnlyClient({ apiKey })
const sui = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
})

const show = (v) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))
let failures = 0

async function step(name, fn) {
  try {
    const out = await fn()
    console.log(`✅ ${name}${out !== undefined ? ` — ${out}` : ''}`)
    return true
  } catch (e) {
    failures++
    console.error(`❌ ${name} — ${e?.code ?? ''} ${e?.message ?? e}`)
    return false
  }
}

// ── 1. discovery ─────────────────────────────────────────────────────────────
let feed
await step('market.discover', async () => {
  feed = await ro.discover({ limit: 5 })
  return `${feed.orders.length} orders, nextCursor=${feed.nextCursor}`
})

const order = feed?.orders.find((o) => o.hubId) ?? feed?.orders[0]
if (!order) {
  console.log('⚠️  discovery returned no orders — cannot exercise the rest; stopping.')
  process.exit(failures ? 1 : 0)
}
console.log(`   using order: ${show(order)}`)

// ── 2. hub detail + items ────────────────────────────────────────────────────
const hubId = order.hubId
if (hubId) {
  await step('market.hub (vault + location)', async () => {
    const hub = await ro.hub(hubId)
    const loc = hub.location
      ? `public=${hub.location.isPublic} system=${hub.location.solarSystemName ?? hub.location.solarSystemId}`
      : 'location=unrevealed (null)'
    return `collection=${hub.collectionId.slice(0, 10)}… vaultConfig=${hub.vaultConfigId.slice(0, 10)}… ${loc}`
  })
  await step('market.itemsAtHub', async () => {
    const page = await ro.itemsAtHub(hubId)
    return `${page.items.length} items (first: ${show(page.items[0] ?? null)})`
  })

  // ── 3. resolve chain + orderbook ──────────────────────────────────────────
  await step('resolvePool → orderbook chain', async () => {
    const book = await ro.orderbook({
      storageUnitId: hubId,
      assetId: order.assetId,
    })
    const best = book.bids[0] ?? book.asks[0]
    return `pool=${book.poolId.slice(0, 10)}… bids=${book.bids.length} asks=${book.asks.length} best=${show(best ?? null)}`
  })

  // ── 5. hub-scoped balances (no owner params → sections empty but validated) ─
  await step('balancesAtHub (schema validation)', async () => {
    const inv = await ro.balancesAtHub({ storageUnitId: hubId })
    return `collection=${inv.collectionId.slice(0, 10)}… warehouse=${inv.warehouse.length} marketplace=${inv.marketplace.length} hangar=${inv.hangar.length}`
  })
} else {
  console.log('⚠️  discovered order has no hubId — skipping hub-scoped steps')
}

// ── 4. pool metadata (fee fields) ────────────────────────────────────────────
await step('poolMetadata', async () => {
  const meta = await ro.poolMetadata(order.poolId)
  return `"${meta.poolName}" feeRateScaled=${meta.feeRateScaled} feeRate=${meta.feeRate} baseDecimals=${meta.baseAssetDecimals} quoteDecimals=${meta.quoteAssetDecimals}`
})

// ── 6. order status for the discovered balance manager ───────────────────────
const bm = order.balanceManagerId
await step('openOrders', async () => {
  const page = await ro.openOrders(bm, { limit: 5 })
  return `${page.orders.length} open (first: ${show(page.orders[0] ?? null)})`
})
await step('fills', async () => {
  const page = await ro.fills(bm, { limit: 5 })
  return `${page.fills.length} fills`
})
await step('trades', async () => {
  const page = await ro.trades(bm, { limit: 5 })
  return `${page.trades.length} trades`
})

// ── 7. fullnode currency reads (no API key involved) ─────────────────────────
await step('onchain: BM CRED balance (BalanceKey dynamic field)', async () => {
  const bal = await getBalanceManagerCurrencyBalance(
    sui,
    STILLNESS_PACKAGE_IDS,
    bm,
  )
  return `${bal} base units`
})
if (order.traderAddress) {
  await step('onchain: wallet CRED balance (listCoins)', async () => {
    const bal = await getWalletCurrencyBalance(
      sui,
      order.traderAddress,
      STILLNESS_PACKAGE_IDS.credCoinType,
    )
    return `${bal} base units`
  })
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nAll smoke steps passed.')
process.exit(failures ? 1 : 0)

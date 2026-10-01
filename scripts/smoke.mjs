/**
 * Live smoke test against the published gateway + testnet fullnode.
 * Read-only; costs roughly 1,500 CUs on the configured key. Run with:
 *
 *   npm run build && node --env-file=.env scripts/smoke.mjs
 *
 * Walks the real read surface end-to-end: discovery → hub detail → items →
 * pool resolve → orderbook → metadata → hub balances → order status → order /
 * fill lookups → market feeds, prices and stats → characters and tribes →
 * world items and recipes → star map and routing, then the fullnode currency
 * read for a discovered trading account. Exits non-zero if any step fails.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc'
import {
  ReadOnlyClient,
  getTradingAccountCurrencyBalance,
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

// ── 6. order status for the discovered trading account ───────────────────────
const bm = order.tradingAccountId
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

// ── 6b. point lookups: this order, and the account's latest fill ─────────────
await step('order (pool + id)', async () => {
  const detail = await ro.order({ poolId: order.poolId, orderId: order.orderId })
  return `status=${detail.status} type=${detail.orderType} fills=${detail.fills.length} owner=${detail.tradingAccount.character?.name ?? detail.tradingAccount.owner}`
})
await step('fill (by event digest)', async () => {
  const { fills } = await ro.fills(bm, { limit: 1 })
  if (!fills[0]) return 'account has no fills — skipped'
  const fill = await ro.fill(fills[0].eventDigest)
  return `makerFee=${fill.makerFee} takerFee=${fill.takerFee} asset=${fill.assetId}`
})

// ── 6c. market-wide feeds, prices & rankings ─────────────────────────────────
await step('recentTrades', async () => {
  const page = await ro.recentTrades({ limit: 5 })
  const t = page.trades[0]
  return `${page.trades.length} trades${t ? ` (latest: ${t.quantity} × ${t.price} @ ${t.feeRateBps} bps)` : ''}`
})
await step('displayPrice / displayPrices', async () => {
  const one = await ro.displayPrice(order.assetId, {
    storageUnitId: order.hubId ?? undefined,
  })
  const many = await ro.displayPrices({ itemIds: [order.assetId, '77800'] })
  return `${order.assetId}: tier=${one.tier} price=${one.price}; batch=${many.length}`
})
if (hubId) {
  await step('hubEconomics', async () => {
    const [eco] = await ro.hubEconomics({ hubIds: [hubId] })
    return eco
      ? `feeReserve=${eco.feeReserve} depth=${eco.liquidityDepth} items=${eco.uniqueItems}`
      : 'hub omitted'
  })
}
await step('topPoolsByFees', async () => {
  const pools = await ro.topPoolsByFees({ limit: 3 })
  return `${pools.length} pools (top: ${pools[0]?.feesAvailableToClaim ?? '—'})`
})
await step('stats', async () => {
  const s = await ro.stats()
  return `trades=${s.marketplace.trades.allTime} openOrders=${s.marketplace.openOrders} orgs=${s.organizations.total} pilots=${s.pilots.total}`
})

// ── 6d. characters & tribes ──────────────────────────────────────────────────
if (order.traderAddress) {
  await step('characters (by address → by id → batch → tribe)', async () => {
    const chars = await ro.charactersByAddress(order.traderAddress, {
      enrich: true,
    })
    if (!chars[0]) return 'no character for the trader'
    const one = await ro.character(chars[0].characterId)
    const [batch] = await ro.charactersBatch({
      addresses: [order.traderAddress],
    })
    const byName = await ro.charactersByName(one.name)
    const tribe = one.tribeId ? await ro.tribe(one.tribeId) : null
    return `${chars.length} char(s); "${one.name}" ownerCap=${chars[0].ownerCapId ? 'yes' : 'no'} batchTribe=${batch.tribeName} byName=${byName.length} tribe=${tribe?.nameShort ?? '—'}`
  })
}

// ── 6e. world reference data ─────────────────────────────────────────────────
await step('world items / item / recipes', async () => {
  const items = await ro.worldItems()
  const info = await ro.worldItem(order.assetId)
  const recipes = await ro.recipes()
  const forFirst = await ro.recipesFor(recipes[0].productAssetId)
  const none = await ro.recipesFor('1')
  return `${items.length} items, "${info.name}"; ${recipes.length} recipes, ${forFirst.length} for ${recipes[0].productName}, ${none.length} for an uncraftable id`
})

// ── 6f. star map & routing (names are player-reported in cycle 7) ────────────
await step('spatial stats + routing stats', async () => {
  const s = await ro.spatialStats()
  const r = await ro.routingStats()
  return `systems=${s.totalSystems} knownNames=${s.knownSolarSystemNames} gateEdges=${r.stargateEdges} driveEdges=${r.jumpDriveEdges} range=${r.maxJumpRangeLy}ly`
})
await step('route between two reported names', async () => {
  const { systems } = await ro.spatialAutocompleteSystems('U', { limit: 2 })
  if (systems.length < 2) return 'fewer than two reported names — skipped'
  try {
    const route = await ro.route({
      origin: systems[0].solarSystemName,
      destination: systems[1].solarSystemName,
      maxJumpRangeLy: 500,
    })
    return `${systems[0].solarSystemName} → ${systems[1].solarSystemName}: ${route.totalJumps} jumps, ${route.totalDistanceLy.toFixed(1)} ly (${route.optimization})`
  } catch (e) {
    // Two reported systems can still be unreachable under these parameters.
    if (e?.code === 'TRIEX_ROUTE_NOT_FOUND') return `no route (${e.message})`
    throw e
  }
})

// ── 7. fullnode currency reads (no API key involved) ─────────────────────────
await step('onchain: BM CRED balance (BalanceKey dynamic field)', async () => {
  const bal = await getTradingAccountCurrencyBalance(
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

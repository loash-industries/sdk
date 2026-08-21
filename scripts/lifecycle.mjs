/**
 * FULL trading-lifecycle test on live testnet — requires a signer holding gas
 * AND CRED. Exercises every success path end-to-end:
 *
 *   deposit → withdraw round-trip → resting limit bid → indexer pickup →
 *   modify → cancel → refund recovery → REAL market buy (fill) → fills/trades
 *   reads → sweepable → claimSettled → final balances.
 *
 *   npm run build && node --env-file=.env scripts/lifecycle.mjs
 *
 * Spends real (testnet) CRED on the market buy, capped at MAX_SPEND.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import {
  TriexClient,
  estimateMarketBuyCost,
  fromBase,
} from '../dist/index.js'

const MAX_SPEND = 50_000_000_000n // ≤ 50k CRED (6 decimals) on the real-fill step

const apiKey = process.env.TRINARY_API_KEY ?? process.env.TRIEX_API_KEY
const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY)
const sui = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
})
const client = new TriexClient({
  suiClient: sui,
  apiKey,
  address: keypair.toSuiAddress(),
  executor: (tx) =>
    sui.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      include: { effects: true, objectTypes: true },
    }),
})

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function retry(times, delayMs, fn) {
  let last
  for (let i = 0; i < times; i++) {
    last = await fn()
    if (last) return last
    await sleep(delayMs)
  }
  return last
}

// ── 0. starting state ────────────────────────────────────────────────────────
let cred = await client.balances.currency()
console.log(
  `wallet ${fromBase(cred.wallet, 6)} CRED · BM ${fromBase(cred.balanceManager, 6)} CRED · bm=${cred.balanceManagerId}`,
)
if (cred.wallet === 0n) {
  console.error('signer has no CRED — fund it first')
  process.exit(1)
}

// ── 1. currency deposit → withdraw round-trip ────────────────────────────────
const DEPOSIT = 1_000_000n // 1 CRED
await step(`depositCurrency ${fromBase(DEPOSIT, 6)} CRED`, async () => {
  const r = await client.account.depositCurrency({ amount: DEPOSIT })
  return `digest=${r.digest}`
})
await step('BM balance reflects the deposit (fullnode, head-current)', async () => {
  const c = await client.balances.currency()
  if (c.balanceManager < DEPOSIT) {
    throw new Error(`BM holds ${c.balanceManager}, expected ≥ ${DEPOSIT}`)
  }
  return `BM=${fromBase(c.balanceManager, 6)} CRED`
})
await step('withdrawCurrency (all) returns it to the wallet', async () => {
  const before = (await client.balances.currency()).wallet
  await client.account.withdrawCurrency()
  const after = await client.balances.currency()
  if (after.balanceManager !== 0n) throw new Error('BM not emptied')
  return `wallet ${fromBase(before, 6)} → ${fromBase(after.wallet, 6)} CRED`
})

// ── 2. resting limit bid → indexer pickup → modify → cancel ──────────────────
const feed = await client.market.discover({ limit: 15 })
const market = feed.orders.find((o) => o.hubId)
if (!market) {
  console.error('no discoverable market; stopping')
  process.exit(1)
}
console.log(`market: ${market.hubName ?? market.hubId} · item ${market.assetId}`)

let restingOrderId = null
await step('place a resting limit bid (price 1, qty 3 — will not fill)', async () => {
  const r = await client.orders.limit({
    storageUnitId: market.hubId,
    assetId: market.assetId,
    side: 'buy',
    price: 1n,
    quantity: 3n,
  })
  return `digest=${r.digest}`
})
await step('openOrders shows the resting bid (indexer pickup)', async () => {
  const found = await retry(15, 2000, async () => {
    const { orders } = await client.orders.openOrders({ limit: 20 })
    return orders.find(
      (o) => o.assetId === market.assetId && o.side === 'buy' && o.price === 1n,
    )
  })
  if (!found) throw new Error('resting bid never appeared in openOrders')
  restingOrderId = found.orderId
  return `orderId=${found.orderId} remaining=${found.remainingQuantity}`
})
await step('modify the resting bid down to qty 2', async () => {
  const r = await client.orders.modify({
    storageUnitId: market.hubId,
    assetId: market.assetId,
    orderId: restingOrderId,
    newQuantity: 2n,
  })
  return `digest=${r.digest}`
})
await step('cancel the resting bid', async () => {
  const r = await client.orders.cancel({
    storageUnitId: market.hubId,
    assetId: market.assetId,
    orderId: restingOrderId,
  })
  return `digest=${r.digest}`
})
await step('openOrders no longer lists it', async () => {
  const gone = await retry(15, 2000, async () => {
    const { orders } = await client.orders.openOrders({ limit: 20 })
    return orders.every((o) => o.orderId !== restingOrderId) ? true : null
  })
  if (!gone) throw new Error('canceled order still listed')
})
await step('recover the cancel refund (sweepable/claim or already in BM)', async () => {
  const m = await client.account.sweepable()
  const claimable = m.pools.filter(
    (p) => p.settled.base > 0n || p.settled.quote > 0n || p.settled.cred > 0n,
  )
  if (claimable.length > 0) {
    const r = await client.account.claimSettled()
    return `claimed from ${claimable.length} pool(s): ${r.digest}`
  }
  const c = await client.balances.currency()
  return `refund already in BM (${fromBase(c.balanceManager, 6)} CRED) — nothing settled`
})

// ── 3. REAL market buy against the cheapest ask ──────────────────────────────
let bought = null
await step('find an affordable ask and market-buy 1 item (REAL fill)', async () => {
  // Look for asks among recent discovery orders.
  const sells = feed.orders.filter((o) => !o.isBid && o.hubId)
  for (const ask of sells) {
    const book = await client.market.orderbook({
      storageUnitId: ask.hubId,
      assetId: ask.assetId,
    })
    if (book.asks.length === 0) continue
    const meta = await client.market.poolMetadata(book.poolId)
    const est = estimateMarketBuyCost(book.asks, 1n, meta.feeRateScaled)
    if (est.fillable < 1n || est.total > MAX_SPEND) continue
    const r = await client.orders.market({
      storageUnitId: ask.hubId,
      assetId: ask.assetId,
      side: 'buy',
      quantity: 1n,
      quoteBudget: est.total,
    })
    bought = { hub: ask.hubId, assetId: ask.assetId, est }
    return `bought 1× item ${ask.assetId} for ~${fromBase(est.total, 6)} CRED — ${r.digest}`
  }
  throw new Error(`no ask affordable within ${fromBase(MAX_SPEND, 6)} CRED found`)
})

if (bought) {
  await step('fills/trades record the execution (indexer)', async () => {
    const seen = await retry(15, 2000, async () => {
      const { trades } = await client.orders.trades({ limit: 10 })
      return trades.find((t) => t.assetId === bought.assetId && t.side === 'buy')
    })
    if (!seen) throw new Error('trade never appeared')
    return `paid ${fromBase(seen.quoteQuantity, 6)} CRED (fee ${fromBase(seen.fee, 6)}), role=${seen.role}`
  })
  await step('claim any settled proceeds, then final state', async () => {
    const m = await client.account.sweepable()
    const claimable = m.pools.filter(
      (p) => p.settled.base > 0n || p.settled.quote > 0n || p.settled.cred > 0n,
    )
    if (claimable.length > 0) await client.account.claimSettled()
    const inv = await client.balances.atHub({ storageUnitId: bought.hub })
    const mine = inv.marketplace.find((b) => b.assetId === bought.assetId)
    const c = await client.balances.currency()
    return `BM item ${bought.assetId}=${mine?.amount ?? '0 (indexer lag)'} · BM ${fromBase(c.balanceManager, 6)} CRED · wallet ${fromBase(c.wallet, 6)} CRED`
  })
}

// ── 4. sweep everything back to the wallet ───────────────────────────────────
await step('withdrawCurrency (all) — leave the BM currency-empty', async () => {
  const r = await client.account.withdrawCurrency()
  const c = await client.balances.currency()
  return `wallet ${fromBase(c.wallet, 6)} CRED, BM ${fromBase(c.balanceManager, 6)} — ${r.digest}`
})

console.log(failures ? `\n${failures} step(s) FAILED` : '\nFull lifecycle passed.')
process.exit(failures ? 1 : 0)

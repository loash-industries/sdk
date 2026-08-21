/**
 * Live write-path integration test against testnet + the published gateway.
 * Costs a little gas on the configured signer (BM creation + one deliberate
 * on-chain abort). Run with:
 *
 *   npm run build && node --env-file=.env scripts/integration.mjs
 *
 * Exercises: currency balances (fullnode), balance-manager creation inside a
 * real PTB, ensure() idempotency + cold resolution, own order-status reads,
 * the sweepable manifest, typed InsufficientBalance on funding paths, and the
 * TransactionFailed + Move-abort translation on a real on-chain abort.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { TriexClient, TriexClientError, TriexError } from '../dist/index.js'

const apiKey = process.env.TRIEX_API_KEY
const secret = process.env.SUI_PRIVATE_KEY
if (!apiKey || !secret) {
  console.error('TRIEX_API_KEY and SUI_PRIVATE_KEY are required (see .env)')
  process.exit(1)
}

const sui = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
})
const keypair = Ed25519Keypair.fromSecretKey(secret)
const address = keypair.toSuiAddress()
console.log(`signer: ${address}`)

const makeClient = () =>
  new TriexClient({
    suiClient: sui,
    apiKey,
    address,
    executor: (tx) =>
      sui.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        include: { effects: true, objectTypes: true },
      }),
  })
const client = makeClient()

let failures = 0
async function step(name, fn) {
  try {
    const out = await fn()
    console.log(`✅ ${name}${out !== undefined ? ` — ${out}` : ''}`)
  } catch (e) {
    failures++
    console.error(`❌ ${name} — ${e?.code ?? ''} ${e?.message ?? e}`)
  }
}
const expectCode = (code, fn) => async () => {
  try {
    await fn()
  } catch (e) {
    if (e instanceof TriexClientError && e.code === code) {
      return `threw ${code} as expected: ${e.message.slice(0, 110)}`
    }
    throw e
  }
  throw new Error(`expected ${code} but the call succeeded`)
}

// ── 1. balances + account state before anything exists ───────────────────────
let walletCred = 0n
await step('balances.currency (pre)', async () => {
  const c = await client.balances.currency()
  walletCred = c.wallet
  return `wallet=${c.wallet} bm=${c.balanceManager} bmId=${c.balanceManagerId}`
})

// ── 2. ensure(): real on-chain BM creation, then idempotency ─────────────────
let bmId
await step('account.ensure — creates the BM on-chain', async () => {
  const r = await client.account.ensure()
  bmId = r.balanceManagerId
  return `created=${r.created} id=${r.balanceManagerId}`
})
await step('account.ensure — idempotent on second call', async () => {
  const r = await client.account.ensure()
  if (r.created) throw new Error('second ensure() reported created=true')
  if (r.balanceManagerId !== bmId) throw new Error('BM id changed!')
  return `created=false id stable`
})
await step('cold client resolves the BM via listOwnedObjects', async () => {
  if (!bmId) throw new Error('skipped: ensure() did not create a BM')
  for (let i = 0; i < 10; i++) {
    const acct = await makeClient().account.get()
    if (acct?.balanceManagerId === bmId) return `resolved after ${i} retries`
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('cold resolution did not observe the new BM')
})

// ── 3. own order-status + sweepable reads (live routes, own BM) ──────────────
await step('orders.openOrders (own BM, empty)', async () => {
  const page = await client.orders.openOrders({ limit: 10 })
  return `${page.orders.length} open orders`
})
await step('account.sweepable (empty manifest)', async () => {
  const m = await client.account.sweepable()
  return `pools=${m.pools.length} items=${m.items.length} asOf=${m.asOfCheckpoint}`
})

// ── 4. funding error paths (typed, no chain writes) ──────────────────────────
if (walletCred === 0n) {
  await step(
    'depositCurrency with empty wallet throws typed InsufficientBalance',
    expectCode(TriexError.InsufficientBalance, () =>
      client.account.depositCurrency({ amount: 1_000n }),
    ),
  )
} else {
  await step(`depositCurrency ${walletCred / 2n} (wallet has CRED!)`, async () => {
    const r = await client.account.depositCurrency({ amount: walletCred / 2n })
    return `digest=${r.digest}`
  })
}

// A limit bid drives the full live pipeline: vault → resolve → metadata →
// BM balance read → wallet coin scan → typed shortfall (with an empty wallet).
await step('orders.limit buy — full pipeline to typed shortfall', async () => {
  const feed = await client.market.discover({ limit: 10 })
  const order = feed.orders.find((o) => o.hubId)
  if (!order) return 'no discoverable market — skipped'
  try {
    await client.orders.limit({
      storageUnitId: order.hubId,
      assetId: order.assetId,
      side: 'buy',
      price: 1n,
      quantity: 1n,
    })
    return 'order placed (wallet had CRED)'
  } catch (e) {
    if (
      e instanceof TriexClientError &&
      e.code === TriexError.InsufficientBalance
    ) {
      return `typed shortfall as expected: ${e.message.slice(0, 90)}`
    }
    throw e
  }
})

// ── 5. real on-chain abort → TransactionFailed + translation ─────────────────
await step(
  'withdrawCurrency on an empty BM → typed TransactionFailed (live abort)',
  expectCode(TriexError.TransactionFailed, () =>
    client.account.withdrawCurrency(),
  ),
)

console.log(failures ? `\n${failures} step(s) FAILED` : '\nAll integration steps passed.')
process.exit(failures ? 1 : 0)

/**
 * Minimal trading-bot skeleton: the full lifecycle a real bot runs —
 * account → funding-aware order placement → status polling → claiming
 * settled proceeds → withdrawal — with typed error handling throughout.
 *
 *   node --env-file=.env examples/trading-bot.mjs <hubId> <assetId> <price> <qty>
 *
 * (In your own project, import from '@trinaryex/sdk' instead of ../dist.)
 */
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import {
  TriexClient,
  TriexClientError,
  TriexError,
  fromBase,
} from '../dist/index.js'

const [hubId, assetId, priceArg, qtyArg] = process.argv.slice(2)
if (!hubId || !assetId || !priceArg || !qtyArg) {
  console.error('usage: trading-bot.mjs <hubId> <assetId> <price> <quantity>')
  process.exit(1)
}

const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
})
const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY)
const client = new TriexClient({
  suiClient,
  apiKey: process.env.TRINARY_API_KEY ?? process.env.TRIEX_API_KEY,
  address: keypair.toSuiAddress(),
  executor: (tx) =>
    suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      include: { effects: true, objectTypes: true },
    }),
})

// ── 1. Know your position ────────────────────────────────────────────────────
const cred = await client.balances.currency()
console.log(`wallet ${fromBase(cred.wallet, 6)} CRED · trading account ${fromBase(cred.balanceManager, 6)} CRED`)

// ── 2. Place a limit bid — funding, account creation, and placement are ONE
//       atomic transaction; only the deficit leaves the wallet. ──────────────
try {
  const res = await client.orders.limit({
    storageUnitId: hubId,
    assetId,
    side: 'buy',
    price: BigInt(priceArg),
    quantity: BigInt(qtyArg),
  })
  console.log(`order placed: ${res.digest}`)
} catch (e) {
  if (e instanceof TriexClientError) {
    // Stable codes → a bot (or an LLM agent) can branch without string-matching.
    if (e.code === TriexError.InsufficientBalance) {
      console.error(`not enough CRED: ${e.message}`)
      process.exit(1)
    }
    if (e.code === TriexError.TransactionFailed) {
      // On-chain abort, already translated: "Max 100 open orders reached", …
      console.error(`on-chain failure: ${e.message}`)
      process.exit(1)
    }
  }
  throw e
}

// ── 3. Watch the order (the indexer trails the chain by a few seconds). ─────
await new Promise((r) => setTimeout(r, 5000))
const { orders } = await client.orders.openOrders({ limit: 10 })
for (const o of orders) {
  console.log(`open: ${o.side} ${o.remainingQuantity}/${o.remainingQuantity + o.filledQuantity} @ ${o.price} (order ${o.orderId})`)
}

// ── 4. Claim settled proceeds from any fills, then sweep home. ──────────────
const sweepable = await client.account.sweepable()
if (sweepable.pools.length > 0) {
  const res = await client.account.claimSettled()
  console.log(`claimed settled proceeds: ${res.digest}`)
}

// Cancel everything on this market and pull CRED back to the wallet:
//   await client.orders.cancelAll({ storageUnitId: hubId, assetId })
//   await client.account.withdrawCurrency()
console.log('done')

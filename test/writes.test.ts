/**
 * Write-flow composition tests: build each PTB against a fake fullnode +
 * capturing executor and assert the exact Move-call sequence (and, where it
 * matters, the exact pure u64 inputs) matches the production app's flows in
 * useTriexbookMulticoinOrders.ts.
 */
import { jest } from '@jest/globals'
import { bcs } from '@mysten/sui/bcs'
import { fromBase64 } from '@mysten/sui/utils'
import type { Transaction } from '@mysten/sui/transactions'

import { TriexClient } from '../src/TriexClient'
import {
  FeeScheduleBcs,
  MultiCoinBalanceBcs,
  toSsuObjectId,
} from '../src/onchain'
import { TriexError, explainMoveAbort } from '../src/errors'
import {
  GTC_EXPIRE,
  estimateMarketBuyCost,
  marketBuyRoundingBuffer,
} from '../src/money'
import { STILLNESS_PACKAGE_IDS } from '../src/config'

const HEX = '0x7f3a9b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8'
const OWNER = '0x' + 'ab'.repeat(32)
const BM_ID = '0x' + 'b1'.repeat(32)
const CHAR_ID = '0x' + 'c1'.repeat(32)
const CHAR_CAP = '0x' + 'c2'.repeat(32)
const IDS = STILLNESS_PACKAGE_IDS
const POOL = '0x' + '10'.repeat(32)
/** The Clock (`0x6`) as the builder normalizes it. */
const CLOCK = '0x' + '6'.padStart(64, '0')

// ─── fakes ───────────────────────────────────────────────────────────────────

/** Route indexer fetches by URL substring. */
function routeFetch(routes: Array<[string, unknown]>): void {
  ;(global as any).fetch = jest.fn(async (url: unknown) => {
    const s = String(url)
    const hit = routes.find(([pattern]) => s.includes(pattern))
    if (!hit) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({}),
      }
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => hit[1] }
  })
}

type CoreImpl = Partial<{
  listCoins: (args: any) => any
  listOwnedObjects: (args: any) => any
  getObject: (args: any) => any
  getDynamicField: (args: any) => any
  getDynamicObjectField: (args: any) => any
  simulateTransaction: (args: any) => any
}>

function fakeSuiClient(impl: CoreImpl): any {
  const wrap = (name: string, fn?: (args: any) => any) => async (args: any) => {
    if (!fn) throw new Error(`fake core.${name} not stubbed for this test`)
    return fn(args)
  }
  return {
    core: {
      listCoins: wrap('listCoins', impl.listCoins),
      listOwnedObjects: wrap('listOwnedObjects', impl.listOwnedObjects),
      getObject: wrap('getObject', impl.getObject),
      getDynamicField: wrap('getDynamicField', impl.getDynamicField),
      getDynamicObjectField: wrap(
        'getDynamicObjectField',
        impl.getDynamicObjectField,
      ),
      simulateTransaction: wrap(
        'simulateTransaction',
        impl.simulateTransaction,
      ),
    },
  }
}

/** Genesis multicoin ladder (fee_policy.move): 2.20% taker / 1.80% maker at tier 0. */
const GENESIS_LADDER: Array<[bigint, bigint, bigint]> = [
  [0n, 22_000_000n, 18_000_000n],
  [20_000_000_000n, 20_900_000n, 17_100_000n],
]

const scheduleBytes = (tiers: Array<[bigint, bigint, bigint]>) =>
  FeeScheduleBcs.serialize({
    tiers: tiers.map(([min_turnover, taker_fee, maker_fee]) => ({
      min_turnover,
      taker_fee,
      maker_fee,
    })),
  }).toBytes()

const u64 = (n: bigint) => bcs.u64().serialize(n).toBytes()

/**
 * A `simulateTransaction` result for `getPoolTradingFees`' view calls:
 * pool_fee_class, pool_fee_schedule, pool_fee_schedule_next,
 * cancel_retention_bps [, trade_params_for_account, account_fee_tier,
 * account_fee_turnover].
 */
function feeSimulation(opts?: {
  schedule?: Array<[bigint, bigint, bigint]>
  next?: Array<[bigint, bigint, bigint]>
  nextEpoch?: bigint
  account?: { taker: bigint; maker: bigint; tier: bigint; turnover: bigint }
}) {
  const schedule = opts?.schedule ?? GENESIS_LADDER
  const results = [
    { returnValues: [{ bcs: bcs.u16().serialize(7).toBytes() }] },
    { returnValues: [{ bcs: scheduleBytes(schedule) }] },
    {
      returnValues: [
        { bcs: scheduleBytes(opts?.next ?? schedule) },
        { bcs: u64(opts?.nextEpoch ?? 900n) },
      ],
    },
    { returnValues: [{ bcs: u64(2_000n) }] },
  ]
  if (opts?.account) {
    results.push(
      {
        returnValues: [
          { bcs: u64(opts.account.taker) },
          { bcs: u64(opts.account.maker) },
        ],
      },
      { returnValues: [{ bcs: u64(opts.account.tier) }] },
      {
        returnValues: [
          { bcs: bcs.u128().serialize(opts.account.turnover).toBytes() },
        ],
      },
    )
  }
  return {
    $kind: 'Transaction',
    Transaction: { digest: 'sim', epoch: '901' },
    commandResults: results,
  }
}

/** Executor that records the tx and reports a created BM object. */
function captureExecutor(opts?: { createBm?: boolean }) {
  const captured: { tx?: Transaction } = {}
  const executor = jest.fn(async (tx: Transaction) => {
    captured.tx = tx
    return {
      digest: '0xd1gest',
      objectChanges: opts?.createBm
        ? [
            {
              type: 'created',
              objectId: BM_ID,
              objectType: `${IDS.triex}::trading_account::TradingAccount`,
            },
          ]
        : [],
    }
  })
  return { executor, captured }
}

/** Compact command list: 'module::function' for MoveCalls, '$kind' otherwise. */
function commandNames(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.map((c: any) =>
      c.$kind === 'MoveCall'
        ? `${c.MoveCall.module}::${c.MoveCall.function}`
        : c.$kind,
    )
}

/** All pure inputs decodable as u64, as bigints. */
function pureU64s(tx: Transaction): bigint[] {
  const out: bigint[] = []
  for (const input of tx.getData().inputs as any[]) {
    const b64 = input?.Pure?.bytes
    if (!b64) continue
    const bytes = fromBase64(b64)
    if (bytes.length !== 8) continue
    out.push(BigInt(bcs.u64().parse(bytes)))
  }
  return out
}

/** All pure inputs decodable as u128 (16 bytes), as bigints. */
function pureU128s(tx: Transaction): bigint[] {
  const out: bigint[] = []
  for (const input of tx.getData().inputs as any[]) {
    const b64 = input?.Pure?.bytes
    if (!b64) continue
    const bytes = fromBase64(b64)
    if (bytes.length !== 16) continue
    out.push(BigInt(bcs.u128().parse(bytes)))
  }
  return out
}

/**
 * The arguments of the (first) MoveCall to `module::function`, described as
 * the object id they reference, `pure:<n bytes>`, or `result`. Enough to pin
 * each call's argument order against the Move signature.
 */
function moveCallArgs(tx: Transaction, target: string): string[] {
  const data = tx.getData()
  const call = data.commands.find(
    (c: any) =>
      c.$kind === 'MoveCall' &&
      `${c.MoveCall.module}::${c.MoveCall.function}` === target,
  ) as any
  if (!call) throw new Error(`no MoveCall ${target}`)
  return call.MoveCall.arguments.map((arg: any) => {
    if (arg.$kind !== 'Input') return 'result'
    const input = (data.inputs as any[])[arg.Input]
    if (input?.Pure) return `pure:${fromBase64(input.Pure.bytes).length}`
    const obj =
      input?.UnresolvedObject?.objectId ??
      input?.Object?.SharedObject?.objectId ??
      input?.Object?.ImmOrOwnedObject?.objectId
    return obj ?? 'unknown'
  })
}

const bmWithNoBag = { object: { json: {} } } // BM CRED balance reads → 0n

function coinPage(balances: bigint[]) {
  return {
    objects: balances.map((b, i) => ({
      objectId: '0x' + String(i + 1).padStart(64, '0'),
      balance: b.toString(),
    })),
    hasNextPage: false,
    cursor: null,
  }
}

const bmPage = (id: string | null) => ({
  objects: id ? [{ objectId: id }] : [],
})

function client(suiClient: any, executor: any) {
  return new TriexClient({
    suiClient,
    apiKey: 'k',
    indexerUrl: 'https://api.example.test',
    address: OWNER,
    executor,
  })
}

afterEach(() => jest.restoreAllMocks())

// ─── account.depositCurrency ─────────────────────────────────────────────────

describe('account.depositCurrency', () => {
  it('merges + splits wallet coins and deposits into an existing BM', async () => {
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      listCoins: () => coinPage([30n, 80n]),
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).account.depositCurrency({ amount: 100n })

    expect(commandNames(captured.tx!)).toEqual([
      'MergeCoins',
      'SplitCoins',
      'trading_account::deposit',
    ])
    expect(pureU64s(captured.tx!)).toContainEqual(100n)
  })

  it('creates the BM inside the same PTB when none exists, then transfers it', async () => {
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(null),
      listCoins: () => coinPage([500n]),
    })
    const { executor, captured } = captureExecutor({ createBm: true })
    const c = client(sui, executor)
    await c.account.depositCurrency({ amount: 100n })

    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::new',
      'SplitCoins',
      'trading_account::deposit',
      'TransferObjects',
    ])
    // The created BM id was captured from objectChanges (read-your-writes).
    expect(await c.account.get()).toEqual({
      tradingAccountId: BM_ID,
      owner: OWNER,
    })
  })

  it('throws typed InsufficientBalance without executing when the wallet is short', async () => {
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      listCoins: () => coinPage([30n]),
    })
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).account.depositCurrency({ amount: 100n }),
    ).rejects.toMatchObject({ code: TriexError.InsufficientBalance })
    expect(executor).not.toHaveBeenCalled()
  })
})

// ─── account.withdrawCurrency ────────────────────────────────────────────────

describe('account.withdrawCurrency', () => {
  it('withdraws a partial amount via trading_account::withdraw', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).account.withdrawCurrency({ amount: 42n })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::withdraw',
      'TransferObjects',
    ])
    expect(pureU64s(captured.tx!)).toContainEqual(42n)
  })

  it('looks the account up by the cycle-7 TradingAccount type', async () => {
    const listOwnedObjects = jest.fn((_args: any) => bmPage(BM_ID))
    const sui = fakeSuiClient({ listOwnedObjects })
    const { executor } = captureExecutor()
    await client(sui, executor).account.withdrawCurrency({ amount: 1n })
    expect(listOwnedObjects.mock.calls[0][0]).toMatchObject({
      owner: OWNER,
      type: `${IDS.triex}::trading_account::TradingAccount`,
    })
  })

  it('withdraws everything via withdraw_all when no amount is given', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).account.withdrawCurrency()
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::withdraw_all',
      'TransferObjects',
    ])
  })

  it('fails typed when no trading account exists', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(null) })
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).account.withdrawCurrency(),
    ).rejects.toMatchObject({ code: TriexError.TradingAccountNotFound })
  })
})

// ─── orders.limit (bid) ──────────────────────────────────────────────────────

const VAULT_ROUTE: [string, unknown] = [
  '/vault',
  { hub_id: HEX, collection_id: HEX, vault_config_id: HEX },
]
const RESOLVE_ROUTE: [string, unknown] = [
  '/v1/pools/resolve',
  { pool_id: POOL },
]
const META_ROUTE: [string, unknown] = [
  '/metadata',
  {
    pool_id: POOL,
    pool_name: 'x',
    base_asset_symbol: 'X',
    base_asset_name: null,
    base_asset_decimals: 0,
    quote_asset_symbol: 'CRED',
    quote_asset_name: null,
    quote_asset_decimals: 6,
    storage_unit_id: HEX,
    asset_id: '70810',
    collection_id: HEX,
    fee: '20000000', // 2%
    fee_rate: 0.02,
  },
]

describe('orders.limit (bid)', () => {
  it('composes deposit-deficit → proof → place with fee-inclusive amount and GTC default', async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE])
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      getObject: () => bmWithNoBag, // BM CRED balance → 0
      listCoins: () => coinPage([1_000_000n]),
      simulateTransaction: () => feeSimulation(),
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).orders.limit({
      storageUnitId: HEX,
      assetId: '70810',
      side: 'buy',
      price: 100n,
      quantity: 3n,
    })

    expect(commandNames(captured.tx!)).toEqual([
      'SplitCoins',
      'trading_account::deposit',
      'trading_account::generate_proof_as_owner',
      'multicoin_pool::place_limit_order',
    ])
    const u64s = pureU64s(captured.tx!)
    // 300 notional + floor(300 × 2.2%) — the entry taker rate, which exceeds
    // the 1.8% maker escrow, so any match/rest split is covered.
    expect(u64s).toContainEqual(306n)
    expect(u64s).toContainEqual(GTC_EXPIRE) // default expiry
    expect(u64s).toContainEqual(100n) // price
    // place_limit_order(pool, policy, account, proof, order_type, smo, price,
    //   quantity, is_bid, expire_timestamp, clock)
    expect(
      moveCallArgs(captured.tx!, 'multicoin_pool::place_limit_order'),
    ).toEqual([
      POOL,
      IDS.triexFeePolicy,
      BM_ID,
      'result',
      'pure:1',
      'pure:1',
      'pure:8',
      'pure:8',
      'pure:1',
      'pure:8',
      CLOCK,
    ])
  })

  it('funds at the highest rate any account can be charged, across the staged ladder', async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE])
    let simulated: any
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      getObject: () => bmWithNoBag,
      listCoins: () => coinPage([1_000_000n]),
      simulateTransaction: (args: any) => {
        simulated = args
        // A ladder staged for next epoch whose maker rate (5%) tops every
        // current rate: the bid must still be funded if it lands then.
        return feeSimulation({ next: [[0n, 30_000_000n, 50_000_000n]] })
      },
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).orders.limit({
      storageUnitId: HEX,
      assetId: '70810',
      side: 'buy',
      price: 1_000n,
      quantity: 10n,
    })
    expect(pureU64s(captured.tx!)).toContainEqual(10_500n) // 10_000 + 5%
    expect(simulated.include).toEqual({ commandResults: true, effects: true })
    expect(simulated.transaction.getData().sender).toBe(OWNER)
  })

  it('honours an explicit quoteDeposit without reading fees', async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE])
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      getObject: () => bmWithNoBag,
      listCoins: () => coinPage([1_000_000n]),
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).orders.limit({
      storageUnitId: HEX,
      assetId: '70810',
      side: 'buy',
      price: 100n,
      quantity: 3n,
      quoteDeposit: 400n,
    })
    expect(pureU64s(captured.tx!)).toContainEqual(400n)
  })

  it('skips the deposit entirely when the BM already holds enough quote', async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE])
    const credBag = '0x' + 'ba'.repeat(32)
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      getObject: () => ({ object: { json: { balances: { id: credBag } } } }),
      getDynamicField: () => ({
        dynamicField: { value: { bcs: bcs.u64().serialize(1_000n).toBytes() } },
      }),
      simulateTransaction: () => feeSimulation(),
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).orders.limit({
      storageUnitId: HEX,
      assetId: '70810',
      side: 'buy',
      price: 100n,
      quantity: 3n, // needs 306, BM holds 1000
    })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::generate_proof_as_owner',
      'multicoin_pool::place_limit_order',
    ])
  })
})

// ─── orders.limit (sell) ─────────────────────────────────────────────────────

function receiptContent(amount: bigint, collection = HEX, assetId = 70810n) {
  return MultiCoinBalanceBcs.serialize({
    id: '0x' + 'ee'.repeat(32),
    collection,
    asset_id: assetId,
    amount,
  }).toBytes()
}

describe('orders.limit (sell)', () => {
  it('funds the deficit from wallet receipts (largest first), then proof + place', async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE, META_ROUTE])
    const sui = fakeSuiClient({
      listOwnedObjects: (args: any) =>
        String(args?.type ?? '').includes('multicoin::Balance')
          ? {
              objects: [
                {
                  objectId: '0x' + '01'.repeat(32),
                  content: receiptContent(2n),
                },
                {
                  objectId: '0x' + '02'.repeat(32),
                  content: receiptContent(9n),
                },
              ],
              hasNextPage: false,
            }
          : bmPage(BM_ID),
      // BM item balance lookup (deficit mode) → no key
      getDynamicObjectField: () => null,
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).orders.limit({
      storageUnitId: HEX,
      assetId: '70810',
      side: 'sell',
      price: 100n,
      quantity: 5n,
    })
    // 9-receipt alone covers the deficit of 5 → exactly one deposit_multicoin.
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::deposit_multicoin',
      'trading_account::generate_proof_as_owner',
      'multicoin_pool::place_limit_order',
    ])
  })

  it('skips funding when the BM already holds the quantity', async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE, META_ROUTE])
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      getDynamicObjectField: () => ({
        object: { content: receiptContent(10n) },
      }),
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).orders.limit({
      storageUnitId: HEX,
      assetId: '70810',
      side: 'sell',
      price: 100n,
      quantity: 5n,
    })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::generate_proof_as_owner',
      'multicoin_pool::place_limit_order',
    ])
  })

  it('rejects with CollectionMismatch when receipts live in a foreign collection', async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE, META_ROUTE])
    const foreign = '0x' + 'ff'.repeat(32)
    const sui = fakeSuiClient({
      listOwnedObjects: (args: any) =>
        String(args?.type ?? '').includes('multicoin::Balance')
          ? {
              objects: [
                {
                  objectId: '0x' + '01'.repeat(32),
                  content: receiptContent(50n, foreign),
                },
              ],
              hasNextPage: false,
            }
          : String(args?.type ?? '').includes('PlayerProfile')
            ? { objects: [] } // no character either
            : bmPage(BM_ID),
      getDynamicObjectField: () => null,
      getObject: () => ({ object: { json: {} } }), // SSU has no owner_cap_id
    })
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).orders.limit({
        storageUnitId: HEX,
        assetId: '70810',
        side: 'sell',
        price: 100n,
        quantity: 5n,
      }),
    ).rejects.toMatchObject({ code: TriexError.CollectionMismatch })
    expect(executor).not.toHaveBeenCalled()
  })
})

// ─── orders.market ───────────────────────────────────────────────────────────

describe('orders.market', () => {
  it('rejects market buys without a quoteBudget', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).orders.market({
        storageUnitId: HEX,
        assetId: '70810',
        side: 'buy',
        quantity: 5n,
      }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })

  it('deposits exactly the budget (the fee floors once, on the aggregate) and places the market order', async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE])
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      getObject: () => bmWithNoBag,
      listCoins: () => coinPage([10_000n]),
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).orders.market({
      storageUnitId: HEX,
      assetId: '70810',
      side: 'buy',
      quantity: 100n,
      quoteBudget: 1_000n,
    })
    expect(commandNames(captured.tx!)).toEqual([
      'SplitCoins',
      'trading_account::deposit',
      'trading_account::generate_proof_as_owner',
      'multicoin_pool::place_market_order',
    ])
    // The split covers the budget with no buffer; then the quantity.
    expect(pureU64s(captured.tx!)).toEqual([1_000n, 100n])
    // place_market_order(pool, policy, account, proof, smo, quantity, is_bid, clock)
    expect(
      moveCallArgs(captured.tx!, 'multicoin_pool::place_market_order'),
    ).toEqual([
      POOL,
      IDS.triexFeePolicy,
      BM_ID,
      'result',
      'pure:1',
      'pure:8',
      'pure:1',
      CLOCK,
    ])
  })
})

// ─── orders.cancel / cancelAll / modify ──────────────────────────────────────

describe('orders.cancel family', () => {
  const routes: Array<[string, unknown]> = [VAULT_ROUTE, RESOLVE_ROUTE]

  it('cancel composes proof + cancel_order with the FeePolicy and a u128 order id', async () => {
    routeFetch(routes)
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).orders.cancel({
      storageUnitId: HEX,
      assetId: '70810',
      orderId: '42',
    })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::generate_proof_as_owner',
      'multicoin_pool::cancel_order',
    ])
    expect(pureU128s(captured.tx!)).toEqual([42n])
    expect(pureU64s(captured.tx!)).toEqual([])
    // cancel_order(pool, policy, account, proof, order_id: u128, clock)
    expect(moveCallArgs(captured.tx!, 'multicoin_pool::cancel_order')).toEqual([
      POOL,
      IDS.triexFeePolicy,
      BM_ID,
      'result',
      'pure:16',
      CLOCK,
    ])
  })

  it('cancel encodes order ids above 2^64 without truncation', async () => {
    routeFetch(routes)
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    // A real cycle-7 id: is_bid bit | price << 64 | sequence.
    const orderId = (1n << 127n) | (1_000n << 64n) | 7n
    await client(sui, executor).orders.cancel({
      storageUnitId: HEX,
      assetId: '70810',
      orderId: orderId.toString(),
    })
    expect(pureU128s(captured.tx!)).toEqual([orderId])
  })

  it('rejects order ids that are not u128 integers before building', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    routeFetch(routes)
    const { executor } = captureExecutor()
    for (const orderId of ['abc', '', '-1', (1n << 128n).toString()]) {
      await expect(
        client(sui, executor).orders.cancel({
          storageUnitId: HEX,
          assetId: '70810',
          orderId,
        }),
      ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    }
    expect(executor).not.toHaveBeenCalled()
  })

  it('cancelAll composes proof + cancel_all_orders', async () => {
    routeFetch(routes)
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).orders.cancelAll({
      storageUnitId: HEX,
      assetId: '70810',
    })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::generate_proof_as_owner',
      'multicoin_pool::cancel_all_orders',
    ])
    // cancel_all_orders(pool, policy, account, proof, clock)
    expect(
      moveCallArgs(captured.tx!, 'multicoin_pool::cancel_all_orders'),
    ).toEqual([POOL, IDS.triexFeePolicy, BM_ID, 'result', CLOCK])
  })

  it('modify composes proof + modify_order with id and new quantity', async () => {
    routeFetch(routes)
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).orders.modify({
      storageUnitId: HEX,
      assetId: '70810',
      orderId: 42n,
      newQuantity: 3n,
    })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::generate_proof_as_owner',
      'multicoin_pool::modify_order',
    ])
    expect(pureU128s(captured.tx!)).toEqual([42n])
    expect(pureU64s(captured.tx!)).toEqual([3n])
    // modify_order(pool, policy, account, proof, order_id: u128, new_quantity, clock)
    expect(moveCallArgs(captured.tx!, 'multicoin_pool::modify_order')).toEqual([
      POOL,
      IDS.triexFeePolicy,
      BM_ID,
      'result',
      'pure:16',
      'pure:8',
      CLOCK,
    ])
  })

  it('cancel without a trading account fails typed', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(null) })
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).orders.cancel({
        storageUnitId: HEX,
        assetId: '70810',
        orderId: 1n,
      }),
    ).rejects.toMatchObject({ code: TriexError.TradingAccountNotFound })
  })
})

// ─── account.claimSettled ────────────────────────────────────────────────────

describe('account.claimSettled', () => {
  it('claims only pools with settled balances from the sweepable manifest', async () => {
    routeFetch([
      [
        '/sweepable',
        {
          trading_account_id: BM_ID,
          as_of_checkpoint: '123',
          pools: [
            {
              pool_id: POOL,
              collection_id: HEX,
              asset_id: '1',
              quote_asset_id: IDS.credCoinType,
              storage_unit_id: HEX,
              vault_config_id: HEX,
              settled: { base: '5', quote: '0', cred: '0' },
              owed: { base: '0', quote: '0', cred: '0' },
              open_order_count: 1,
            },
            {
              pool_id: '0x' + '20'.repeat(32),
              collection_id: HEX,
              asset_id: '2',
              quote_asset_id: null,
              storage_unit_id: HEX,
              vault_config_id: HEX,
              settled: { base: '0', quote: '0', cred: '0' },
              owed: { base: '0', quote: '0', cred: '0' },
              open_order_count: 0,
            },
          ],
          items: [],
        },
      ],
    ])
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).account.claimSettled()
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::generate_proof_as_owner',
      'multicoin_pool::withdraw_settled_amounts',
    ])
    // withdraw_settled_amounts(pool, account, proof) — no FeePolicy
    expect(
      moveCallArgs(captured.tx!, 'multicoin_pool::withdraw_settled_amounts'),
    ).toEqual([POOL, BM_ID, 'result'])
  })

  it('fails typed when nothing is settled', async () => {
    routeFetch([
      [
        '/sweepable',
        {
          trading_account_id: BM_ID,
          as_of_checkpoint: null,
          pools: [],
          items: [],
        },
      ],
    ])
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).account.claimSettled(),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })
})

// ─── account.withdrawItems ───────────────────────────────────────────────────

describe('account.withdrawItems', () => {
  it('withdraws each asset in full and redeems into the hangar', async () => {
    routeFetch([VAULT_ROUTE])
    const sui = fakeSuiClient({
      listOwnedObjects: (args: any) =>
        String(args?.type ?? '').includes('PlayerProfile')
          ? { objects: [{ json: { character_id: CHAR_ID } }] }
          : bmPage(BM_ID),
      getObject: (args: any) => {
        if (args.objectId === CHAR_ID) {
          return {
            object: {
              json: { owner_cap_id: CHAR_CAP, character_address: OWNER },
            },
          }
        }
        // SSU object: no owner cap resolvable → not the hub owner
        return { object: { json: {} } }
      },
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).account.withdrawItems({
      storageUnitId: HEX,
      items: [{ assetId: '70810' }, { assetId: '92422' }],
    })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::withdraw_all_multicoin',
      'receipt::redeem_receipt',
      'trading_account::withdraw_all_multicoin',
      'receipt::redeem_receipt',
    ])
  })
})

describe('account.withdrawItems (partial)', () => {
  const sui = () =>
    fakeSuiClient({
      listOwnedObjects: (args: any) =>
        String(args?.type ?? '').includes('PlayerProfile')
          ? { objects: [{ json: { character_id: CHAR_ID } }] }
          : bmPage(BM_ID),
      getObject: (args: any) =>
        args.objectId === CHAR_ID
          ? {
              object: {
                json: { owner_cap_id: CHAR_CAP, character_address: OWNER },
              },
            }
          : { object: { json: {} } },
    })

  it('withdraws `amount` via withdraw_multicoin, the rest in full', async () => {
    routeFetch([VAULT_ROUTE])
    const { executor, captured } = captureExecutor()
    await client(sui(), executor).account.withdrawItems({
      storageUnitId: HEX,
      items: [{ assetId: '70810', amount: 4n }, { assetId: '92422' }],
    })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::withdraw_multicoin',
      'receipt::redeem_receipt',
      'trading_account::withdraw_all_multicoin',
      'receipt::redeem_receipt',
    ])
    // withdraw_multicoin(bm, collection_id: ID, asset_id, amount)
    expect(
      moveCallArgs(captured.tx!, 'trading_account::withdraw_multicoin'),
    ).toEqual([BM_ID, 'pure:32', 'pure:8', 'pure:8'])
    expect(pureU64s(captured.tx!)).toEqual([70810n, 4n, 92422n])
  })

  it('rejects a non-positive amount before building', async () => {
    const { executor } = captureExecutor()
    await expect(
      client(sui(), executor).account.withdrawItems({
        storageUnitId: HEX,
        items: [{ assetId: '70810', amount: 0n }],
      }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    expect(executor).not.toHaveBeenCalled()
  })
})

// ─── account capabilities & registry ─────────────────────────────────────────

describe('account caps', () => {
  const CAP = '0x' + 'ca'.repeat(32)
  const BOT = '0x' + 'b0'.repeat(32)

  it('mintCap mints the requested kind, transfers it, and reports its id', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const captured: { tx?: Transaction } = {}
    const executor = jest.fn(async (tx: Transaction) => {
      captured.tx = tx
      return {
        digest: '0xd',
        objectChanges: [
          {
            type: 'created',
            objectId: CAP,
            objectType: `${IDS.triex}::trading_account::DepositCap`,
          },
        ],
      }
    })
    const res = await client(sui, executor).account.mintCap({
      kind: 'deposit',
      recipient: BOT,
    })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::mint_deposit_cap',
      'TransferObjects',
    ])
    expect(
      moveCallArgs(captured.tx!, 'trading_account::mint_deposit_cap'),
    ).toEqual([BM_ID])
    expect(res.capId).toBe(CAP)
  })

  it('mintCap rejects an unknown kind', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).account.mintCap({ kind: 'admin' as any }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })

  it('revokeCap passes the cap id as a pure ID', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).account.revokeCap({ capId: CAP })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::revoke_trade_cap',
    ])
    expect(
      moveCallArgs(captured.tx!, 'trading_account::revoke_trade_cap'),
    ).toEqual([BM_ID, 'pure:32'])
  })

  it('caps reads the allow-list and the caps the address holds', async () => {
    const capContent = (ta: string) =>
      bcs
        .struct('Cap', { id: bcs.Address, trading_account_id: bcs.Address })
        .serialize({ id: CAP, trading_account_id: ta })
        .toBytes()
    const sui = fakeSuiClient({
      listOwnedObjects: (args: any) => {
        const type = String(args?.type ?? '')
        if (type.endsWith('::trading_account::TradeCap')) {
          return {
            objects: [{ objectId: CAP, content: capContent(BM_ID) }],
            hasNextPage: false,
          }
        }
        if (type.endsWith('Cap')) return { objects: [], hasNextPage: false }
        return bmPage(BM_ID)
      },
      getObject: () => ({
        object: { json: { allow_listed: { contents: [CAP] } } },
      }),
    })
    expect(await client(sui, jest.fn()).account.caps()).toEqual({
      tradingAccountId: BM_ID,
      allowListed: [CAP],
      held: [{ objectId: CAP, kind: 'trade', tradingAccountId: BM_ID }],
    })
  })

  it('register files the account in the registry', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).account.register()
    expect(
      moveCallArgs(captured.tx!, 'trading_account::register_trading_account'),
    ).toEqual([BM_ID, IDS.triexRegistry])
  })
})

// ─── orders.fees / orders.cancelMany ─────────────────────────────────────────

describe('orders.fees', () => {
  it("resolves the pool, then reads the ladder and the account's own tier", async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE])
    let simulated: any
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      simulateTransaction: (args: any) => {
        simulated = args
        return feeSimulation({
          account: {
            taker: 20_900_000n,
            maker: 17_100_000n,
            tier: 1n,
            turnover: 25_000_000_000n,
          },
        })
      },
    })
    const fees = await client(sui, jest.fn()).orders.fees({
      storageUnitId: HEX,
      assetId: '70810',
    })
    expect(commandNames(simulated.transaction)).toEqual([
      'multicoin_pool::pool_fee_class',
      'multicoin_pool::pool_fee_schedule',
      'multicoin_pool::pool_fee_schedule_next',
      'fee_policy::cancel_retention_bps',
      'multicoin_pool::trade_params_for_account',
      'multicoin_pool::account_fee_tier',
      'multicoin_pool::account_fee_turnover',
    ])
    expect(
      moveCallArgs(
        simulated.transaction,
        'multicoin_pool::trade_params_for_account',
      ),
    ).toEqual([POOL, IDS.triexFeePolicy, BM_ID])
    expect(fees).toMatchObject({
      poolId: POOL,
      feeClass: 7,
      epoch: 901n,
      entryTakerFeeRate: 22_000_000n,
      entryMakerFeeRate: 18_000_000n,
      nextScheduleEpoch: 900n,
      cancelRetentionBps: 2_000n,
      bidEscrowFeeRate: 22_000_000n,
      account: {
        tradingAccountId: BM_ID,
        tier: 1,
        turnover: 25_000_000_000n,
        takerFeeRate: 20_900_000n,
        makerFeeRate: 17_100_000n,
      },
    })
    expect(fees.schedule).toHaveLength(2)
  })

  it('reads only the pool ladder when no address is configured', async () => {
    let simulated: any
    const sui = fakeSuiClient({
      simulateTransaction: (args: any) => {
        simulated = args
        return feeSimulation()
      },
    })
    const ro = new TriexClient({
      suiClient: sui,
      apiKey: 'k',
      indexerUrl: 'https://api.example.test',
    })
    const fees = await ro.orders.fees({ poolId: POOL })
    expect(fees.account).toBeNull()
    expect(commandNames(simulated.transaction)).toHaveLength(4)
  })

  it('surfaces a failed simulation as TransactionFailed', async () => {
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(null),
      simulateTransaction: () => ({
        $kind: 'FailedTransaction',
        FailedTransaction: { status: { error: 'MoveAbort' } },
      }),
    })
    await expect(
      client(sui, jest.fn()).orders.fees({ poolId: POOL }),
    ).rejects.toMatchObject({ code: TriexError.TransactionFailed })
  })

  it('reports UnexpectedResponse when the client returns no command results', async () => {
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(null),
      simulateTransaction: () => ({
        $kind: 'Transaction',
        Transaction: { epoch: null },
      }),
    })
    await expect(
      client(sui, jest.fn()).orders.fees({ poolId: POOL }),
    ).rejects.toMatchObject({ code: TriexError.UnexpectedResponse })
  })
})

describe('orders.cancelMany', () => {
  it('composes proof + cancel_orders with a vector<u128> of ids', async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE])
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    const big = (1n << 127n) | 9n
    await client(sui, executor).orders.cancelMany({
      storageUnitId: HEX,
      assetId: '70810',
      orderIds: ['42', big],
    })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::generate_proof_as_owner',
      'multicoin_pool::cancel_orders',
    ])
    // cancel_orders(pool, policy, account, proof, order_ids, clock)
    expect(moveCallArgs(captured.tx!, 'multicoin_pool::cancel_orders')).toEqual(
      [POOL, IDS.triexFeePolicy, BM_ID, 'result', 'pure:33', CLOCK],
    )
    const vec = (captured.tx!.getData().inputs as any[]).find(
      (i) => i?.Pure && fromBase64(i.Pure.bytes).length === 33,
    )
    expect(
      bcs.vector(bcs.u128()).parse(fromBase64(vec.Pure.bytes)).map(BigInt),
    ).toEqual([42n, big])
  })

  it('rejects an empty or invalid id list before building', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE])
    const { executor } = captureExecutor()
    for (const orderIds of [[], ['nope']]) {
      await expect(
        client(sui, executor).orders.cancelMany({
          storageUnitId: HEX,
          assetId: '70810',
          orderIds,
        }),
      ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    }
    expect(executor).not.toHaveBeenCalled()
  })
})

// ─── market.createPool / market.claimOperatorShare ───────────────────────────

describe('market.createPool', () => {
  it('pays the 500 CRED fee from the wallet and reports the new pool id', async () => {
    routeFetch([VAULT_ROUTE])
    const sui = fakeSuiClient({ listCoins: () => coinPage([600_000_000n]) })
    const captured: { tx?: Transaction } = {}
    const executor = jest.fn(async (tx: Transaction) => {
      captured.tx = tx
      return {
        digest: '0xd',
        objectChanges: [
          {
            type: 'created',
            objectId: POOL,
            objectType: `${IDS.triex}::multicoin_pool::MultiCoinPool<${IDS.credCoinType}>`,
          },
        ],
      }
    })
    const res = await client(sui, executor).market.createPool({
      storageUnitId: HEX,
      assetId: '70810',
    })
    expect(commandNames(captured.tx!)).toEqual([
      'SplitCoins',
      'multicoin_pool::create_permissionless_pool',
    ])
    // create_permissionless_pool(registry, policy, collection, asset_id, fee)
    expect(
      moveCallArgs(captured.tx!, 'multicoin_pool::create_permissionless_pool'),
    ).toEqual([IDS.triexRegistry, IDS.triexFeePolicy, HEX, 'pure:8', 'result'])
    expect(pureU64s(captured.tx!)).toEqual([500_000_000n, 70810n])
    expect(res.poolId).toBe(POOL)
  })

  it('fails typed when the wallet cannot cover the fee', async () => {
    routeFetch([VAULT_ROUTE])
    const sui = fakeSuiClient({ listCoins: () => coinPage([1n]) })
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).market.createPool({
        storageUnitId: HEX,
        assetId: '70810',
      }),
    ).rejects.toMatchObject({ code: TriexError.InsufficientBalance })
  })
})

describe('market.claimOperatorShare', () => {
  it('batches one claim per pool', async () => {
    const other = '0x' + '20'.repeat(32)
    const { executor, captured } = captureExecutor()
    await client(fakeSuiClient({}), executor).market.claimOperatorShare({
      poolIds: [POOL, other],
    })
    expect(commandNames(captured.tx!)).toEqual([
      'multicoin_pool::claim_operator_share',
      'multicoin_pool::claim_operator_share',
    ])
    // claim_operator_share(pool, policy, registry, clock)
    expect(
      moveCallArgs(captured.tx!, 'multicoin_pool::claim_operator_share'),
    ).toEqual([POOL, IDS.triexFeePolicy, IDS.triexRegistry, CLOCK])
  })

  it('rejects an empty pool list', async () => {
    const { executor } = captureExecutor()
    await expect(
      client(fakeSuiClient({}), executor).market.claimOperatorShare({
        poolIds: [],
      }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })
})

// ─── helpers ─────────────────────────────────────────────────────────────────

describe('toSsuObjectId', () => {
  it('converts decimal game ids and normalizes hex object ids', () => {
    expect(toSsuObjectId('255')).toBe('0x' + 'ff'.padStart(64, '0'))
    expect(toSsuObjectId(HEX)).toBe(HEX)
  })
})

describe('estimateMarketBuyCost', () => {
  const asks = [
    { price: 10n, remainingQuantity: 3n },
    { price: 12n, remainingQuantity: 5n },
  ]
  it('walks the book lowest-first and adds the floored fee', () => {
    const est = estimateMarketBuyCost(asks, 5n, 20_000_000n) // 2%
    // 3×10 + 2×12 = 54; fee = floor(54×0.02) = 1
    expect(est).toEqual({ quote: 54n, fee: 1n, total: 55n, fillable: 5n })
  })
  it('reports partial fillability when the book runs dry', () => {
    const est = estimateMarketBuyCost(asks, 100n, 0n)
    expect(est.fillable).toBe(8n)
    expect(est.quote).toBe(3n * 10n + 5n * 12n)
  })
})

describe('marketBuyRoundingBuffer', () => {
  it('matches the app: quantity × feeRate + 2', () => {
    expect(marketBuyRoundingBuffer(100n, 20_000_000n)).toBe(4n)
    expect(marketBuyRoundingBuffer(1n, 0n)).toBe(2n)
  })
})

describe('explainMoveAbort', () => {
  it('translates known module::code aborts', () => {
    const raw =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0xdbf2, name: Identifier("trading_account") }, function: 12, instruction: 38, function_name: Some("withdraw") }, 3) in command 2'
    expect(explainMoveAbort(raw)).toContain('insufficient currency')
    expect(explainMoveAbort(new Error(raw))).toContain('deposit more')
  })
  it('maps the cycle-7 order-not-found and multicoin slippage aborts', () => {
    expect(
      explainMoveAbort(
        "MoveAbort in 2nd command, abort code: 5, in '0xdbf2::big_vector::remove' (instruction 3)",
      ),
    ).toContain('Order not found')
    expect(
      explainMoveAbort(
        'MoveAbort(MoveLocation { module: ModuleId { address: 0xdbf2, name: Identifier("multicoin_pool") }, function: 1, instruction: 1, function_name: Some("swap") }, 13)',
      ),
    ).toContain('Slippage')
  })
  it('no longer maps the retired balance_manager module or book::8', () => {
    expect(
      explainMoveAbort(
        'MoveAbort(MoveLocation { module: ModuleId { address: 0x291b, name: Identifier("balance_manager") }, function: 12, instruction: 38, function_name: Some("withdraw") }, 3)',
      ),
    ).toBeNull()
    expect(
      explainMoveAbort(
        "MoveAbort in 2nd command, abort code: 8, in '0x291b::book::cancel_order'",
      ),
    ).toBeNull()
  })
  it('returns null for unknown aborts and non-abort errors', () => {
    expect(explainMoveAbort('everything is fine')).toBeNull()
    expect(
      explainMoveAbort(
        'MoveAbort(MoveLocation { module: ModuleId { address: 0x1, name: Identifier("unknown_mod") }, function: 1, instruction: 1, function_name: Some("f") }, 99)',
      ),
    ).toBeNull()
  })
})

// ─── balances.currency ───────────────────────────────────────────────────────

/**
 * CRED balances, read head-current from the fullnode.
 *
 * The branch that matters most is the one a new player is in: a wallet with
 * CRED and no trading account at all. That has to answer, not throw — it is
 * the state every account starts in, and the answer ("you hold X, none of it
 * is deposited, you have no trading account") is exactly what tells a caller
 * to create one.
 */
describe('balances.currency', () => {
  const credBalance = (amount: bigint) => bcs.u64().serialize(amount).toBytes()

  it('reports wallet CRED and a null trading account when none exists', async () => {
    const sui = fakeSuiClient({
      listCoins: () => ({ objects: [{ balance: '700' }, { balance: '50' }] }),
      listOwnedObjects: () => bmPage(null),
      getObject: () => {
        throw new Error('must not read a trading account that does not exist')
      },
    })

    const balances = await client(sui, jest.fn()).balances.currency()

    expect(balances).toEqual({
      wallet: 750n,
      tradingAccount: 0n,
      tradingAccountId: null,
    })
  })

  it('adds the trading account holding once one exists', async () => {
    const sui = fakeSuiClient({
      listCoins: () => ({ objects: [{ balance: '100' }] }),
      listOwnedObjects: () => bmPage(BM_ID),
      getObject: () => ({
        object: { json: { balances: { id: { id: '0x' + 'ba'.repeat(32) } } } },
      }),
      getDynamicField: () => ({
        dynamicField: { value: { bcs: credBalance(4200n) } },
      }),
    })

    const balances = await client(sui, jest.fn()).balances.currency()

    expect(balances).toEqual({
      wallet: 100n,
      tradingAccount: 4200n,
      tradingAccountId: BM_ID,
    })
  })

  it('reports zeroes rather than failing for an untouched address', async () => {
    const sui = fakeSuiClient({
      listCoins: () => ({ objects: [] }),
      listOwnedObjects: () => bmPage(null),
    })

    expect(await client(sui, jest.fn()).balances.currency()).toEqual({
      wallet: 0n,
      tradingAccount: 0n,
      tradingAccountId: null,
    })
  })

  it('treats a trading account with no CRED entry as zero, not an error', async () => {
    const sui = fakeSuiClient({
      listCoins: () => ({ objects: [{ balance: '9' }] }),
      listOwnedObjects: () => bmPage(BM_ID),
      getObject: () => ({
        object: { json: { balances: { id: { id: '0x' + 'ba'.repeat(32) } } } },
      }),
      // A BM that has never held CRED has no dynamic field for it.
      getDynamicField: () => {
        throw new Error('dynamic field not found')
      },
    })

    const balances = await client(sui, jest.fn()).balances.currency()
    expect(balances.tradingAccount).toBe(0n)
    expect(balances.tradingAccountId).toBe(BM_ID)
  })

  it('reads an explicit address without needing a configured one', async () => {
    const other = '0x' + 'ee'.repeat(32)
    const seen: string[] = []
    const sui = fakeSuiClient({
      listCoins: (args: any) => {
        seen.push(args.owner)
        return { objects: [{ balance: '3' }] }
      },
      listOwnedObjects: (args: any) => {
        seen.push(args.owner)
        return bmPage(null)
      },
    })

    const ro = new TriexClient({
      suiClient: sui,
      apiKey: 'k',
      indexerUrl: 'https://api.example.test',
    })
    const balances = await ro.balances.currency(other)

    expect(balances.wallet).toBe(3n)
    expect(seen).toEqual([other, other])
  })

  it("never answers another address with the configured player's cached account", async () => {
    const other = '0x' + 'ee'.repeat(32)
    const sui = fakeSuiClient({
      listCoins: () => ({ objects: [] }),
      listOwnedObjects: (args: any) =>
        bmPage(args.owner === OWNER ? BM_ID : null),
    })
    const c = client(sui, jest.fn())
    expect((await c.account.get())?.tradingAccountId).toBe(BM_ID)
    expect((await c.balances.currency(other)).tradingAccountId).toBeNull()
  })

  it('requires an address when neither config nor call supplies one', async () => {
    const sui = fakeSuiClient({})
    const ro = new TriexClient({
      suiClient: sui,
      apiKey: 'k',
      indexerUrl: 'https://api.example.test',
    })
    await expect(ro.balances.currency()).rejects.toMatchObject({
      code: TriexError.AddressRequired,
    })
  })
})

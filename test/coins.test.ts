/**
 * Coin-pool (`triex::pool`) reads and write composition. Writes are built
 * against a fake fullnode (incl. a fake `simulateTransaction` that answers the
 * pool view functions) and a capturing executor; each test pins the exact
 * Move-call sequence, argument order and the pure amounts, against the
 * cycle-7 signatures and triex-app-api's `useTriexbookCoinOrders` flows.
 */
import { jest } from '@jest/globals'
import { bcs } from '@mysten/sui/bcs'
import type { Transaction } from '@mysten/sui/transactions'
import { fromBase64, normalizeStructTag } from '@mysten/sui/utils'

import { ReadOnlyClient } from '../src/ReadOnlyClient'
import { TriexClient } from '../src/TriexClient'
import { STILLNESS_PACKAGE_IDS } from '../src/config'
import { TriexError } from '../src/errors'
import {
  COIN_POOL_CREATION_FEE,
  computeCoinBidDeposit,
  estimateCoinMarketOrder,
} from '../src/coins/money'
import {
  CoinBalancesBcs,
  CoinFeeScheduleBcs,
  CoinOrderBcs,
  CoinOrderPageBcs,
  CoinPoolAccountBcs,
} from '../src/coins/onchain'
import { currencyObjectId } from '../src/coins/transactions'

const IDS = STILLNESS_PACKAGE_IDS
const OWNER = '0x' + 'ab'.repeat(32)
const BM_ID = '0x' + 'b1'.repeat(32)
const POOL = '0x' + '10'.repeat(32)
const POOL2 = '0x' + '20'.repeat(32)
const CLOCK = '0x' + '6'.padStart(64, '0')
const BASE = normalizeStructTag('0x' + 'aa'.repeat(32) + '::wbtc::WBTC')
const CRED = normalizeStructTag(IDS.credCoinType)
const SUI = normalizeStructTag('0x2::sui::SUI')
const E9 = 1_000_000_000n

// Entry rung 1.10% taker / 0.90% maker; staged schedule 1.20% / 1.30%.
const ENTRY = { taker: 11_000_000n, maker: 9_000_000n }
const NEXT = { taker: 12_000_000n, maker: 13_000_000n }

// ─── fakes ───────────────────────────────────────────────────────────────────

const u64 = (v: bigint) => bcs.u64().serialize(v).toBytes()

function orderBytes(o: {
  id: bigint
  price: bigint
  qty: bigint
  filled?: bigint
  isBid: boolean
}) {
  return {
    trading_account_id: '0x' + 'cc'.repeat(32),
    order_id: o.id,
    price: o.price,
    is_bid: o.isBid,
    quantity: o.qty,
    filled_quantity: o.filled ?? 0n,
    epoch: 7n,
    maker_fee_rate: 90,
    cancel_retention_bps: 2000,
    status: 0,
    expire_timestamp: (1n << 64n) - 1n,
  }
}

type Book = {
  bids: ReturnType<typeof orderBytes>[]
  asks: ReturnType<typeof orderBytes>[]
}

interface ChainState {
  book?: Book
  /** Pool id `get_pool_id_by_asset` resolves to (null → abort). */
  poolId?: string | null
  /** `get_quantity_out_*` answer. */
  quantityOut?: [bigint, bigint]
  /** Present → `pool::account` succeeds. */
  account?: boolean
  accountOrders?: ReturnType<typeof orderBytes>[]
}

/** Answer each simulated MoveCall the way the pool view functions would. */
function fakeSimulate(state: ChainState) {
  return jest.fn(async ({ transaction }: { transaction: Transaction }) => {
    const data = transaction.getData()
    const results: { returnValues: { bcs: Uint8Array }[] }[] = []
    for (const c of data.commands as any[]) {
      if (c.$kind !== 'MoveCall') {
        results.push({ returnValues: [] })
        continue
      }
      const fn = c.MoveCall.function as string
      const pure = (i: number) => {
        const arg = c.MoveCall.arguments[i]
        return fromBase64((data.inputs as any[])[arg.Input].Pure.bytes)
      }
      let rv: Uint8Array[] = []
      switch (fn) {
        case 'get_pool_id_by_asset':
          if (!state.poolId)
            return { $kind: 'FailedTransaction', FailedTransaction: {} }
          rv = [bcs.Address.serialize(state.poolId).toBytes()]
          break
        case 'pool_trade_params':
          rv = [u64(ENTRY.taker), u64(ENTRY.maker)]
          break
        case 'pool_fee_schedule_next':
          rv = [
            CoinFeeScheduleBcs.serialize({
              tiers: [
                {
                  min_turnover: 0n,
                  taker_fee: NEXT.taker,
                  maker_fee: NEXT.maker,
                },
              ],
            }).toBytes(),
            u64(42n),
          ]
          break
        case 'pool_fee_class':
          rv = [bcs.u16().serialize(3).toBytes()]
          break
        case 'cancel_retention_bps':
          rv = [u64(2000n)]
          break
        case 'trade_params_for_account':
          rv = [u64(9_100_000n), u64(7_500_000n)]
          break
        case 'account_fee_tier':
          rv = [u64(3n)]
          break
        case 'account_fee_turnover':
          rv = [bcs.u128().serialize(123_456n).toBytes()]
          break
        case 'iter_orders': {
          const startOpt = pure(1)
          const start =
            startOpt[0] === 1
              ? BigInt(bcs.u128().parse(startOpt.slice(1)))
              : null
          const limit = Number(bcs.u64().parse(pure(4)))
          const bids = pure(5)[0] === 1
          const side = (bids ? state.book?.bids : state.book?.asks) ?? []
          const from =
            start === null ? 0 : side.findIndex((o) => o.order_id === start) + 1
          const orders = side.slice(from, from + limit)
          rv = [
            CoinOrderPageBcs.serialize({
              orders,
              has_next_page: from + limit < side.length,
            }).toBytes(),
          ]
          break
        }
        case 'get_quantity_out_input_fee':
        case 'get_quantity_out_for_account':
          rv = [u64(state.quantityOut![0]), u64(state.quantityOut![1])]
          break
        case 'account':
          if (!state.account)
            return { $kind: 'FailedTransaction', FailedTransaction: {} }
          rv = [
            CoinPoolAccountBcs.serialize({
              open_orders: { contents: [5n, 9n] },
              taker_volume: 100n,
              maker_volume: 200n,
              settled_balances: { base: 10n, quote: 20n, cred: 0n },
              owed_balances: { base: 0n, quote: 1n, cred: 0n },
              pending_turnover: [],
            }).toBytes(),
          ]
          break
        case 'locked_balance':
          rv = [u64(110n), u64(520n), u64(0n)]
          break
        case 'get_account_order_details':
          rv = [
            bcs
              .vector(CoinOrderBcs)
              .serialize(state.accountOrders ?? [])
              .toBytes(),
          ]
          break
        default:
          throw new Error(`fake simulate: unexpected ${fn}`)
      }
      results.push({ returnValues: rv.map((b) => ({ bcs: b })) })
    }
    return { $kind: 'Transaction', Transaction: {}, commandResults: results }
  })
}

type CoreImpl = Partial<{
  listCoins: (args: any) => any
  listOwnedObjects: (args: any) => any
  getObject: (args: any) => any
  getDynamicField: (args: any) => any
}>

function fakeSuiClient(impl: CoreImpl, chain: ChainState = {}): any {
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
      simulateTransaction: fakeSimulate(chain),
    },
  }
}

function captureExecutor(opts?: { createBm?: boolean; createPool?: boolean }) {
  const captured: { tx?: Transaction } = {}
  const executor = jest.fn(async (tx: Transaction) => {
    captured.tx = tx
    const objectChanges = []
    if (opts?.createBm)
      objectChanges.push({
        type: 'created',
        objectId: BM_ID,
        objectType: `${IDS.triex}::trading_account::TradingAccount`,
      })
    if (opts?.createPool)
      objectChanges.push({
        type: 'created',
        objectId: POOL,
        objectType: `${IDS.triex}::pool::Pool<${BASE}, ${CRED}>`,
      })
    return { digest: '0xd1gest', objectChanges }
  })
  return { executor, captured }
}

function commandNames(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.map((c: any) =>
      c.$kind === 'MoveCall'
        ? `${c.MoveCall.module}::${c.MoveCall.function}`
        : c.$kind,
    )
}

function pureU64s(tx: Transaction): bigint[] {
  const out: bigint[] = []
  for (const input of tx.getData().inputs as any[]) {
    const b64 = input?.Pure?.bytes
    if (!b64) continue
    const bytes = fromBase64(b64)
    if (bytes.length === 8) out.push(BigInt(bcs.u64().parse(bytes)))
  }
  return out
}

function moveCall(tx: Transaction, target: string): any {
  const call = tx
    .getData()
    .commands.find(
      (c: any) =>
        c.$kind === 'MoveCall' &&
        `${c.MoveCall.module}::${c.MoveCall.function}` === target,
    ) as any
  if (!call) throw new Error(`no MoveCall ${target}`)
  return call.MoveCall
}

/** Describe a MoveCall's args: object id, `pure:<bytes>`, `result`, or `gas`. */
function moveCallArgs(tx: Transaction, target: string): string[] {
  const data = tx.getData()
  return moveCall(tx, target).arguments.map((arg: any) => {
    if (arg.$kind === 'GasCoin') return 'gas'
    if (arg.$kind !== 'Input') return 'result'
    const input = (data.inputs as any[])[arg.Input]
    if (input?.Pure) return `pure:${fromBase64(input.Pure.bytes).length}`
    return (
      input?.UnresolvedObject?.objectId ??
      input?.Object?.SharedObject?.objectId ??
      input?.Object?.ImmOrOwnedObject?.objectId ??
      'unknown'
    )
  })
}

const bmPage = (id: string | null) => ({
  objects: id ? [{ objectId: id }] : [],
})

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

/** A trading account whose `balances` bag holds `held` of every coin type. */
function accountHolding(held: bigint | null): CoreImpl {
  return {
    getObject: ({ objectId }: any) => {
      if (objectId === POOL || objectId === POOL2)
        return {
          object: { type: `${IDS.triex}::pool::Pool<${BASE}, ${CRED}>` },
        }
      return {
        object: {
          json:
            held === null ? {} : { balances: { id: '0x' + 'ba'.repeat(32) } },
        },
      }
    },
    getDynamicField: () =>
      held === null ? null : { dynamicField: { value: { bcs: u64(held) } } },
  }
}

function client(sui: any, executor: any) {
  return new TriexClient({
    suiClient: sui,
    apiKey: 'k',
    indexerUrl: 'https://api.example.test',
    address: OWNER,
    executor,
  })
}

const POOL_SEL = { poolId: POOL, baseCoinType: BASE, quoteCoinType: CRED }

afterEach(() => jest.restoreAllMocks())

// ─── pool resolution ─────────────────────────────────────────────────────────

describe('coins.resolvePool', () => {
  it('resolves a pair through pool::get_pool_id_by_asset (CRED quote by default)', async () => {
    const sui = fakeSuiClient({}, { poolId: POOL })
    const pool = await client(sui, undefined).coins.resolvePool({
      baseCoinType: BASE,
    })
    expect(pool).toEqual({
      poolId: POOL,
      baseCoinType: BASE,
      quoteCoinType: CRED,
    })
    const tx = sui.core.simulateTransaction.mock.calls[0][0]
      .transaction as Transaction
    const call = moveCall(tx, 'pool::get_pool_id_by_asset')
    expect(call.typeArguments).toEqual([BASE, CRED])
    expect(moveCallArgs(tx, 'pool::get_pool_id_by_asset')).toEqual([
      IDS.triexRegistry,
    ])
  })

  it('throws PoolNotFound when the registry has no such pair', async () => {
    const sui = fakeSuiClient({}, { poolId: null })
    await expect(
      client(sui, undefined).coins.resolvePool({ baseCoinType: BASE }),
    ).rejects.toMatchObject({ code: TriexError.PoolNotFound })
  })

  it('types a bare pool id from its object type, and caches it', async () => {
    const getObject = jest.fn(() => ({
      object: { type: `${IDS.triex}::pool::Pool<${BASE}, ${CRED}>` },
    }))
    const c = client(fakeSuiClient({ getObject }), undefined)
    expect(await c.coins.resolvePool({ poolId: POOL })).toEqual(POOL_SEL)
    await c.coins.resolvePool({ poolId: POOL })
    expect(getObject).toHaveBeenCalledTimes(1)
  })

  it('rejects an object that is not a coin pool, and a mismatched base', async () => {
    const notPool = fakeSuiClient({
      getObject: () => ({
        object: {
          type: `${IDS.triex}::multicoin_pool::MultiCoinPool<${CRED}>`,
        },
      }),
    })
    await expect(
      client(notPool, undefined).coins.resolvePool({ poolId: POOL }),
    ).rejects.toMatchObject({ code: TriexError.PoolNotFound })

    const pool = fakeSuiClient(accountHolding(null))
    await expect(
      client(pool, undefined).coins.resolvePool({
        poolId: POOL,
        baseCoinType: SUI,
      }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })

  it('needs a poolId or a baseCoinType', async () => {
    await expect(
      client(fakeSuiClient({}), undefined).coins.resolvePool({}),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })
})

// ─── reads ───────────────────────────────────────────────────────────────────

describe('coins reads', () => {
  const asks = [
    orderBytes({ id: 101n, price: E9, qty: 5n, isBid: false }),
    orderBytes({ id: 102n, price: E9, qty: 3n, isBid: false }),
    orderBytes({ id: 103n, price: 2n * E9, qty: 5n, isBid: false }),
  ]
  const bids = [
    orderBytes({ id: 201n, price: E9 / 2n, qty: 4n, filled: 1n, isBid: true }),
  ]

  it('orderbook pages iter_orders per side and aggregates levels', async () => {
    const sui = fakeSuiClient({}, { book: { bids, asks } })
    const book = await client(sui, undefined).coins.orderbook({
      ...POOL_SEL,
      depth: 3,
    })
    expect(book.asks.map((o) => o.orderId)).toEqual(['101', '102', '103'])
    expect(book.askLevels).toEqual([
      { price: E9, quantity: 8n, orderCount: 2 },
      { price: 2n * E9, quantity: 5n, orderCount: 1 },
    ])
    expect(book.bids[0]).toMatchObject({
      orderId: '201',
      isBid: true,
      remainingQuantity: 3n,
      makerFeeBps: 90,
      status: 'live',
    })
    expect(book.hasMoreAsks).toBe(false)

    const paged = await client(
      fakeSuiClient({}, { book: { bids, asks } }),
      undefined,
    ).coins.orderbook({
      ...POOL_SEL,
      depth: 2,
    })
    expect(paged.asks.map((o) => o.orderId)).toEqual(['101', '102'])
    expect(paged.hasMoreAsks).toBe(true)
  })

  it('iter_orders is called with the exclusive cursor, an expiry floor, and the side flag', async () => {
    const sui = fakeSuiClient({}, { book: { bids: [], asks } })
    await client(sui, undefined).coins.orderbook({ ...POOL_SEL, depth: 2 })
    const tx = sui.core.simulateTransaction.mock.calls[0][0]
      .transaction as Transaction
    const call = moveCall(tx, 'coin_order_query::iter_orders')
    expect(call.typeArguments).toEqual([BASE, CRED])
    // pool, start?, end?, min_expire?, limit, bids
    expect(moveCallArgs(tx, 'coin_order_query::iter_orders')).toEqual([
      POOL,
      'pure:1',
      'pure:1',
      'pure:9',
      'pure:8',
      'pure:1',
    ])
  })

  it('tradeParams decodes entry + staged rates, retention and the account tier', async () => {
    const sui = fakeSuiClient({}, {})
    const tp = await client(sui, undefined).coins.tradeParams({
      ...POOL_SEL,
      tradingAccountId: BM_ID,
    })
    expect(tp).toEqual({
      poolId: POOL,
      feeClass: 3,
      entry: { takerFee: ENTRY.taker, makerFee: ENTRY.maker },
      next: { takerFee: NEXT.taker, makerFee: NEXT.maker, effectiveEpoch: 42n },
      cancelRetentionBps: 2000n,
      account: {
        takerFee: 9_100_000n,
        makerFee: 7_500_000n,
        tier: 3n,
        turnover: 123_456n,
      },
    })
  })

  it('quote maps get_quantity_out to amountOut / unspent per side', async () => {
    const buy = await client(
      fakeSuiClient({}, { quantityOut: [70n, 3n] }),
      undefined,
    ).coins.quote({
      ...POOL_SEL,
      side: 'buy',
      amountIn: 100n,
    })
    expect(buy).toEqual({
      side: 'buy',
      amountIn: 100n,
      amountOut: 70n,
      unspent: 3n,
    })
    const sell = await client(
      fakeSuiClient({}, { quantityOut: [2n, 95n] }),
      undefined,
    ).coins.quote({
      ...POOL_SEL,
      side: 'sell',
      amountIn: 100n,
    })
    expect(sell).toEqual({
      side: 'sell',
      amountIn: 100n,
      amountOut: 95n,
      unspent: 2n,
    })
  })

  it('account() parses pool::account + locked_balance; null when never traded', async () => {
    const sui = fakeSuiClient(
      { listOwnedObjects: () => bmPage(BM_ID) },
      { account: true },
    )
    const acct = await client(sui, undefined).coins.account(POOL_SEL)
    expect(acct).toEqual({
      poolId: POOL,
      tradingAccountId: BM_ID,
      openOrderIds: ['5', '9'],
      takerVolume: 100n,
      makerVolume: 200n,
      settled: { base: 10n, quote: 20n, cred: 0n },
      owed: { base: 0n, quote: 1n, cred: 0n },
      lockedInOrders: { base: 100n, quote: 500n, cred: 0n },
    })
    const none = fakeSuiClient(
      { listOwnedObjects: () => bmPage(BM_ID) },
      { account: false },
    )
    expect(await client(none, undefined).coins.account(POOL_SEL)).toBeNull()
  })

  it('openOrders reads get_account_order_details; [] without a trading account', async () => {
    const sui = fakeSuiClient(
      { listOwnedObjects: () => bmPage(BM_ID) },
      {
        accountOrders: [
          orderBytes({ id: 7n, price: E9, qty: 2n, isBid: true }),
        ],
      },
    )
    const orders = await client(sui, undefined).coins.openOrders(POOL_SEL)
    expect(orders.map((o) => o.orderId)).toEqual(['7'])
    const noBm = fakeSuiClient({ listOwnedObjects: () => bmPage(null) })
    expect(await client(noBm, undefined).coins.openOrders(POOL_SEL)).toEqual([])
  })

  it('balances reads wallet + trading-account holdings of any coin', async () => {
    const sui = fakeSuiClient({
      ...accountHolding(40n),
      listOwnedObjects: () => bmPage(BM_ID),
      listCoins: () => coinPage([5n, 6n]),
    })
    expect(
      await client(sui, undefined).coins.balances({ coinType: BASE }),
    ).toEqual({
      coinType: BASE,
      wallet: 11n,
      tradingAccount: 40n,
      tradingAccountId: BM_ID,
    })
  })

  it('estimateMarket prices against the live asks at the conservative taker rate', async () => {
    const sui = fakeSuiClient({}, { book: { bids: [], asks } })
    const est = await client(sui, undefined).coins.estimateMarket({
      ...POOL_SEL,
      side: 'buy',
      quantity: 10n,
    })
    // 8 @ 1.0 + 2 @ 2.0 = 12 gross; fee at max(1.10%, staged 1.20%) floors to 0
    expect(est.grossQuote).toBe(12n)
    expect(est.totalQuote).toBe(12n)
  })
})

describe('coins.list (GET /v1/coins)', () => {
  it('sends coin_types and parses CoinResponse with market data', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => [
        {
          coin_type: BASE,
          symbol: 'WBTC',
          name: 'Wrapped',
          decimals: 8,
          icon_url: null,
          total_supply: 21_000_000,
          circulating: 20_000_000,
          treasury_holdings: [
            {
              address: OWNER,
              label: null,
              type: 'treasury',
              amount: 1_000_000,
            },
          ],
          max_supply: 21_000_000,
          mint_policy: { kind: 'fixed' },
          immutable: true,
          upgradeable: null,
          verified: true,
          market: {
            base_asset_id: BASE,
            base_asset_symbol: 'WBTC',
            base_asset_name: null,
            base_asset_decimals: 8,
            quote_asset_id: CRED,
            quote_asset_symbol: 'CRED',
            quote_asset_name: null,
            quote_asset_decimals: 6,
            pool_id: POOL,
            pool_name: 'WBTC/CRED',
            fee: '11000000',
            fee_rate: 0.011,
            best_bid: '990000000',
            best_ask: null,
            open_orders: 4,
            traders: 2,
            last_price: null,
            last_traded_at: null,
          },
        },
        {
          coin_type: CRED,
          symbol: 'CRED',
          name: 'Cred',
          decimals: 6,
          icon_url: null,
          total_supply: null,
          circulating: null,
          treasury_holdings: null,
          max_supply: null,
          mint_policy: null,
          immutable: null,
          upgradeable: null,
          verified: null,
          market: null,
        },
      ],
    }))
    ;(global as any).fetch = fetchMock
    const ro = new ReadOnlyClient({
      apiKey: 'k',
      indexerUrl: 'https://api.example.test',
    })
    const coins = await ro.coins.list({ coinTypes: [BASE, CRED] })

    const [url] = fetchMock.mock.calls[0] as unknown as [URL]
    expect(String(url)).toContain('/v1/coins')
    expect(url.searchParams.get('coin_types')).toBe(`${BASE},${CRED}`)
    expect(coins[0].market).toMatchObject({
      poolId: POOL,
      baseCoinType: BASE,
      quoteCoinType: CRED,
      feeRateScaled: 11_000_000n,
      bestBid: 990_000_000n,
      bestAsk: null,
    })
    expect(coins[0].mintPolicy).toEqual({ kind: 'fixed', capped: null })
    expect(coins[1].market).toBeNull()
  })

  it('ReadOnlyClient fullnode reads need a suiClient', async () => {
    const ro = new ReadOnlyClient({ apiKey: 'k' })
    await expect(
      ro.coins.orderbook({ baseCoinType: BASE }),
    ).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
    })
  })

  it('ReadOnlyClient account reads need an explicit trading account', async () => {
    const ro = new ReadOnlyClient({ apiKey: 'k', suiClient: fakeSuiClient({}) })
    await expect(ro.coins.openOrders(POOL_SEL)).rejects.toMatchObject({
      code: TriexError.AddressRequired,
    })
  })
})

// ─── writes ──────────────────────────────────────────────────────────────────

describe('coins.limit', () => {
  it('bid: deposits quote + fee at max(taker, maker, staged) then places with the policy', async () => {
    const sui = fakeSuiClient({
      ...accountHolding(0n),
      listOwnedObjects: () => bmPage(BM_ID),
      listCoins: () => coinPage([10n ** 15n]),
    })
    const { executor, captured } = captureExecutor()
    const price = 2_500_000_000n
    const quantity = 4_000_000_000n
    await client(sui, executor).coins.limit({
      ...POOL_SEL,
      side: 'buy',
      price,
      quantity,
    })

    const tx = captured.tx!
    expect(commandNames(tx)).toEqual([
      'SplitCoins',
      'trading_account::deposit',
      'trading_account::generate_proof_as_owner',
      'pool::place_limit_order',
    ])
    // Q = 10e9; rate = max(1.10, 0.90, 1.20, 1.30)% = 1.30% → 10.13e9
    const expected = computeCoinBidDeposit(price, quantity, NEXT.maker)
    expect(expected).toBe(10_130_000_000n)
    expect(pureU64s(tx)).toContainEqual(expected)
    expect(moveCall(tx, 'trading_account::deposit').typeArguments).toEqual([
      CRED,
    ])
    expect(moveCall(tx, 'pool::place_limit_order').typeArguments).toEqual([
      BASE,
      CRED,
    ])
    expect(moveCallArgs(tx, 'pool::place_limit_order')).toEqual([
      POOL,
      IDS.triexFeePolicy,
      BM_ID,
      'result',
      'pure:1', // order type
      'pure:1', // self matching
      'pure:8', // price
      'pure:8', // quantity
      'pure:1', // is_bid
      'pure:8', // expire
      CLOCK,
    ])
    expect(pureU64s(tx)).toEqual(
      expect.arrayContaining([price, quantity, 18446744073709551615n]),
    )
  })

  it('bid: deposits nothing when the account already holds enough quote', async () => {
    const sui = fakeSuiClient({
      ...accountHolding(10n ** 12n),
      listOwnedObjects: () => bmPage(BM_ID),
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).coins.limit({
      ...POOL_SEL,
      side: 'buy',
      price: E9,
      quantity: 100n,
    })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::generate_proof_as_owner',
      'pool::place_limit_order',
    ])
  })

  it('ask: creates the account in-PTB, deposits the base, transfers the account', async () => {
    const sui = fakeSuiClient({
      ...accountHolding(null),
      listOwnedObjects: () => bmPage(null),
      listCoins: () => coinPage([300n, 700n]),
    })
    const { executor, captured } = captureExecutor({ createBm: true })
    await client(sui, executor).coins.limit({
      ...POOL_SEL,
      side: 'sell',
      price: E9,
      quantity: 900n,
    })
    const tx = captured.tx!
    expect(commandNames(tx)).toEqual([
      'trading_account::new',
      'MergeCoins',
      'SplitCoins',
      'trading_account::deposit',
      'trading_account::generate_proof_as_owner',
      'pool::place_limit_order',
      'TransferObjects',
    ])
    expect(moveCall(tx, 'trading_account::deposit').typeArguments).toEqual([
      BASE,
    ])
    expect(pureU64s(tx)).toContainEqual(900n)
  })

  it('rejects a quantity below the price-derived minimum without executing', async () => {
    const { executor } = captureExecutor()
    await expect(
      client(fakeSuiClient({}), executor).coins.limit({
        ...POOL_SEL,
        side: 'sell',
        price: 300_000_000n, // min = ceil(1e9 / 3e8) = 4
        quantity: 3n,
      }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    expect(executor).not.toHaveBeenCalled()
  })

  it('honors an explicit quoteDeposit and order flags', async () => {
    const sui = fakeSuiClient({
      ...accountHolding(0n),
      listOwnedObjects: () => bmPage(BM_ID),
      listCoins: () => coinPage([10n ** 12n]),
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).coins.limit({
      ...POOL_SEL,
      side: 'buy',
      price: E9,
      quantity: 100n,
      quoteDeposit: 555n,
      orderType: 3,
      expireAt: 1_800_000_000_000n,
    })
    // no fee-policy simulation when the deposit is given
    expect(sui.core.simulateTransaction).not.toHaveBeenCalled()
    expect(pureU64s(captured.tx!)).toEqual(
      expect.arrayContaining([555n, 1_800_000_000_000n]),
    )
  })
})

describe('coins.market', () => {
  const asks = [
    orderBytes({ id: 1n, price: 2n * E9, qty: 3n * E9, isBid: false }),
    orderBytes({ id: 2n, price: 3n * E9, qty: 10n * E9, isBid: false }),
  ]

  it('buy: holds the exact live-book cost (taker fee at the conservative rate)', async () => {
    const sui = fakeSuiClient(
      {
        ...accountHolding(0n),
        listOwnedObjects: () => bmPage(BM_ID),
        listCoins: () => coinPage([10n ** 15n]),
      },
      { book: { bids: [], asks } },
    )
    const { executor, captured } = captureExecutor()
    await client(sui, executor).coins.market({
      ...POOL_SEL,
      side: 'buy',
      quantity: 5n * E9,
    })

    const expected = estimateCoinMarketOrder(
      [
        { price: 2n * E9, remainingQuantity: 3n * E9 },
        { price: 3n * E9, remainingQuantity: 10n * E9 },
      ],
      'buy',
      5n * E9,
      NEXT.taker,
    ).totalQuote
    // 3 @ 2 + 2 @ 3 = 12e9; fee 1.20% = 0.144e9
    expect(expected).toBe(12_144_000_000n)
    const tx = captured.tx!
    expect(commandNames(tx)).toEqual([
      'SplitCoins',
      'trading_account::deposit',
      'trading_account::generate_proof_as_owner',
      'pool::place_market_order',
    ])
    expect(pureU64s(tx)).toContainEqual(expected)
    expect(moveCallArgs(tx, 'pool::place_market_order')).toEqual([
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

  it('buy: refuses to send when the book has no asks', async () => {
    const sui = fakeSuiClient(
      { listOwnedObjects: () => bmPage(BM_ID) },
      { book: { bids: [], asks: [] } },
    )
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).coins.market({
        ...POOL_SEL,
        side: 'buy',
        quantity: 5n,
      }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    expect(executor).not.toHaveBeenCalled()
  })

  it('sell: deposits only the base deficit', async () => {
    const sui = fakeSuiClient({
      ...accountHolding(40n),
      listOwnedObjects: () => bmPage(BM_ID),
      listCoins: () => coinPage([1_000n]),
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).coins.market({
      ...POOL_SEL,
      side: 'sell',
      quantity: 100n,
    })
    expect(pureU64s(captured.tx!)).toContainEqual(60n)
    expect(
      moveCall(captured.tx!, 'trading_account::deposit').typeArguments,
    ).toEqual([BASE])
  })
})

describe('coins.swap', () => {
  it('buy: wallet quote → swap_exact_quote_for_base with a zero CRED coin; min-out = dry-run − 0.5%', async () => {
    const sui = fakeSuiClient(
      { listCoins: () => coinPage([10_000n]) },
      { quantityOut: [2_000n, 0n] },
    )
    const { executor, captured } = captureExecutor()
    const res = await client(sui, executor).coins.swap({
      ...POOL_SEL,
      side: 'buy',
      amountIn: 1_000n,
    })
    expect(res.minOut).toBe(1_990n)
    const tx = captured.tx!
    expect(commandNames(tx)).toEqual([
      'SplitCoins',
      'coin::zero',
      'pool::swap_exact_quote_for_base',
      'TransferObjects',
    ])
    expect(moveCall(tx, 'coin::zero').typeArguments).toEqual([CRED])
    expect(moveCallArgs(tx, 'pool::swap_exact_quote_for_base')).toEqual([
      POOL,
      IDS.triexFeePolicy,
      'result',
      'result',
      'pure:8',
      CLOCK,
    ])
    expect(pureU64s(tx)).toEqual(expect.arrayContaining([1_000n, 1_990n]))
  })

  it('sell with an explicit minOut skips the dry run', async () => {
    const sui = fakeSuiClient({ listCoins: () => coinPage([10_000n]) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).coins.swap({
      ...POOL_SEL,
      side: 'sell',
      amountIn: 500n,
      minOut: 7n,
    })
    expect(sui.core.simulateTransaction).not.toHaveBeenCalled()
    expect(commandNames(captured.tx!)).toContain(
      'pool::swap_exact_base_for_quote',
    )
  })

  it('refuses to send when nothing would fill', async () => {
    const sui = fakeSuiClient({}, { quantityOut: [0n, 1_000n] })
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).coins.swap({
        ...POOL_SEL,
        side: 'buy',
        amountIn: 1_000n,
      }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })
})

describe('coins cancel / modify / claim (no FeePolicy argument)', () => {
  const sui = () => fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })

  it('cancel: pool::cancel_order(pool, account, proof, u128, clock)', async () => {
    const { executor, captured } = captureExecutor()
    const id = (1n << 127n) + (5n << 64n) + 3n
    await client(sui(), executor).coins.cancel({
      ...POOL_SEL,
      orderId: id.toString(),
    })
    const tx = captured.tx!
    expect(commandNames(tx)).toEqual([
      'trading_account::generate_proof_as_owner',
      'pool::cancel_order',
    ])
    expect(moveCallArgs(tx, 'pool::cancel_order')).toEqual([
      POOL,
      BM_ID,
      'result',
      'pure:16',
      CLOCK,
    ])
    expect(moveCall(tx, 'pool::cancel_order').typeArguments).toEqual([
      BASE,
      CRED,
    ])
  })

  it('cancelMany: pool::cancel_orders with a vector<u128>', async () => {
    const { executor, captured } = captureExecutor()
    await client(sui(), executor).coins.cancelMany({
      ...POOL_SEL,
      orderIds: ['1', 2n],
    })
    expect(moveCallArgs(captured.tx!, 'pool::cancel_orders')).toEqual([
      POOL,
      BM_ID,
      'result',
      'pure:33', // ULEB len + 2 × 16 bytes
      CLOCK,
    ])
  })

  it('cancelAll and modify', async () => {
    const a = captureExecutor()
    await client(sui(), a.executor).coins.cancelAll(POOL_SEL)
    expect(moveCallArgs(a.captured.tx!, 'pool::cancel_all_orders')).toEqual([
      POOL,
      BM_ID,
      'result',
      CLOCK,
    ])

    const b = captureExecutor()
    await client(sui(), b.executor).coins.modify({
      ...POOL_SEL,
      orderId: 9n,
      newQuantity: 4n,
    })
    expect(moveCallArgs(b.captured.tx!, 'pool::modify_order')).toEqual([
      POOL,
      BM_ID,
      'result',
      'pure:16',
      'pure:8',
      CLOCK,
    ])
    expect(pureU64s(b.captured.tx!)).toContainEqual(4n)
  })

  it('cancel rejects a malformed order id; cancels need an existing account', async () => {
    const { executor } = captureExecutor()
    await expect(
      client(sui(), executor).coins.cancel({ ...POOL_SEL, orderId: 'nope' }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    const noBm = fakeSuiClient({ listOwnedObjects: () => bmPage(null) })
    await expect(
      client(noBm, executor).coins.cancelAll(POOL_SEL),
    ).rejects.toMatchObject({
      code: TriexError.TradingAccountNotFound,
    })
  })

  it('claimSettled: one proof, one withdraw_settled_amounts per pool, optional sweep', async () => {
    const { executor, captured } = captureExecutor()
    await client(sui(), executor).coins.claimSettled({
      pools: [
        POOL_SEL,
        { poolId: POOL2, baseCoinType: SUI, quoteCoinType: CRED },
      ],
      withdrawCoinTypes: [CRED],
    })
    const tx = captured.tx!
    expect(commandNames(tx)).toEqual([
      'trading_account::generate_proof_as_owner',
      'pool::withdraw_settled_amounts',
      'pool::withdraw_settled_amounts',
      'trading_account::withdraw_all',
      'TransferObjects',
    ])
    const calls = (tx.getData().commands as any[]).filter(
      (c) => c.MoveCall?.function === 'withdraw_settled_amounts',
    )
    expect(calls.map((c) => c.MoveCall.typeArguments)).toEqual([
      [BASE, CRED],
      [SUI, CRED],
    ])
  })
})

describe('coins.deposit / withdraw / createPool', () => {
  it('deposits SUI from the gas coin (never selects SUI coin objects)', async () => {
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      listCoins: () => coinPage([5_000n]),
    })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).coins.deposit({
      coinType: '0x2::sui::SUI',
      amount: 1_000n,
    })
    const tx = captured.tx!
    expect(commandNames(tx)).toEqual(['SplitCoins', 'trading_account::deposit'])
    const split = (tx.getData().commands as any[])[0].SplitCoins
    expect(split.coin.$kind).toBe('GasCoin')
    expect(moveCall(tx, 'trading_account::deposit').typeArguments).toEqual([
      SUI,
    ])
  })

  it('withdraws a partial amount of a coin to the wallet', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).coins.withdraw({ coinType: BASE, amount: 42n })
    expect(commandNames(captured.tx!)).toEqual([
      'trading_account::withdraw',
      'TransferObjects',
    ])
    expect(
      moveCall(captured.tx!, 'trading_account::withdraw').typeArguments,
    ).toEqual([BASE])
    expect(pureU64s(captured.tx!)).toContainEqual(42n)
  })

  it('createPool pays exactly 500 CRED and passes both Currency objects', async () => {
    const sui = fakeSuiClient({ listCoins: () => coinPage([10n ** 12n]) })
    const { executor, captured } = captureExecutor({ createPool: true })
    const res = await client(sui, executor).coins.createPool({
      baseCoinType: BASE,
    })
    expect(res.poolId).toBe(POOL)
    const tx = captured.tx!
    expect(commandNames(tx)).toEqual([
      'SplitCoins',
      'pool::create_permissionless_pool',
    ])
    expect(pureU64s(tx)).toContainEqual(COIN_POOL_CREATION_FEE)
    expect(moveCallArgs(tx, 'pool::create_permissionless_pool')).toEqual([
      IDS.triexRegistry,
      IDS.triexFeePolicy,
      currencyObjectId(BASE),
      currencyObjectId(CRED),
      'result',
    ])
  })
})

// keep the Balances layout export exercised (used by downstream decoders)
test('CoinBalancesBcs round-trips', () => {
  const b = CoinBalancesBcs.serialize({
    base: 1n,
    quote: 2n,
    cred: 3n,
  }).toBytes()
  expect(CoinBalancesBcs.parse(b)).toEqual({ base: '1', quote: '2', cred: '3' })
})

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
import { MultiCoinBalanceBcs, toSsuObjectId } from '../src/onchain'
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
    },
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
              objectType: `${IDS.triexbook}::balance_manager::BalanceManager`,
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
      'balance_manager::deposit',
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
      'balance_manager::new',
      'SplitCoins',
      'balance_manager::deposit',
      'TransferObjects',
    ])
    // The created BM id was captured from objectChanges (read-your-writes).
    expect(await c.account.get()).toEqual({
      balanceManagerId: BM_ID,
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
  it('withdraws a partial amount via balance_manager::withdraw', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).account.withdrawCurrency({ amount: 42n })
    expect(commandNames(captured.tx!)).toEqual([
      'balance_manager::withdraw',
      'TransferObjects',
    ])
    expect(pureU64s(captured.tx!)).toContainEqual(42n)
  })

  it('withdraws everything via withdraw_all when no amount is given', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).account.withdrawCurrency()
    expect(commandNames(captured.tx!)).toEqual([
      'balance_manager::withdraw_all',
      'TransferObjects',
    ])
  })

  it('fails typed when no balance manager exists', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(null) })
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).account.withdrawCurrency(),
    ).rejects.toMatchObject({ code: TriexError.BalanceManagerNotFound })
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
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE, META_ROUTE])
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      getObject: () => bmWithNoBag, // BM CRED balance → 0
      listCoins: () => coinPage([1_000_000n]),
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
      'balance_manager::deposit',
      'balance_manager::generate_proof_as_owner',
      'multicoin_pool::place_limit_order',
    ])
    const u64s = pureU64s(captured.tx!)
    expect(u64s).toContainEqual(306n) // 300 quote + 2% fee, floor-of-total
    expect(u64s).toContainEqual(GTC_EXPIRE) // default expiry
    expect(u64s).toContainEqual(100n) // price
  })

  it('skips the deposit entirely when the BM already holds enough quote', async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE, META_ROUTE])
    const credBag = '0x' + 'ba'.repeat(32)
    const sui = fakeSuiClient({
      listOwnedObjects: () => bmPage(BM_ID),
      getObject: () => ({ object: { json: { balances: { id: credBag } } } }),
      getDynamicField: () => ({
        dynamicField: { value: { bcs: bcs.u64().serialize(1_000n).toBytes() } },
      }),
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
      'balance_manager::generate_proof_as_owner',
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
      'balance_manager::deposit_multicoin',
      'balance_manager::generate_proof_as_owner',
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
      'balance_manager::generate_proof_as_owner',
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

  it('deposits budget + rounding buffer and places the market order', async () => {
    routeFetch([VAULT_ROUTE, RESOLVE_ROUTE, META_ROUTE])
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
      'balance_manager::deposit',
      'balance_manager::generate_proof_as_owner',
      'multicoin_pool::place_market_order',
    ])
    // buffer = 100 × 2% + 2 = 4 → deposit 1004
    expect(pureU64s(captured.tx!)).toContainEqual(1_004n)
  })
})

// ─── orders.cancel / cancelAll / modify ──────────────────────────────────────

describe('orders.cancel family', () => {
  const routes: Array<[string, unknown]> = [VAULT_ROUTE, RESOLVE_ROUTE]

  it('cancel composes proof + cancel_order with the u64 order id', async () => {
    routeFetch(routes)
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(BM_ID) })
    const { executor, captured } = captureExecutor()
    await client(sui, executor).orders.cancel({
      storageUnitId: HEX,
      assetId: '70810',
      orderId: '42',
    })
    expect(commandNames(captured.tx!)).toEqual([
      'balance_manager::generate_proof_as_owner',
      'multicoin_pool::cancel_order',
    ])
    expect(pureU64s(captured.tx!)).toContainEqual(42n)
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
      'balance_manager::generate_proof_as_owner',
      'multicoin_pool::cancel_all_orders',
    ])
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
      'balance_manager::generate_proof_as_owner',
      'multicoin_pool::modify_order',
    ])
    const u64s = pureU64s(captured.tx!)
    expect(u64s).toContainEqual(42n)
    expect(u64s).toContainEqual(3n)
  })

  it('cancel without a balance manager fails typed', async () => {
    const sui = fakeSuiClient({ listOwnedObjects: () => bmPage(null) })
    const { executor } = captureExecutor()
    await expect(
      client(sui, executor).orders.cancel({
        storageUnitId: HEX,
        assetId: '70810',
        orderId: 1n,
      }),
    ).rejects.toMatchObject({ code: TriexError.BalanceManagerNotFound })
  })
})

// ─── account.claimSettled ────────────────────────────────────────────────────

describe('account.claimSettled', () => {
  it('claims only pools with settled balances from the sweepable manifest', async () => {
    routeFetch([
      [
        '/sweepable',
        {
          balance_manager_id: BM_ID,
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
      'balance_manager::generate_proof_as_owner',
      'multicoin_pool::withdraw_settled_amounts',
    ])
  })

  it('fails typed when nothing is settled', async () => {
    routeFetch([
      [
        '/sweepable',
        {
          balance_manager_id: BM_ID,
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
      'balance_manager::withdraw_all_multicoin',
      'receipt::redeem_receipt',
      'balance_manager::withdraw_all_multicoin',
      'receipt::redeem_receipt',
    ])
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
      'MoveAbort(MoveLocation { module: ModuleId { address: 0x291b, name: Identifier("balance_manager") }, function: 12, instruction: 38, function_name: Some("withdraw") }, 3) in command 2'
    expect(explainMoveAbort(raw)).toContain('insufficient currency')
    expect(explainMoveAbort(new Error(raw))).toContain('deposit more')
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

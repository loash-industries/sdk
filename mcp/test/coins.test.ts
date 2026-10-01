import { jest } from '@jest/globals'
import { bcs } from '@mysten/sui/bcs'
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils'
import { createContext } from '../src/context.js'
import { loadConfig } from '../src/env.js'
import { ALL_TOOLS, toolsForMode } from '../src/registry.js'

/**
 * The coin-pool and account-capability tools, end to end.
 *
 * TypeScript cannot check these handlers against the SDK — its `.d.ts`
 * re-exports are extensionless and resolve to `any` under NodeNext — so the
 * only proof a handler is wired right is a call that goes out and is looked at:
 * the URL a read requests, the fullnode calls it makes, or the Move calls in
 * the bytes a prepare tool hands back.
 */
const config = loadConfig({
  TRIEX_MCP_MODE: 'prepare',
  TRIEX_INDEXER_URL: 'https://api.example.test',
} as NodeJS.ProcessEnv)

const SENDER = '0x'.padEnd(66, 'a')
const BM_ID = '0x'.padEnd(66, 'b')
const POOL = '0x'.padEnd(66, '1')
const BASE = normalizeStructTag('0x' + 'aa'.repeat(32) + '::wbtc::WBTC')
const DIGEST = '11111111111111111111111111111111'

const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}
const body = (res: { content: { text: string }[] }) =>
  JSON.parse(res.content[0]!.text)

/**
 * A fullnode stub. `arity` answers `getMoveFunction` — the transaction builder
 * asks for a function's parameters before it can type an object argument —
 * with that many `&mut` object parameters. The sender's trading account comes
 * back address-owned; every other object (pools, the clock) shared.
 */
function fakeSui(
  impl: Record<string, (args: any) => any>,
  arity: Record<string, number> = {},
): any {
  const defaults: Record<string, (args: any) => any> = {
    listOwnedObjects: () => ({ objects: [{ objectId: BM_ID }] }),
    getObjects: ({ objectIds }: { objectIds: string[] }) => ({
      objects: objectIds.map((objectId) => ({
        objectId,
        version: '7',
        digest: DIGEST,
        owner:
          objectId === BM_ID
            ? { $kind: 'AddressOwner', AddressOwner: SENDER }
            : { $kind: 'Shared', Shared: { initialSharedVersion: '1' } },
      })),
    }),
    getMoveFunction: ({ name }: { name: string }) => {
      const n = arity[name]
      if (n === undefined)
        throw new Error(`getMoveFunction(${name}) not stubbed`)
      return {
        function: {
          parameters: Array.from({ length: n }, () => ({
            reference: 'mutable',
            body: {
              $kind: 'datatype',
              datatype: { typeName: '0x2::object::UID', typeParameters: [] },
            },
          })),
        },
      }
    },
  }
  return {
    core: new Proxy(
      {},
      {
        get: (_t, name: string) =>
          // Asked synchronously by Transaction#build; none means "use the
          // stock resolver", which then drives the stubs below.
          name === 'resolveTransactionPlugin'
            ? () => undefined
            : async (args: any) => {
                const fn = impl[name] ?? defaults[name]
                if (!fn) throw new Error(`core.${name} not stubbed`)
                return fn(args)
              },
      },
    ),
  }
}

function captureFetch(payload: unknown): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => payload,
  }))
  ;(global as any).fetch = fn
  return fn
}

afterEach(() => jest.restoreAllMocks())

describe('coin reads', () => {
  it('coins_list asks the indexer for exactly the coin types given', async () => {
    const fetchMock = captureFetch([])
    const ctx = createContext('tenant-key', config, fakeSui({}))

    const res = await tool('coins_list').handler(ctx, { coinTypes: [BASE] })
    expect(res.isError).toBeFalsy()
    expect(body(res)).toEqual([])

    const url = fetchMock.mock.calls[0]![0] as URL
    expect(url.pathname).toBe('/v1/coins')
    expect(url.searchParams.get('coin_types')).toBe(BASE)
  })

  it('coins_list without a filter lists the whole registry', async () => {
    const fetchMock = captureFetch([])
    const ctx = createContext('tenant-key', config, fakeSui({}))
    await tool('coins_list').handler(ctx, {})
    const url = fetchMock.mock.calls[0]![0] as URL
    expect(url.searchParams.has('coin_types')).toBe(false)
  })

  it('reaches the fullnode through the read client, keylessly', async () => {
    // ReadOnlyClient answers coins.* reads only when handed a suiClient; the
    // context wires the shared one in, so no signer or address is configured.
    const owners: string[] = []
    const ctx = createContext(
      'tenant-key',
      config,
      fakeSui({
        listCoins: (a: any) => {
          owners.push(a.owner)
          return { objects: [{ balance: '900' }] }
        },
        listOwnedObjects: (a: any) => {
          owners.push(a.owner)
          return { objects: [] }
        },
      }),
    )

    const res = await tool('coins_balances').handler(ctx, {
      coinType: BASE,
      address: SENDER,
    })
    expect(res.isError).toBeFalsy()
    expect(body(res)).toEqual({
      coinType: BASE,
      wallet: '900',
      tradingAccount: '0',
      tradingAccountId: null,
    })
    expect(owners).toEqual([SENDER, SENDER])
  })

  it('renders raw coin amounts as decimal strings', async () => {
    const huge = 9_007_199_254_740_993n // 2^53 + 1
    const ctx = createContext(
      'tenant-key',
      config,
      fakeSui({
        listCoins: () => ({ objects: [{ balance: huge.toString() }] }),
        listOwnedObjects: () => ({ objects: [{ objectId: BM_ID }] }),
        getObject: () => ({
          object: { json: { balances: { id: { id: BM_ID } } } },
        }),
        getDynamicField: () => ({
          dynamicField: { value: { bcs: bcs.u64().serialize(huge).toBytes() } },
        }),
      }),
    )
    const res = await tool('coins_balances').handler(ctx, {
      coinType: BASE,
      address: SENDER,
    })
    expect(body(res).wallet).toBe(huge.toString())
    expect(body(res).tradingAccount).toBe(huge.toString())
  })

  it('every coin read is available to a read-only deployment', () => {
    const read = toolsForMode('read').map((t) => t.name)
    for (const name of ALL_TOOLS.filter(
      (t) => t.kind === 'read' && t.sdkPath.startsWith('coins.'),
    ).map((t) => t.name)) {
      expect(read).toContain(name)
    }
    expect(read).not.toContain('prepare_coin_limit_order')
  })

  it('rejects a malformed coin type before touching the chain', () => {
    const shape = tool('coins_balances').inputShape as any
    expect(shape.coinType.safeParse('WBTC').success).toBe(false)
    expect(shape.coinType.safeParse('0x2::sui::SUI').success).toBe(true)
    expect(shape.coinType.safeParse(BASE).success).toBe(true)
  })
})

describe('orders_fees', () => {
  /** A context whose TriexClient is a stub recording what fees() received. */
  function ctxRecording() {
    const calls: { address?: string; params: Record<string, unknown> }[] = []
    const ctx = {
      writeClient: (address?: string) => ({
        orders: {
          fees: async (params: Record<string, unknown>) => {
            calls.push({ address, params })
            return { poolId: POOL, entryTakerFeeRate: 11_000_000n }
          },
        },
      }),
    } as never
    return { ctx, calls }
  }

  it('passes a pool id alone, with no hub keys for the SDK to branch on', async () => {
    // The SDK picks its selector with `'poolId' in params`; a stray
    // `storageUnitId: undefined` would be harmless, but a stray `poolId`
    // key would not — so the handler builds the selector from what was given.
    const { ctx, calls } = ctxRecording()
    const res = await tool('orders_fees').handler(ctx, { poolId: POOL })
    expect(calls).toEqual([{ address: undefined, params: { poolId: POOL } }])
    expect(body(res).entryTakerFeeRate).toBe('11000000')
  })

  it('resolves by hub + item, and resolves the tier of the address given', async () => {
    const { ctx, calls } = ctxRecording()
    await tool('orders_fees').handler(ctx, {
      storageUnitId: POOL,
      assetId: '70810',
      address: SENDER,
    })
    expect(calls).toEqual([
      {
        address: SENDER,
        params: { storageUnitId: POOL, assetId: '70810', address: SENDER },
      },
    ])
    expect('poolId' in calls[0]!.params).toBe(false)
  })

  it('refuses a half selector instead of guessing', async () => {
    const { ctx, calls } = ctxRecording()
    await expect(
      tool('orders_fees').handler(ctx, { storageUnitId: POOL }),
    ).rejects.toThrow(/poolId, or by storageUnitId together with assetId/)
    expect(calls).toEqual([])
  })
})

describe('prepared bytes carry the Move calls the tool names', () => {
  it('prepare_mint_account_cap mints on the sender’s own trading account', async () => {
    const ctx = createContext(
      'tenant-key',
      config,
      fakeSui({}, { mint_trade_cap: 1 }),
    )
    const triex = normalizeSuiAddress(ctx.writeClient(SENDER).ids.triex)

    const res = await tool('prepare_mint_account_cap').handler(ctx, {
      sender: SENDER,
      kind: 'trade',
    })
    expect(res.isError).toBeFalsy()
    const prepared = body(res)

    expect(prepared.intent.targets).toEqual([
      `${triex}::trading_account::mint_trade_cap`,
    ])
    expect(prepared.intent.action).toBe('mint_account_cap')
    expect(prepared.intent.params).toEqual({ kind: 'trade', recipient: SENDER })
    expect(prepared.pinnedObjects).toEqual([
      { objectId: BM_ID, version: '7', kind: 'owned' },
    ])
    expect(prepared.sender).toBe(SENDER)
  })

  it('prepare_coin_cancel_order proves ownership, then cancels in the named pool', async () => {
    const ctx = createContext(
      'tenant-key',
      config,
      fakeSui({}, { generate_proof_as_owner: 1, cancel_order: 5 }),
    )
    const client = ctx.writeClient(SENDER)
    const triex = normalizeSuiAddress(client.ids.triex)
    const cred = normalizeStructTag(client.ids.credCoinType)

    // All three selector fields: the SDK trusts the pairing and does no lookup.
    const res = await tool('prepare_coin_cancel_order').handler(ctx, {
      sender: SENDER,
      poolId: POOL,
      baseCoinType: BASE,
      quoteCoinType: cred,
      orderId: '340282366920938463463374607431768211455', // u128 max
    })
    expect(res.isError).toBeFalsy()
    const prepared = body(res)

    expect(prepared.intent.targets).toEqual([
      `${triex}::trading_account::generate_proof_as_owner`,
      `${triex}::pool::cancel_order`,
    ])
    expect(prepared.intent.params).toMatchObject({
      poolId: POOL,
      baseCoinType: BASE,
      quoteCoinType: cred,
      orderId: '340282366920938463463374607431768211455',
    })
    // Cancelling moves nothing out of the sender's control.
    expect(prepared.intent.worstCaseSpend).toBeUndefined()
    expect(prepared.pinnedObjects).toEqual(
      expect.arrayContaining([
        { objectId: BM_ID, version: '7', kind: 'owned' },
        { objectId: POOL, version: '1', kind: 'shared' },
      ]),
    )
  })

  it('prices a coin buy’s worst case in the quote coin, from the live fee policy', async () => {
    // A bid is funded at quote + fee at the highest entry-rung rate; the tool
    // reads that rate first so worstCaseSpend states the amount the bytes
    // commit to, in the pool's quote coin rather than a symbol.
    const ctx = createContext('tenant-key', config, fakeSui({}))
    const client = ctx.writeClient(SENDER)
    const cred = normalizeStructTag(client.ids.credCoinType)
    const limit = jest.fn(async () => {
      throw new Error('stop before building')
    })
    const stub = {
      ids: client.ids,
      coins: {
        resolvePool: async () => ({
          poolId: POOL,
          baseCoinType: BASE,
          quoteCoinType: cred,
        }),
        tradeParams: async () => ({
          entry: { takerFee: 11_000_000n, makerFee: 9_000_000n },
          next: { takerFee: 12_000_000n, makerFee: 13_000_000n },
        }),
        limit,
      },
    }
    const stubCtx = { ...ctx, writeClient: () => stub } as never

    await expect(
      tool('prepare_coin_limit_order').handler(stubCtx, {
        sender: SENDER,
        poolId: POOL,
        side: 'buy',
        price: '2000000000', // 2 quote per base, 1e9-scaled
        quantity: '1000',
      }),
    ).rejects.toThrow('stop before building')

    // Q = 1000 × 2e9 / 1e9 = 2000; fee at max(1.1%, 0.9%, 1.2%, 1.3%) = 26.
    expect(limit).toHaveBeenCalledWith(
      expect.objectContaining({
        poolId: POOL,
        baseCoinType: BASE,
        quoteCoinType: cred,
        quoteDeposit: 2026n,
      }),
    )
  })
})

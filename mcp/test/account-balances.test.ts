import { jest } from '@jest/globals'
import { bcs } from '@mysten/sui/bcs'
import { createContext } from '../src/context.js'
import { loadConfig } from '../src/env.js'
import { ALL_TOOLS, toolsForMode } from '../src/registry.js'

/**
 * `account_currency_balances`, with the state a new player is actually in.
 *
 * An address with no trading account is not an error case — it is where every
 * account starts, and the tool has to say so rather than throw, because the
 * null `tradingAccountId` is the thing that tells an agent to prepare one.
 */
const config = loadConfig({
  TRIEX_MCP_MODE: 'read',
  TRIEX_INDEXER_URL: 'https://api.example.test',
} as NodeJS.ProcessEnv)

const ADDR = '0x'.padEnd(66, 'a')
const BM_ID = '0x'.padEnd(66, 'b')
const BAG_ID = '0x'.padEnd(66, 'c')

function fakeSui(impl: Record<string, (args: any) => any>): any {
  return {
    core: new Proxy(
      {},
      {
        get: (_t, name: string) => async (args: any) => {
          const fn = impl[name]
          if (!fn) throw new Error(`core.${name} not stubbed`)
          return fn(args)
        },
      },
    ),
  }
}

const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!
const body = (res: { content: { text: string }[] }) =>
  JSON.parse(res.content[0]!.text)

afterEach(() => jest.restoreAllMocks())

describe('account_currency_balances', () => {
  it('answers for an address with no trading account', async () => {
    const ctx = createContext(
      'tenant-key',
      config,
      fakeSui({
        listCoins: () => ({ objects: [{ balance: '700' }, { balance: '50' }] }),
        listOwnedObjects: () => ({ objects: [] }),
      }),
    )

    const res = await tool('account_currency_balances').handler(ctx, {
      address: ADDR,
    })

    expect(res.isError).toBeFalsy()
    expect(body(res)).toEqual({
      wallet: '750',
      tradingAccount: '0',
      tradingAccountId: null,
    })
  })

  it('includes the deposited balance once a trading account exists', async () => {
    const ctx = createContext(
      'tenant-key',
      config,
      fakeSui({
        listCoins: () => ({ objects: [{ balance: '100' }] }),
        listOwnedObjects: () => ({ objects: [{ objectId: BM_ID }] }),
        getObject: () => ({
          object: { json: { balances: { id: { id: BAG_ID } } } },
        }),
        getDynamicField: () => ({
          dynamicField: {
            value: { bcs: bcs.u64().serialize(4200n).toBytes() },
          },
        }),
      }),
    )

    const res = await tool('account_currency_balances').handler(ctx, {
      address: ADDR,
    })

    expect(body(res)).toEqual({
      wallet: '100',
      tradingAccount: '4200',
      tradingAccountId: BM_ID,
    })
  })

  it('renders u64 amounts as decimal strings, never JSON numbers', async () => {
    // Past 2^53 a JSON number silently loses precision; the whole MCP
    // boundary is string-typed for u64 for exactly this reason.
    const huge = 9_007_199_254_740_993n // 2^53 + 1
    const ctx = createContext(
      'tenant-key',
      config,
      fakeSui({
        listCoins: () => ({ objects: [{ balance: huge.toString() }] }),
        listOwnedObjects: () => ({ objects: [] }),
      }),
    )

    const res = await tool('account_currency_balances').handler(ctx, {
      address: ADDR,
    })
    expect(res.content[0]!.text).toContain(`"wallet": "${huge}"`)
    expect(body(res).wallet).toBe(huge.toString())
  })

  it('reads the address it was given, not one baked into the server', async () => {
    const other = '0x'.padEnd(66, 'e')
    const owners: string[] = []
    const ctx = createContext(
      'tenant-key',
      config,
      fakeSui({
        listCoins: (a: any) => {
          owners.push(a.owner)
          return { objects: [] }
        },
        listOwnedObjects: (a: any) => {
          owners.push(a.owner)
          return { objects: [] }
        },
      }),
    )

    await tool('account_currency_balances').handler(ctx, { address: other })
    expect(owners).toEqual([other, other])
  })

  it('rejects a malformed address before touching the fullnode', () => {
    const shape = tool('account_currency_balances').inputShape as any
    expect(shape.address.safeParse('not-an-address').success).toBe(false)
    expect(shape.address.safeParse(ADDR).success).toBe(true)
  })

  it('is available to a read-only deployment', () => {
    expect(toolsForMode('read').map((t) => t.name)).toContain(
      'account_currency_balances',
    )
  })
})

/**
 * `account_balances_at_hub`, observed at the wire.
 *
 * `ReadOnlyClient.balancesAtHub` takes ONE params object. The tool used to
 * pass two positional strings, so the SDK read `storageUnitId` off a string
 * and every call went out with no hub at all. Nothing type-checks that here —
 * the SDK's re-exports resolve to `any` under NodeNext — so only an inspected
 * request can.
 */
describe('account_balances_at_hub', () => {
  const inventory = {
    storage_unit_id: BM_ID,
    collection_id: BAG_ID,
    warehouse: [],
    marketplace: [{ asset_id: '77800', amount: '9007199254740993' }],
    hangar: [],
    org_vaults: {},
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

  const ctx = () => createContext('tenant-key', config, {} as any)
  const urlOf = (fetchMock: jest.Mock) => fetchMock.mock.calls[0]![0] as URL

  it('sends the hub and the trading account as the gateway names them', async () => {
    const fetchMock = captureFetch(inventory)
    const res = await tool('account_balances_at_hub').handler(ctx(), {
      storageUnitId: BM_ID,
      tradingAccountId: ADDR,
    })
    expect(res.isError).toBeFalsy()

    const url = urlOf(fetchMock)
    expect(url.pathname).toBe('/v1/inventory/balances')
    // Exactly these two keys: no undefined selector leaks onto the wire.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      storage_unit_id: BM_ID,
      trading_account_id: ADDR,
    })
    expect(res.content[0]!.text).toContain('"amount": "9007199254740993"')
  })

  it('maps every section selector onto its query key', async () => {
    const fetchMock = captureFetch(inventory)
    await tool('account_balances_at_hub').handler(ctx(), {
      storageUnitId: BM_ID,
      address: ADDR,
      inventoryKey: '0xcap',
      vaultIds: ['0xv1', '0xv2'],
    })
    expect(Object.fromEntries(urlOf(fetchMock).searchParams)).toEqual({
      storage_unit_id: BM_ID,
      owner_address: ADDR,
      inventory_key: '0xcap',
      vault_ids: '0xv1,0xv2',
    })
  })

  it('refuses a call naming no section before spending a request', async () => {
    const fetchMock = captureFetch(inventory)
    await expect(
      tool('account_balances_at_hub').handler(ctx(), { storageUnitId: BM_ID }),
    ).rejects.toThrow(/at least one section/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires the hub and keeps every selector optional', () => {
    const shape = tool('account_balances_at_hub').inputShape as any
    expect(shape.storageUnitId.safeParse(undefined).success).toBe(false)
    for (const key of ['tradingAccountId', 'address', 'inventoryKey']) {
      expect(shape[key].safeParse(undefined).success).toBe(true)
    }
    expect(shape.vaultIds.safeParse([]).success).toBe(false)
  })
})

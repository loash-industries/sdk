import { jest } from '@jest/globals'
import { z } from 'zod'
import { createContext } from '../src/context.js'
import { loadConfig } from '../src/env.js'
import { ALL_TOOLS, toolsForMode } from '../src/registry.js'

/**
 * The indexer read surface — point lookups, market-wide feeds, characters,
 * world reference data and routing — wired end to end: tool input → SDK
 * method → the URL that actually leaves the process.
 *
 * As in read-locations.test.ts, the parity gate checks NAMES and cannot see a
 * handler that forgot to unwrap a positional argument; only an inspected
 * request can (`account_balances_at_hub` shipped exactly that bug — see
 * account-balances.test.ts).
 */
const config = loadConfig({
  TRIEX_MCP_MODE: 'read',
  TRIEX_INDEXER_URL: 'https://api.example.test',
} as NodeJS.ProcessEnv)

const HEX = '0x'.padEnd(66, 'a')
const WALLET = '0x'.padEnd(66, 'b')
const U128 = '170141183460469231731687303715884105730'

function captureFetch(payload: unknown, status = 200): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Not Found',
    headers: { get: () => null },
    json: async () => payload,
  }))
  ;(global as any).fetch = fn
  return fn
}

const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!
const ctx = () => createContext('tenant-key', config, {} as any)
const urlOf = (fetchMock: jest.Mock, i = 0) =>
  fetchMock.mock.calls[i]![0] as URL

afterEach(() => jest.restoreAllMocks())

// ─── Wire fixtures (shapes from the SDK's gateway-reads suite) ───────────────

const character = {
  object_id: HEX,
  item_id: '2112113391',
  tenant: 'stillness',
  tribe_id: null,
  address: WALLET,
  name: 'Rin Farshot',
  description: '',
  url: '',
  checkpoint_at: 1755043200000,
}

const route = {
  waypoints: [
    {
      solar_system_id: 30000001,
      solar_system_name: 'U4T-SL7',
      jump_type: 'start',
      distance_ly: null,
    },
    { solar_system_id: 30016469, jump_type: 'stargate' },
  ],
  total_cost: {
    drive_distance_ly: 0,
    total_distance_ly: 12.5,
    gate_jumps: 1,
    drive_jumps: 0,
    total_jumps: 1,
  },
  optimization: 'fastest',
}

const orderDetail = {
  order_id: U128,
  pool_id: HEX,
  side: 'buy',
  order_type: 'limit_buy',
  status: 'filled',
  price: '1000000000',
  quantity: '10',
  remaining_quantity: '0',
  filled_quantity: '10',
  expires_at: 1798647150509,
  updated_at: 1790871151355,
  asset_id: '77800',
  asset_name: 'Crustal Anorthosite Crystals',
  trading_account: { id: HEX, owner: WALLET, character: null },
  hub: null,
  currency: null,
  fills: [],
}

const fillDetail = {
  event_digest: 'BviVpTyKk19',
  pool_id: HEX,
  asset_id: '95679',
  storage_unit_id: HEX,
  price: '100000000000',
  base_quantity: '1',
  quote_quantity: '100000000000',
  maker_fee: '1800000000',
  taker_fee: '2200000000',
  taker_is_bid: true,
  maker_trading_account_id: HEX,
  taker_trading_account_id: WALLET,
  filled_at: 1790869771673,
}

// ─── New reads reach the endpoint their inputs describe ──────────────────────

describe('indexer reads reach the endpoint their inputs describe', () => {
  const cases: Array<{
    tool: string
    args: Record<string, unknown>
    payload: unknown
    path: string
    query?: Record<string, string>
  }> = [
    {
      tool: 'market_recent_trades',
      args: { assetId: '95679', publicOnly: true, limit: 25, before: 200 },
      payload: { data: [], next_cursor: null },
      path: '/v1/trades/recent',
      // The SDK's assetId goes out as the gateway's item_id.
      query: {
        item_id: '95679',
        public_only: 'true',
        limit: '25',
        before: '200',
      },
    },
    {
      tool: 'market_display_prices',
      args: { itemIds: ['77800', '1'], storageUnitIds: [HEX], fallback: false },
      payload: { prices: [] },
      path: '/v1/display-prices',
      query: { item_ids: '77800,1', storage_unit_ids: HEX, fallback: 'false' },
    },
    {
      tool: 'market_display_price',
      args: { itemId: '77800', storageUnitId: HEX },
      payload: {
        prices: [
          {
            item_id: '77800',
            storage_unit_id: HEX,
            collection_id: null,
            pool_id: null,
            quote_currency: null,
            quote_decimals: null,
            tier: 'unknown',
            price: null,
            price_raw: null,
            best_bid: null,
            best_ask: null,
            fills_here: 0,
            fills_this_item: 0,
          },
        ],
      },
      // The item id is a PATH segment, not a query key.
      path: '/v1/display-prices/77800',
      query: { storage_unit_id: HEX },
    },
    {
      tool: 'market_hub_economics',
      args: { hubIds: [HEX, '0xbeef'] },
      payload: [],
      path: '/v1/hubs/economics',
      query: { ids: `${HEX},0xbeef` },
    },
    {
      tool: 'market_top_pools_by_fees',
      args: { limit: 5 },
      payload: [],
      path: '/v1/pools/top-by-fees',
      query: { limit: '5' },
    },
    {
      tool: 'orders_get',
      args: { poolId: HEX, orderId: U128 },
      payload: orderDetail,
      path: `/v1/pools/${HEX}/orders/${U128}`,
    },
    {
      tool: 'orders_fill',
      args: { eventDigest: 'BviVpTyKk19' },
      payload: fillDetail,
      path: '/v1/fills/BviVpTyKk19',
    },
    {
      tool: 'characters_get',
      args: { characterId: HEX, enrich: true },
      payload: { ...character, owner_cap_id: '0xcap', assembly_id: '0xasm' },
      path: `/v1/characters/${HEX}`,
      query: { enrich: 'true' },
    },
    {
      tool: 'characters_by_address',
      args: { address: WALLET },
      payload: [character],
      path: `/v1/characters/address/${WALLET}`,
    },
    {
      tool: 'characters_by_name',
      args: { name: 'Rin Farshot' },
      payload: [],
      path: '/v1/characters/name/Rin%20Farshot',
    },
    {
      tool: 'characters_batch',
      args: { addresses: [WALLET, '0x1'] },
      payload: [],
      path: '/v1/characters/batch',
      query: { addresses: `${WALLET},0x1` },
    },
    {
      tool: 'characters_tribe',
      args: { tribeId: 98000001 },
      payload: {
        tribe_id: 98000001,
        name: 'Northwind Collective',
        name_short: 'NWC',
        description: '',
        tax_rate: 0.05,
        tribe_url: '',
      },
      path: '/v1/world/tribes/98000001',
    },
    {
      tool: 'world_item',
      args: { assetId: '77800' },
      payload: { asset_id: '77800', name: 'Crystals', symbol: 'Silicates' },
      path: '/v1/world/items/77800',
    },
    {
      tool: 'world_recipes_for',
      args: { productAssetId: '77753' },
      payload: [],
      path: '/v1/world/recipes/77753',
    },
  ]

  it.each(cases)(
    '$tool → $path',
    async ({ tool: name, args, payload, path, query }) => {
      const fetchMock = captureFetch(payload)
      const res = await tool(name).handler(ctx(), args)
      expect(res.isError).toBeFalsy()

      const url = urlOf(fetchMock)
      expect(url.pathname).toBe(path)
      expect(Object.fromEntries(url.searchParams)).toEqual(query ?? {})
    },
  )

  it('carries the calling tenant key onto the request', async () => {
    const fetchMock = captureFetch([])
    await tool('world_recipes').handler(ctx(), {})
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(
      'tenant-key',
    )
  })

  it('answers "not craftable" with [] rather than an error', async () => {
    captureFetch(undefined, 404)
    const res = await tool('world_recipes_for').handler(ctx(), {
      productAssetId: '1',
    })
    expect(JSON.parse(res.content[0]!.text)).toEqual([])
  })

  it('takes order ids as u128 decimal strings, never numbers', () => {
    const shape = z.object(tool('orders_get').inputShape)
    expect(shape.safeParse({ poolId: HEX, orderId: U128 }).success).toBe(true)
    expect(shape.safeParse({ poolId: HEX, orderId: 42 }).success).toBe(false)
    expect(shape.safeParse({ poolId: HEX, orderId: '0x2a' }).success).toBe(
      false,
    )
  })

  it('bounds the batch reads at their upstream caps', () => {
    const batch = z.object(tool('characters_batch').inputShape)
    const many = (n: number) => Array.from({ length: n }, () => WALLET)
    expect(batch.safeParse({ addresses: many(500) }).success).toBe(true)
    expect(batch.safeParse({ addresses: many(501) }).success).toBe(false)
    const prices = z.object(tool('market_display_prices').inputShape)
    const ids = (n: number) => Array.from({ length: n }, (_, i) => String(i))
    expect(prices.safeParse({ itemIds: ids(100) }).success).toBe(true)
    expect(prices.safeParse({ itemIds: ids(101) }).success).toBe(false)
  })

  it('requires an explicit address — there is no configured player', () => {
    const shape = z.object(tool('characters_by_address').inputShape)
    expect(shape.safeParse({}).success).toBe(false)
    expect(shape.safeParse({ address: WALLET }).success).toBe(true)
  })
})

// ─── Routing is name-only ────────────────────────────────────────────────────

describe('routing tools take solar system names only', () => {
  it('sends the names verbatim with every ship parameter under its wire name', async () => {
    const fetchMock = captureFetch(route)
    const res = await tool('routing_route').handler(ctx(), {
      origin: 'U4T-SL7',
      destination: 'U.L6B.HNX',
      optimization: 'fuel',
      mass: 2.5,
      gateWeight: 0.7,
      maxJumpRangeLy: 500,
    })
    expect(res.isError).toBeFalsy()

    const url = urlOf(fetchMock)
    expect(url.pathname).toBe('/v1/routing/route')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      origin: 'U4T-SL7',
      destination: 'U.L6B.HNX',
      optimization: 'fuel',
      mass: '2.5',
      gate_weight: '0.7',
      max_jump_range_ly: '500',
    })
    // An unreported system on the path comes back unnamed, keyed by id.
    const body = JSON.parse(res.content[0]!.text)
    expect(body.waypoints[1]).toMatchObject({
      solarSystemId: 30016469,
      solarSystemName: null,
    })
  })

  it('compares the three modes without sending an optimization', async () => {
    const fetchMock = captureFetch({
      fuel_efficient: { ...route, optimization: 'fuel_efficient' },
      fastest: route,
      balanced: { ...route, optimization: 'balanced' },
    })
    await tool('routing_compare').handler(ctx(), {
      origin: 'A-1',
      destination: 'B-2',
    })
    const url = urlOf(fetchMock)
    expect(url.pathname).toBe('/v1/routing/compare')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      origin: 'A-1',
      destination: 'B-2',
    })
    expect(Object.keys(tool('routing_compare').inputShape)).not.toContain(
      'optimization',
    )
  })

  it.each(['routing_route', 'routing_compare'])(
    '%s rejects a numeric solar system id before spending a request',
    (name) => {
      const shape = z.object(tool(name).inputShape)
      const byId = shape.safeParse({ origin: '30000142', destination: 'Nod' })
      expect(byId.success).toBe(false)
      expect(JSON.stringify(byId.error?.issues)).toMatch(/NAMES, not numeric/)
      expect(
        shape.safeParse({ origin: 'Nod', destination: '30000142' }).success,
      ).toBe(false)
      expect(
        shape.safeParse({ origin: 'EHK-KH7', destination: 'Nod' }).success,
      ).toBe(true)
    },
  )

  it('surfaces an unreported or unreachable name as RouteNotFound', async () => {
    captureFetch(
      {
        error: 'not_found',
        message:
          "origin solar system 'NOPE' not found (its name may not have been reported yet)",
      },
      404,
    )
    await expect(
      tool('routing_route').handler(ctx(), {
        origin: 'NOPE',
        destination: 'Nod',
      }),
    ).rejects.toMatchObject({ code: 'TRIEX_ROUTE_NOT_FOUND' })
  })

  it('bounds gateWeight to 0–1', () => {
    const shape = z.object(tool('routing_route').inputShape)
    const base = { origin: 'A-1', destination: 'B-2' }
    expect(shape.safeParse({ ...base, gateWeight: 1 }).success).toBe(true)
    expect(shape.safeParse({ ...base, gateWeight: 1.5 }).success).toBe(false)
  })
})

describe('server modes', () => {
  it('serves the whole indexer read surface to a read-only deployment', () => {
    const names = toolsForMode('read').map((t) => t.name)
    for (const name of [
      'market_recent_trades',
      'market_stats',
      'orders_get',
      'orders_fill',
      'routing_route',
      'characters_batch',
      'world_items',
    ]) {
      expect(names).toContain(name)
    }
  })
})

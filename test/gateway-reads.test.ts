/**
 * The read surface added for full gateway coverage: point lookups (one order,
 * one fill), market-wide feeds and rankings, characters and tribes, world
 * reference data, and routing.
 *
 * Wire fixtures mirror the gateway's published OpenAPI document
 * (test/fixtures/gateway-openapi.json) — its examples where it has them, and
 * shapes verified against the live gateway otherwise. Each endpoint is pinned
 * three ways: the URL and query names it sends (a misnamed filter is silently
 * ignored upstream), the camelCase shape it returns, and the typed error its
 * 404 maps to.
 */
import { jest } from '@jest/globals'
import { IndexerClient } from '../src/queries'
import { ReadOnlyClient } from '../src/ReadOnlyClient'
import { TriexClient } from '../src/TriexClient'
import { TriexClientError, TriexError } from '../src/errors'
import {
  iterateFills,
  iterateHubLocations,
  iterateItemLocations,
  iterateOpenOrders,
  iterateRecentTrades,
} from '../src/paging'

const HEX = '0x7f3a9b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8'
const WALLET =
  '0x2a4b6e7c8d9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b'
const CRED = '0x9f3a1b2c::cred::CRED'
const U128 = '170141183460469231731687303715884105730'

/** Queue JSON payloads; each fetch call shifts one. Returns the call log. */
function mockFetch(payloads: unknown[]): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payloads.shift(),
  }))
  ;(global as any).fetch = fn
  return fn
}

/** Every request 404s with the given body (or a non-JSON one). */
function mock404(body?: unknown): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected token <')
      return body
    },
  }))
  ;(global as any).fetch = fn
  return fn
}

const urlOf = (fetchMock: jest.Mock, i = 0) => fetchMock.mock.calls[i][0] as URL

afterEach(() => jest.restoreAllMocks())

const client = new IndexerClient('https://api.example.test', 'k')

// ─── Wire fixtures ───────────────────────────────────────────────────────────

const orderCharacter = {
  character_id: HEX,
  item_id: '2112113391',
  tenant: 'stillness',
  tribe_id: 98000001,
  character_address: WALLET,
  name: 'Rin Farshot',
  description: '',
  url: '',
}

const orderDetail = {
  order_id: U128,
  pool_id: HEX,
  side: 'buy',
  order_type: 'limit_buy',
  status: 'open',
  price: '1000000000',
  quantity: '10000',
  remaining_quantity: '9000',
  filled_quantity: '1000',
  expires_at: 1798647150509,
  updated_at: 1790871151355,
  asset_id: '77800',
  asset_name: 'Crustal Anorthosite Crystals',
  trading_account: { id: HEX, owner: WALLET, character: orderCharacter },
  hub: {
    hub_id: HEX,
    assembly_item_id: '84955',
    assembly_tenant: 'stillness',
    type_id: '84955',
    owner_cap_id: '0xcap',
    owner: null,
    solarsystem: '30000142',
    x: '-4552684039025347600',
    y: '-1259408979310431000',
    z: '715413928863438800',
    solar_system_id: 30000142,
    solar_system_name: null,
    is_public: true,
    region_id: 10000005,
  },
  currency: { type_string: CRED, name: 'CRED', decimals: 6, icon_url: null },
  fills: [
    {
      event_digest: 'BviVpTyKk19',
      price: '1000000000',
      base_quantity: '1000',
      quote_quantity: '1000000000000',
      fee: '22000000000',
      role: 'maker',
      counterparty_trading_account_id: HEX,
      counterparty: null,
      traded_at: 1790869771673,
    },
  ],
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
  taker_trading_account_id: '0xtaker',
  filled_at: 1790869771673,
}

const recentTrade = {
  price: '100000',
  quantity: '1',
  side: 'buy',
  order_type: 'market_buy',
  traded_at: 1790869771754,
  tx_digest: 'BviVpTyKk',
  fee_rate_bps: 220,
  fee_amount: '4000',
  asset_id: '95679',
  hub_id: HEX,
  quote_currency: CRED,
  quote_currency_decimals: 6,
  region_id: null,
  solar_system_id: null,
  solar_system_name: null,
}

const displayPrice = {
  item_id: '77800',
  storage_unit_id: HEX,
  collection_id: HEX,
  pool_id: HEX,
  quote_currency: CRED,
  quote_decimals: 9,
  tier: 'traded',
  price: '12.5',
  price_raw: '12500000000',
  best_bid: '12',
  best_ask: '13',
  fills_here: 4,
  fills_this_item: 9,
}

const character = {
  object_id: HEX,
  item_id: '2112113391',
  tenant: 'stillness',
  tribe_id: null,
  address: WALLET,
  name: 'Rin Farshot',
  description: 'A pilot.',
  url: 'https://example.test/rin.png',
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
    {
      solar_system_id: 30002493,
      solar_system_name: null,
      jump_type: 'jump_drive',
      distance_ly: 489.2796758851323,
    },
    // A stargate hop omits distance_ly entirely.
    { solar_system_id: 30016469, jump_type: 'stargate' },
  ],
  total_cost: {
    drive_distance_ly: 489.2796758851323,
    total_distance_ly: 520.5,
    gate_jumps: 1,
    drive_jumps: 1,
    total_jumps: 2,
  },
  optimization: 'fastest',
}

// ─── Orders & fills ──────────────────────────────────────────────────────────

describe('poolOrder', () => {
  it('puts pool and order id in the path and parses the full detail', async () => {
    const fetchMock = mockFetch([orderDetail])
    const order = await client.poolOrder({ poolId: HEX, orderId: U128 })

    expect(urlOf(fetchMock).pathname).toBe(`/v1/pools/${HEX}/orders/${U128}`)
    expect(urlOf(fetchMock).search).toBe('')
    expect(order).toMatchObject({
      orderId: U128,
      side: 'buy',
      orderType: 'limit_buy',
      status: 'open',
      price: 1000000000n,
      quantity: 10000n,
      remainingQuantity: 9000n,
      filledQuantity: 1000n,
      assetName: 'Crustal Anorthosite Crystals',
      tradingAccount: {
        tradingAccountId: HEX,
        owner: WALLET,
        character: { name: 'Rin Farshot', tribeId: 98000001 },
      },
      currency: { coinType: CRED, decimals: 6, iconUrl: null },
    })
    // The order hub spells its raw system field `solarsystem`.
    expect(order.hub).toMatchObject({
      solarSystem: '30000142',
      solarSystemId: 30000142,
      solarSystemName: null,
    })
    expect(order.fills[0]).toMatchObject({
      fee: 22000000000n,
      role: 'maker',
      counterparty: null,
      tradedAt: 1790869771673,
    })
  })

  it('sends a bigint or 0x-hex order id as decimal', async () => {
    let fetchMock = mockFetch([orderDetail])
    await client.poolOrder({ poolId: HEX, orderId: BigInt(U128) })
    expect(urlOf(fetchMock).pathname.endsWith(`/orders/${U128}`)).toBe(true)

    fetchMock = mockFetch([orderDetail])
    await client.poolOrder({ poolId: HEX, orderId: '0xff' })
    expect(urlOf(fetchMock).pathname.endsWith('/orders/255')).toBe(true)
  })

  it('rejects a non-u128 order id before spending a request', async () => {
    const fetchMock = mockFetch([])
    for (const orderId of ['12.5', '-1', 'abc', (1n << 128n).toString()]) {
      await expect(
        client.poolOrder({ poolId: HEX, orderId }),
      ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps an order status or type added upstream instead of failing', async () => {
    mockFetch([
      {
        ...orderDetail,
        status: 'expired',
        order_type: null,
        hub: null,
        currency: null,
      },
    ])
    const order = await client.poolOrder({ poolId: HEX, orderId: '1' })
    expect(order.status).toBe('expired')
    expect(order.orderType).toBeNull()
    expect(order.hub).toBeNull()
  })

  it('maps a 404 to OrderNotFound', async () => {
    mock404({ message: 'Order 1 not found in pool', error: 'Not Found' })
    await expect(
      client.poolOrder({ poolId: HEX, orderId: '1' }),
    ).rejects.toMatchObject({ code: TriexError.OrderNotFound, status: 404 })
  })
})

describe('fill', () => {
  it('reads one fill with both sides and both fees', async () => {
    const fetchMock = mockFetch([fillDetail])
    const fill = await client.fill('BviVpTyKk19')

    expect(urlOf(fetchMock).pathname).toBe('/v1/fills/BviVpTyKk19')
    expect(fill).toEqual({
      eventDigest: 'BviVpTyKk19',
      poolId: HEX,
      assetId: '95679',
      storageUnitId: HEX,
      price: 100000000000n,
      baseQuantity: 1n,
      quoteQuantity: 100000000000n,
      makerFee: 1800000000n,
      takerFee: 2200000000n,
      takerIsBid: true,
      makerTradingAccountId: HEX,
      takerTradingAccountId: '0xtaker',
      filledAt: 1790869771673,
    })
  })

  it('accepts a fill whose market metadata is not indexed yet', async () => {
    mockFetch([{ ...fillDetail, asset_id: null, storage_unit_id: null }])
    const fill = await client.fill('d1')
    expect(fill.assetId).toBeNull()
    expect(fill.storageUnitId).toBeNull()
  })

  it('maps a 404 to FillNotFound', async () => {
    mock404({ message: 'Fill not found: abc1' })
    await expect(client.fill('abc1')).rejects.toMatchObject({
      code: TriexError.FillNotFound,
    })
  })
})

// ─── Market-wide feeds, prices & rankings ────────────────────────────────────

describe('recentTrades', () => {
  it('maps the filters to the spec names and keeps human-readable prices as strings', async () => {
    const fetchMock = mockFetch([
      { data: [recentTrade], next_cursor: '1790869771754' },
    ])
    const page = await client.recentTrades({
      before: 200,
      after: 100,
      limit: 25,
      publicOnly: true,
      assetId: '95679',
    })

    const url = urlOf(fetchMock)
    expect(url.pathname).toBe('/v1/trades/recent')
    expect(url.searchParams.get('before')).toBe('200')
    expect(url.searchParams.get('after')).toBe('100')
    expect(url.searchParams.get('limit')).toBe('25')
    expect(url.searchParams.get('public_only')).toBe('true')
    expect(url.searchParams.get('item_id')).toBe('95679')
    expect(url.searchParams.has('asset_id')).toBe(false)

    expect(page.nextCursor).toBe('1790869771754')
    expect(page.trades[0]).toEqual({
      price: '100000',
      quantity: '1',
      side: 'buy',
      orderType: 'market_buy',
      tradedAt: 1790869771754,
      txDigest: 'BviVpTyKk',
      feeRateBps: 220,
      feeAmount: '4000',
      assetId: '95679',
      hubId: HEX,
      quoteCurrency: CRED,
      quoteCurrencyDecimals: 6,
      regionId: null,
      solarSystemId: null,
      solarSystemName: null,
    })
  })

  it('sends no filters when none are given', async () => {
    const fetchMock = mockFetch([{ data: [], next_cursor: null }])
    await client.recentTrades()
    expect(urlOf(fetchMock).search).toBe('')
  })
})

describe('displayPrices / displayPrice', () => {
  it('joins item and hub ids and parses each tier', async () => {
    const fetchMock = mockFetch([
      {
        prices: [
          displayPrice,
          {
            ...displayPrice,
            item_id: '1',
            collection_id: null,
            pool_id: null,
            quote_currency: null,
            quote_decimals: null,
            tier: 'unknown',
            price: null,
            price_raw: null,
            best_bid: null,
            best_ask: null,
          },
        ],
      },
    ])
    const prices = await client.displayPrices({
      itemIds: ['77800', '1'],
      storageUnitIds: [HEX],
    })

    const url = urlOf(fetchMock)
    expect(url.pathname).toBe('/v1/display-prices')
    expect(url.searchParams.get('item_ids')).toBe('77800,1')
    expect(url.searchParams.get('storage_unit_ids')).toBe(HEX)
    expect(url.searchParams.has('fallback')).toBe(false)
    expect(prices[0]).toMatchObject({
      itemId: '77800',
      tier: 'traded',
      price: '12.5',
      priceRaw: 12500000000n,
      bestBid: '12',
      fillsHere: 4,
      fillsThisItem: 9,
    })
    expect(prices[1]).toMatchObject({
      tier: 'unknown',
      price: null,
      priceRaw: null,
      poolId: null,
    })
  })

  it('only sends fallback when disabling it', async () => {
    const fetchMock = mockFetch([{ prices: [] }, { prices: [] }])
    await client.displayPrices({ itemIds: ['1'], fallback: false })
    await client.displayPrices({ itemIds: ['1'], fallback: true })
    expect(urlOf(fetchMock, 0).searchParams.get('fallback')).toBe('false')
    expect(urlOf(fetchMock, 1).searchParams.has('fallback')).toBe(false)
  })

  it('refuses a hub list that is neither one id nor one per item', async () => {
    const fetchMock = mockFetch([])
    await expect(
      client.displayPrices({
        itemIds: ['1', '2', '3'],
        storageUnitIds: [HEX, HEX],
      }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    await expect(
      client.displayPrices({
        itemIds: Array.from({ length: 101 }, (_, i) => String(i)),
      }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    expect(await client.displayPrices({ itemIds: [] })).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('tolerates a price tier added upstream', async () => {
    mockFetch([{ prices: [{ ...displayPrice, tier: 'oracle' }] }])
    const [price] = await client.displayPrices({ itemIds: ['77800'] })
    expect(price.tier).toBe('oracle')
  })

  it('prices one item at one hub and unwraps the single entry', async () => {
    const fetchMock = mockFetch([{ prices: [displayPrice] }])
    const price = await client.displayPrice('77800', {
      storageUnitId: HEX,
      fallback: false,
    })
    const url = urlOf(fetchMock)
    expect(url.pathname).toBe('/v1/display-prices/77800')
    expect(url.searchParams.get('storage_unit_id')).toBe(HEX)
    expect(url.searchParams.get('fallback')).toBe('false')
    expect(price.itemId).toBe('77800')
  })

  it('reports an empty single-item answer as UnexpectedResponse', async () => {
    mockFetch([{ prices: [] }])
    await expect(client.displayPrice('77800')).rejects.toMatchObject({
      code: TriexError.UnexpectedResponse,
    })
  })
})

describe('hubEconomics / topPoolsByFees / stats', () => {
  it('batches hub ids and parses raw amounts as bigints', async () => {
    const fetchMock = mockFetch([
      [
        {
          hub_id: HEX,
          fee_reserve: '1250000000',
          liquidity_depth: '48200',
          unique_items: 12,
        },
      ],
    ])
    const rows = await client.hubEconomics([HEX, '0xabc'])
    expect(urlOf(fetchMock).pathname).toBe('/v1/hubs/economics')
    expect(urlOf(fetchMock).searchParams.get('ids')).toBe(`${HEX},0xabc`)
    expect(rows).toEqual([
      {
        hubId: HEX,
        feeReserve: 1250000000n,
        liquidityDepth: 48200n,
        uniqueItems: 12,
      },
    ])
  })

  it('answers an empty hub list without a request', async () => {
    const fetchMock = mockFetch([])
    expect(await client.hubEconomics([])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ranks pools by unclaimed fees', async () => {
    const fetchMock = mockFetch([
      [
        {
          pool_id: HEX,
          // Verified live: indexed without the 0x prefix.
          quote_type: 'fbcbd9::cred::CRED',
          total_deposited: '4000000000',
          total_withdrawn: '1000000000',
          fees_available_to_claim: '3000000000',
        },
      ],
    ])
    const pools = await client.topPoolsByFees(3)
    expect(urlOf(fetchMock).pathname).toBe('/v1/pools/top-by-fees')
    expect(urlOf(fetchMock).searchParams.get('limit')).toBe('3')
    expect(pools[0]).toEqual({
      poolId: HEX,
      quoteType: 'fbcbd9::cred::CRED',
      totalDeposited: 4000000000n,
      totalWithdrawn: 1000000000n,
      feesAvailableToClaim: 3000000000n,
    })
  })

  it('parses platform statistics into camelCase', async () => {
    const volume = {
      quote_type: CRED,
      symbol: 'CRED',
      decimals: 6,
      raw: '100000000000',
      human: '100000',
      trades: 1,
    }
    const fetchMock = mockFetch([
      {
        computed_at: 1790871243522,
        marketplace: {
          trades: { all_time: 10, h24: 1, d7: 4 },
          active_traders: { all_time: 3, d7: 2 },
          open_orders: 22,
          traders_with_open_orders: 1,
          items_with_markets: 20,
          trade_hubs: 1,
          volume_all_time: [volume],
          volume_d7: [volume],
          top_items_d7: [
            {
              asset_id: '95679',
              trades: 1,
              units: '1',
              volume_raw: '100000000000',
              volume: '100000',
              quote_symbol: 'CRED',
            },
          ],
        },
        organizations: {
          total: 2,
          pilots_in_orgs: 13,
          org_units: 4,
          largest: [{ org_id: HEX, name: 'Northwind', member_count: 12 }],
        },
        storage: {
          org_vaults: 2,
          orgs_with_vaults: 2,
          hubs_with_storage: 1,
          pilots_with_access: 12,
        },
        pilots: { total: 1268, new_d7: 40 },
        series: {
          trades_daily_30d: [{ day_at: 1790812800000, trades: 1 }],
          new_pilots_daily_30d: [{ day_at: 1790812800000, pilots: 40 }],
        },
      },
    ])
    const stats = await client.stats()
    expect(urlOf(fetchMock).pathname).toBe('/v1/stats')
    expect(stats.computedAt).toBe(1790871243522)
    expect(stats.marketplace.trades).toEqual({ allTime: 10, h24: 1, d7: 4 })
    expect(stats.marketplace.volumeAllTime[0]).toMatchObject({
      raw: 100000000000n,
      human: '100000',
    })
    expect(stats.marketplace.topItemsD7[0]).toMatchObject({
      assetId: '95679',
      units: 1n,
      volumeRaw: 100000000000n,
    })
    expect(stats.organizations.largest[0]).toEqual({
      orgId: HEX,
      name: 'Northwind',
      memberCount: 12,
    })
    expect(stats.storage.pilotsWithAccess).toBe(12)
    expect(stats.pilots).toEqual({ total: 1268, newD7: 40 })
    expect(stats.series.tradesDaily30d).toEqual([
      { dayAt: 1790812800000, trades: 1 },
    ])
  })
})

// ─── Characters & tribes ─────────────────────────────────────────────────────

describe('characters', () => {
  it('reads one character and asks for enrichment by name', async () => {
    const fetchMock = mockFetch([
      { ...character, owner_cap_id: '0xcap', assembly_id: '0xasm' },
    ])
    const got = await client.character(HEX, { enrich: true })
    expect(urlOf(fetchMock).pathname).toBe(`/v1/characters/${HEX}`)
    expect(urlOf(fetchMock).searchParams.get('enrich')).toBe('true')
    expect(got).toEqual({
      characterId: HEX,
      itemId: '2112113391',
      tenant: 'stillness',
      tribeId: null,
      address: WALLET,
      name: 'Rin Farshot',
      description: 'A pilot.',
      url: 'https://example.test/rin.png',
      checkpointAt: 1755043200000,
      ownerCapId: '0xcap',
      assemblyId: '0xasm',
    })
  })

  it('leaves the enriched ids null when not asked for', async () => {
    const fetchMock = mockFetch([character])
    const got = await client.character(HEX)
    expect(urlOf(fetchMock).searchParams.has('enrich')).toBe(false)
    expect(got.ownerCapId).toBeNull()
    expect(got.assemblyId).toBeNull()
  })

  it('maps a 404 to CharacterNotFound', async () => {
    mock404({ message: 'No character found' })
    await expect(client.character(HEX)).rejects.toMatchObject({
      code: TriexError.CharacterNotFound,
    })
  })

  it('lists characters by address and by exact name', async () => {
    const fetchMock = mockFetch([[character, character], []])
    expect(
      await client.charactersByAddress(WALLET, { enrich: false }),
    ).toHaveLength(2)
    expect(await client.charactersByName('Rin Farshot')).toEqual([])
    expect(urlOf(fetchMock, 0).pathname).toBe(
      `/v1/characters/address/${WALLET}`,
    )
    expect(urlOf(fetchMock, 0).searchParams.get('enrich')).toBe('false')
    expect(urlOf(fetchMock, 1).pathname).toBe(
      '/v1/characters/name/Rin%20Farshot',
    )
  })

  it('batch-resolves addresses, keeping unresolved ones as null rows', async () => {
    const fetchMock = mockFetch([
      [
        {
          address: WALLET,
          object_id: HEX,
          character_address: WALLET,
          name: 'Rin Farshot',
          tribe_id: 98000001,
          tribe_name: 'Northwind',
        },
        {
          address: '0x1',
          object_id: null,
          character_address: null,
          name: null,
          tribe_id: null,
          tribe_name: null,
        },
      ],
    ])
    const rows = await client.charactersBatch([WALLET, '0x1'])
    expect(urlOf(fetchMock).pathname).toBe('/v1/characters/batch')
    expect(urlOf(fetchMock).searchParams.get('addresses')).toBe(`${WALLET},0x1`)
    expect(rows[0]).toEqual({
      address: WALLET,
      characterId: HEX,
      characterAddress: WALLET,
      name: 'Rin Farshot',
      tribeId: 98000001,
      tribeName: 'Northwind',
    })
    expect(rows[1]).toMatchObject({ address: '0x1', characterId: null })
  })

  it('refuses a batch over 500 and skips an empty one', async () => {
    const fetchMock = mockFetch([])
    await expect(
      client.charactersBatch(Array.from({ length: 501 }, () => WALLET)),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    expect(await client.charactersBatch([])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads a tribe from the world route, not the deprecated alias', async () => {
    const fetchMock = mockFetch([
      {
        tribe_id: 98000001,
        name: 'Northwind Collective',
        name_short: 'NWC',
        description: 'Traders.',
        tax_rate: 0.05,
        tribe_url: 'https://example.test',
      },
    ])
    const tribe = await client.tribe(98000001)
    expect(urlOf(fetchMock).pathname).toBe('/v1/world/tribes/98000001')
    expect(tribe).toEqual({
      tribeId: 98000001,
      name: 'Northwind Collective',
      nameShort: 'NWC',
      description: 'Traders.',
      taxRate: 0.05,
      tribeUrl: 'https://example.test',
    })
  })

  it('maps a missing tribe to TribeNotFound', async () => {
    mock404({ message: 'No tribe found for id 1' })
    await expect(client.tribe(1)).rejects.toMatchObject({
      code: TriexError.TribeNotFound,
    })
  })
})

// ─── World reference data ────────────────────────────────────────────────────

describe('world items & recipes', () => {
  it('converts the camelCase CDN item list to string assetIds', async () => {
    const fetchMock = mockFetch([
      [
        {
          id: 72244,
          name: 'Feral Data',
          description: '',
          mass: 0.1,
          radius: 1.0,
          volume: 0.1,
          portionSize: 1,
          groupName: 'Rogue Drone Analysis Data',
          groupId: 4142,
          categoryName: 'Commodity',
          categoryId: 17,
          iconUrl: '',
        },
        // Only the spec-required fields.
        {
          id: 1,
          name: 'Bare',
          groupId: 1,
          groupName: 'G',
          categoryId: 2,
          categoryName: 'C',
        },
      ],
    ])
    const items = await client.worldItems()
    expect(urlOf(fetchMock).pathname).toBe('/v1/world/items')
    expect(items[0]).toEqual({
      assetId: '72244',
      name: 'Feral Data',
      description: '',
      mass: 0.1,
      radius: 1,
      volume: 0.1,
      portionSize: 1,
      groupId: 4142,
      groupName: 'Rogue Drone Analysis Data',
      categoryId: 17,
      categoryName: 'Commodity',
      iconUrl: null, // "" on the wire means no icon
    })
    expect(items[1]).toMatchObject({
      assetId: '1',
      description: '',
      mass: null,
      iconUrl: null,
    })
  })

  it('reads one item, mapping a 404 to ItemNotFound', async () => {
    const fetchMock = mockFetch([
      {
        asset_id: '77800',
        name: 'Crustal Anorthosite Crystals',
        symbol: 'Silicate Regoliths',
      },
    ])
    expect(await client.worldItem('77800')).toEqual({
      assetId: '77800',
      name: 'Crustal Anorthosite Crystals',
      symbol: 'Silicate Regoliths',
    })
    expect(urlOf(fetchMock).pathname).toBe('/v1/world/items/77800')

    mock404({ message: 'Asset not found: 1' })
    await expect(client.worldItem('1')).rejects.toMatchObject({
      code: TriexError.ItemNotFound,
    })
  })

  const recipe = {
    productId: 77753,
    productName: 'Embark',
    outputQuantity: 1,
    time: 89,
    materials: [
      { id: 84180, name: 'Printed Circuits', quantity: 2 },
      { id: 88561, quantity: 4 },
    ],
  }

  it('parses recipes with string ids and a nullable craft time', async () => {
    const fetchMock = mockFetch([[recipe, { ...recipe, time: -1 }]])
    const recipes = await client.recipes()
    expect(urlOf(fetchMock).pathname).toBe('/v1/world/recipes')
    expect(recipes[0]).toEqual({
      productAssetId: '77753',
      productName: 'Embark',
      outputQuantity: 1,
      craftTimeSeconds: 89,
      materials: [
        { assetId: '84180', name: 'Printed Circuits', quantity: 2 },
        { assetId: '88561', name: null, quantity: 4 },
      ],
    })
    expect(recipes[1].craftTimeSeconds).toBeNull()
  })

  it('reads recipes for one product, and [] when nothing crafts it', async () => {
    const fetchMock = mockFetch([[recipe]])
    expect(await client.recipesFor('77753')).toHaveLength(1)
    expect(urlOf(fetchMock).pathname).toBe('/v1/world/recipes/77753')

    // The CDN answers "no recipe" with a 404 and an XML body.
    mock404()
    expect(await client.recipesFor('1')).toEqual([])
  })

  it('still surfaces non-404 failures from recipesFor', async () => {
    ;(global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    }))
    await expect(client.recipesFor('1')).rejects.toMatchObject({
      code: TriexError.IndexerError,
    })
  })
})

// ─── Routing ─────────────────────────────────────────────────────────────────

describe('routing', () => {
  it('maps every route parameter to its wire name', async () => {
    const fetchMock = mockFetch([route])
    const got = await client.route({
      origin: 'U4T-SL7',
      destination: 'U.L6B.HNX',
      optimization: 'fuel',
      mass: 2.5,
      gateWeight: 0.7,
      maxJumpRangeLy: 500,
    })

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
    expect(got).toMatchObject({
      optimization: 'fastest',
      totalJumps: 2,
      gateJumps: 1,
      driveJumps: 1,
      totalDistanceLy: 520.5,
      driveDistanceLy: 489.2796758851323,
    })
    expect(got.waypoints).toEqual([
      {
        solarSystemId: 30000001,
        solarSystemName: 'U4T-SL7',
        jumpType: 'start',
        distanceLy: null,
      },
      {
        solarSystemId: 30002493,
        solarSystemName: null, // not yet reported by any player
        jumpType: 'jump_drive',
        distanceLy: 489.2796758851323,
      },
      {
        solarSystemId: 30016469,
        solarSystemName: null,
        jumpType: 'stargate',
        distanceLy: null,
      },
    ])
  })

  it('maps an unknown name or unreachable pair to RouteNotFound', async () => {
    mock404({
      error: 'not_found',
      message:
        "origin solar system 'NOPE' not found (its name may not have been reported yet)",
    })
    await expect(
      client.route({ origin: 'NOPE', destination: 'X' }),
    ).rejects.toMatchObject({
      code: TriexError.RouteNotFound,
      message: expect.stringContaining('may not have been reported'),
    })
  })

  it('compares all three modes without sending an optimization', async () => {
    const fetchMock = mockFetch([
      {
        fuel_efficient: { ...route, optimization: 'fuel_efficient' },
        fastest: route,
        balanced: { ...route, optimization: 'balanced' },
      },
    ])
    const cmp = await client.compareRoutes({
      origin: 'A',
      destination: 'B',
      gateWeight: 0.2,
    })
    const url = urlOf(fetchMock)
    expect(url.pathname).toBe('/v1/routing/compare')
    expect(url.searchParams.has('optimization')).toBe(false)
    expect(url.searchParams.get('gate_weight')).toBe('0.2')
    expect(cmp.fuelEfficient.optimization).toBe('fuel_efficient')
    expect(cmp.fastest.optimization).toBe('fastest')
    expect(cmp.balanced.optimization).toBe('balanced')
  })

  it('reports routing-graph coverage', async () => {
    const fetchMock = mockFetch([
      {
        connected_systems: 24022,
        stargate_edges: 7072,
        jump_drive_edges: 0,
        max_jump_range_ly: 60.0,
      },
    ])
    expect(await client.routingStats()).toEqual({
      connectedSystems: 24022,
      stargateEdges: 7072,
      jumpDriveEdges: 0,
      maxJumpRangeLy: 60,
    })
    expect(urlOf(fetchMock).pathname).toBe('/v1/routing/stats')
  })
})

// ─── Cycle-7 player-reported solar system names ──────────────────────────────

/**
 * location-api's cycle-7 change makes `solar_system_name` nullable on single
 * and nearby-origin system reads and adds `known_solar_system_names` to the
 * stats. The gateway spec has not caught up, so both the published shape and
 * the post-deploy shape must parse.
 */
describe('solar system names before and after the cycle-7 change', () => {
  const system = {
    solar_system_id: 30000142,
    location: { x: '1', y: '2', z: '3' },
    constellation_id: 20000011,
    region_id: 10000005,
  }

  it.each([
    ['published shape (string)', { solar_system_name: 'EHK-KH7' }, 'EHK-KH7'],
    ['post-deploy shape (null)', { solar_system_name: null }, null],
    ['key absent', {}, null],
  ])('SolarSystem: %s', async (_label, name, expected) => {
    mockFetch([{ ...system, ...name }])
    const got = await client.solarSystem('30000142')
    expect(got.solarSystemName).toBe(expected)
  })

  it('accepts a nearby-search origin with a missing name', async () => {
    mockFetch([
      { solar_system_id: 30000142, radius_ly: '10', count: 0, systems: [] },
    ])
    const got = await client.nearbySystems({
      solarSystem: '30000142',
      radiusLy: 10,
    })
    expect(got.originSolarSystemName).toBeNull()
  })

  it('reports knownSolarSystemNames when present and null on older builds', async () => {
    mockFetch([
      {
        total_systems: 24018,
        known_solar_system_names: 117,
        status: 'operational',
      },
      { total_systems: 24018, status: 'operational' },
    ])
    expect(await client.spatialStats()).toEqual({
      totalSystems: 24018,
      knownSolarSystemNames: 117,
      status: 'operational',
    })
    expect((await client.spatialStats()).knownSolarSystemNames).toBeNull()
  })
})

// ─── Paging ──────────────────────────────────────────────────────────────────

describe('iterators', () => {
  it('iterateRecentTrades passes nextCursor back as before and stops on null', async () => {
    const fetchMock = mockFetch([
      {
        data: [
          { ...recentTrade, traded_at: 30 },
          { ...recentTrade, traded_at: 20 },
        ],
        next_cursor: '20',
      },
      { data: [{ ...recentTrade, traded_at: 10 }], next_cursor: null },
    ])
    const seen: number[] = []
    for await (const t of iterateRecentTrades(client, { assetId: '95679' })) {
      seen.push(t.tradedAt)
    }
    expect(seen).toEqual([30, 20, 10])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(urlOf(fetchMock, 1).searchParams.get('before')).toBe('20')
    expect(urlOf(fetchMock, 1).searchParams.get('item_id')).toBe('95679')
  })

  it('iterateFills stops on a null cursor instead of paying for an empty page', async () => {
    const fill = {
      event_digest: 'd',
      pool_id: HEX,
      order_id: '1',
      counterparty_trading_account_id: HEX,
      price: '1',
      base_quantity: '1',
      quote_quantity: '1',
      fee: '0',
      role: 'maker',
      taker_is_bid: true,
      filled_at: 5,
    }
    const fetchMock = mockFetch([{ data: [fill], next_cursor: null }])
    const seen = []
    for await (const f of iterateFills(client, HEX)) seen.push(f)
    expect(seen).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('iterateOpenOrders walks by updatedAt', async () => {
    const order = {
      pool_id: HEX,
      order_id: U128,
      side: 'buy',
      price: '1',
      remaining_quantity: '1',
      filled_quantity: '0',
      expires_at: 1,
      updated_at: 50,
      asset_id: '1',
      storage_unit_id: HEX,
      quote_asset_symbol: 'CRED',
      quote_asset_decimals: 6,
    }
    const fetchMock = mockFetch([
      { data: [order], next_cursor: '50' },
      { data: [{ ...order, updated_at: 40 }], next_cursor: null },
    ])
    const seen: number[] = []
    for await (const o of iterateOpenOrders(client, HEX)) seen.push(o.updatedAt)
    expect(seen).toEqual([50, 40])
    expect(urlOf(fetchMock, 1).searchParams.get('before')).toBe('50')
  })

  it('iterateHubLocations and iterateItemLocations follow the opaque cursor', async () => {
    const placement = {
      hub_id: HEX,
      assembly_item_id: '1',
      assembly_tenant: 'stillness',
      type_id: '1',
      owner_cap_id: '0xcap',
      owner: null,
      solar_system: '',
      x: '0',
      y: '0',
      z: '0',
      updated_at: 1,
      tx_digest: 'd',
      is_public: false,
      region_id: null,
      solar_system_name: null,
    }
    let fetchMock = mockFetch([
      { data: [placement], next_cursor: 'MTAw' },
      { data: [placement], next_cursor: null },
    ])
    const hubs = []
    for await (const h of iterateHubLocations(client, { hasVault: true })) {
      hubs.push(h)
    }
    expect(hubs).toHaveLength(2)
    expect(urlOf(fetchMock, 1).searchParams.get('cursor')).toBe('MTAw')
    expect(urlOf(fetchMock, 1).searchParams.get('has_vault')).toBe('true')

    fetchMock = mockFetch([
      { data: [placement, placement], next_cursor: 'MjAw' },
      { data: [placement], next_cursor: null },
    ])
    const sellers = []
    for await (const h of iterateItemLocations(client, '70810', undefined, {
      maxItems: 2,
    })) {
      sellers.push(h)
    }
    // maxItems caps the walk before the second page is requested.
    expect(sellers).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ─── Client surfaces ─────────────────────────────────────────────────────────

/** Answer every request with the payload whose path matches. */
function routeFetch(routes: Array<[string, unknown]>): jest.Mock {
  const fn = jest.fn(async (url: unknown) => {
    const hit = routes.find(([p]) => (url as URL).pathname === p)
    return hit
      ? { ok: true, status: 200, statusText: 'OK', json: async () => hit[1] }
      : {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({}),
        }
  })
  ;(global as any).fetch = fn
  return fn
}

const statsPayload = {
  computed_at: 1,
  marketplace: {
    trades: { all_time: 0, h24: 0, d7: 0 },
    active_traders: { all_time: 0, d7: 0 },
    open_orders: 0,
    traders_with_open_orders: 0,
    items_with_markets: 0,
    trade_hubs: 0,
    volume_all_time: [],
    volume_d7: [],
    top_items_d7: [],
  },
  organizations: { total: 0, pilots_in_orgs: 0, org_units: 0, largest: [] },
  storage: {
    org_vaults: 0,
    orgs_with_vaults: 0,
    hubs_with_storage: 0,
    pilots_with_access: 0,
  },
  pilots: { total: 0, new_d7: 0 },
  series: { trades_daily_30d: [], new_pilots_daily_30d: [] },
}

describe('ReadOnlyClient reaches every new read', () => {
  const ro = new ReadOnlyClient({
    apiKey: 'k',
    indexerUrl: 'https://api.example.test',
  })

  it.each<[string, () => Promise<unknown>, string, unknown]>([
    [
      'order',
      () => ro.order({ poolId: HEX, orderId: '1' }),
      `/v1/pools/${HEX}/orders/1`,
      orderDetail,
    ],
    ['fill', () => ro.fill('d1'), '/v1/fills/d1', fillDetail],
    [
      'recentTrades',
      () => ro.recentTrades(),
      '/v1/trades/recent',
      { data: [], next_cursor: null },
    ],
    [
      'displayPrices',
      () => ro.displayPrices({ itemIds: ['1'] }),
      '/v1/display-prices',
      { prices: [] },
    ],
    [
      'displayPrice',
      () => ro.displayPrice('77800'),
      '/v1/display-prices/77800',
      { prices: [displayPrice] },
    ],
    [
      'hubEconomics',
      () => ro.hubEconomics({ hubIds: [HEX] }),
      '/v1/hubs/economics',
      [],
    ],
    ['topPoolsByFees', () => ro.topPoolsByFees(), '/v1/pools/top-by-fees', []],
    ['stats', () => ro.stats(), '/v1/stats', statsPayload],
    ['character', () => ro.character(HEX), `/v1/characters/${HEX}`, character],
    [
      'charactersByAddress',
      () => ro.charactersByAddress(WALLET),
      `/v1/characters/address/${WALLET}`,
      [],
    ],
    [
      'charactersByName',
      () => ro.charactersByName('Rin'),
      '/v1/characters/name/Rin',
      [],
    ],
    [
      'charactersBatch',
      () => ro.charactersBatch({ addresses: [WALLET] }),
      '/v1/characters/batch',
      [],
    ],
    [
      'tribe',
      () => ro.tribe(7),
      '/v1/world/tribes/7',
      {
        tribe_id: 7,
        name: 'T',
        name_short: 'T',
        description: '',
        tax_rate: 0,
        tribe_url: '',
      },
    ],
    ['worldItems', () => ro.worldItems(), '/v1/world/items', []],
    [
      'worldItem',
      () => ro.worldItem('1'),
      '/v1/world/items/1',
      { asset_id: '1', name: null, symbol: null },
    ],
    ['recipes', () => ro.recipes(), '/v1/world/recipes', []],
    ['recipesFor', () => ro.recipesFor('1'), '/v1/world/recipes/1', []],
    [
      'route',
      () => ro.route({ origin: 'A', destination: 'B' }),
      '/v1/routing/route',
      route,
    ],
    [
      'compareRoutes',
      () => ro.compareRoutes({ origin: 'A', destination: 'B' }),
      '/v1/routing/compare',
      { fuel_efficient: route, fastest: route, balanced: route },
    ],
    [
      'routingStats',
      () => ro.routingStats(),
      '/v1/routing/stats',
      {
        connected_systems: 1,
        stargate_edges: 1,
        jump_drive_edges: 1,
        max_jump_range_ly: 1,
      },
    ],
  ])('%s', async (_name, call, path, payload) => {
    const fetchMock = routeFetch([[path, payload]])
    await call()
    expect(urlOf(fetchMock).pathname).toBe(path)
  })
})

describe('TriexClient groups', () => {
  const make = (address?: string) =>
    new TriexClient({
      suiClient: {} as any,
      apiKey: 'k',
      indexerUrl: 'https://api.example.test',
      address,
    })

  it.each<[string, (c: TriexClient) => Promise<unknown>, string, unknown]>([
    [
      'market.recentTrades',
      (c) => c.market.recentTrades(),
      '/v1/trades/recent',
      { data: [], next_cursor: null },
    ],
    [
      'market.displayPrices',
      (c) => c.market.displayPrices({ itemIds: ['1'] }),
      '/v1/display-prices',
      { prices: [] },
    ],
    [
      'market.displayPrice',
      (c) => c.market.displayPrice('77800'),
      '/v1/display-prices/77800',
      { prices: [displayPrice] },
    ],
    [
      'market.hubEconomics',
      (c) => c.market.hubEconomics({ hubIds: [HEX] }),
      '/v1/hubs/economics',
      [],
    ],
    [
      'market.topPoolsByFees',
      (c) => c.market.topPoolsByFees({ limit: 5 }),
      '/v1/pools/top-by-fees',
      [],
    ],
    ['market.stats', (c) => c.market.stats(), '/v1/stats', statsPayload],
    [
      'orders.get',
      (c) => c.orders.get({ poolId: HEX, orderId: 1n }),
      `/v1/pools/${HEX}/orders/1`,
      orderDetail,
    ],
    ['orders.fill', (c) => c.orders.fill('d1'), '/v1/fills/d1', fillDetail],
    [
      'characters.get',
      (c) => c.characters.get(HEX),
      `/v1/characters/${HEX}`,
      character,
    ],
    [
      'characters.byName',
      (c) => c.characters.byName('Rin'),
      '/v1/characters/name/Rin',
      [],
    ],
    [
      'characters.batch',
      (c) => c.characters.batch({ addresses: [WALLET] }),
      '/v1/characters/batch',
      [],
    ],
    [
      'characters.tribe',
      (c) => c.characters.tribe(7),
      '/v1/world/tribes/7',
      {
        tribe_id: 7,
        name: 'T',
        name_short: 'T',
        description: '',
        tax_rate: 0,
        tribe_url: '',
      },
    ],
    ['world.items', (c) => c.world.items(), '/v1/world/items', []],
    [
      'world.item',
      (c) => c.world.item('1'),
      '/v1/world/items/1',
      { asset_id: '1', name: null, symbol: null },
    ],
    ['world.recipes', (c) => c.world.recipes(), '/v1/world/recipes', []],
    [
      'world.recipesFor',
      (c) => c.world.recipesFor('1'),
      '/v1/world/recipes/1',
      [],
    ],
    [
      'routing.route',
      (c) => c.routing.route({ origin: 'A', destination: 'B' }),
      '/v1/routing/route',
      route,
    ],
    [
      'routing.compare',
      (c) => c.routing.compare({ origin: 'A', destination: 'B' }),
      '/v1/routing/compare',
      { fuel_efficient: route, fastest: route, balanced: route },
    ],
    [
      'routing.stats',
      (c) => c.routing.stats(),
      '/v1/routing/stats',
      {
        connected_systems: 1,
        stargate_edges: 1,
        jump_drive_edges: 1,
        max_jump_range_ly: 1,
      },
    ],
  ])('%s', async (_name, call, path, payload) => {
    const fetchMock = routeFetch([[path, payload]])
    await call(make())
    expect(urlOf(fetchMock).pathname).toBe(path)
  })

  it('characters.byAddress defaults to the configured player', async () => {
    const fetchMock = routeFetch([[`/v1/characters/address/${WALLET}`, []]])
    await make(WALLET).characters.byAddress()
    expect(urlOf(fetchMock).pathname).toBe(`/v1/characters/address/${WALLET}`)

    const other = '0xabc'
    const fetchMock2 = routeFetch([[`/v1/characters/address/${other}`, []]])
    await make(WALLET).characters.byAddress(other, { enrich: true })
    expect(urlOf(fetchMock2).searchParams.get('enrich')).toBe('true')
  })

  it('characters.byAddress needs an address from somewhere', async () => {
    const fetchMock = routeFetch([])
    await expect(make().characters.byAddress()).rejects.toBeInstanceOf(
      TriexClientError,
    )
    await expect(make().characters.byAddress()).rejects.toMatchObject({
      code: TriexError.AddressRequired,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

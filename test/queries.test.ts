import { jest } from '@jest/globals'
import { IndexerClient } from '../src/queries'
import { TriexClient } from '../src/TriexClient'
import { TriexClientError, TriexError } from '../src/errors'

const HEX = '0x7f3a9b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8'

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

afterEach(() => {
  jest.restoreAllMocks()
})

describe('IndexerClient request building', () => {
  it('sends x-api-key and maps discovery filters to spec param names', async () => {
    const fetchMock = mockFetch([
      { data: [], next_cursor: null, prev_cursor: null },
    ])
    const client = new IndexerClient('https://api.example.test', 'sekret')
    await client.discovery({
      storageUnitIds: [HEX, '0xabc'],
      assetId: '70810',
      side: 'buy',
      publicOnly: true,
      limit: 20,
    })

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(String(url)).toContain('/v1/discovery')
    expect(url.searchParams.get('storage_unit_ids')).toBe(`${HEX},0xabc`)
    expect(url.searchParams.get('asset_id')).toBe('70810')
    expect(url.searchParams.get('side')).toBe('buy')
    expect(url.searchParams.get('public_only')).toBe('true')
    expect(url.searchParams.get('limit')).toBe('20')
    expect(url.searchParams.has('cursor')).toBe(false)
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sekret')
  })

  it('searchItems sends q + limit and parses the results page', async () => {
    const fetchMock = mockFetch([
      {
        data: [
          {
            asset_id: '84210',
            name: 'Carbon Weave',
            symbol: 'Manufacturing Component',
            mass: 30000,
            recipes: [
              {
                output_quantity: 1,
                components: [{ asset_id: '78429', quantity: 4 }],
              },
            ],
          },
        ],
      },
    ])
    const client = new IndexerClient('https://api.example.test', 'k')
    const page = await client.searchItems('carbon', 5)

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(String(url)).toContain('/v1/world/items/search')
    expect(url.searchParams.get('q')).toBe('carbon')
    expect(url.searchParams.get('limit')).toBe('5')
    expect(page.items[0]).toEqual({
      assetId: '84210',
      name: 'Carbon Weave',
      symbol: 'Manufacturing Component',
      mass: 30000,
      recipes: [
        {
          outputQuantity: 1,
          components: [{ assetId: '78429', quantity: 4 }],
        },
      ],
    })
  })

  it('searchItems omits limit when not given', async () => {
    const fetchMock = mockFetch([{ data: [] }])
    const client = new IndexerClient('https://api.example.test', 'k')
    await client.searchItems('ore')

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.searchParams.has('limit')).toBe(false)
  })

  it('resolvePool passes collection_id + asset_id and surfaces a null miss', async () => {
    const fetchMock = mockFetch([{ pool_id: null }])
    const client = new IndexerClient('https://api.example.test', 'k')
    const poolId = await client.resolvePool({
      collectionId: HEX,
      assetId: '70810',
    })
    expect(poolId).toBeNull()
    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.searchParams.get('collection_id')).toBe(HEX)
    expect(url.searchParams.get('asset_id')).toBe('70810')
  })

  it('maps order-status paging params (before/after/limit)', async () => {
    const fetchMock = mockFetch([{ data: [], next_cursor: null }])
    const client = new IndexerClient('https://api.example.test', 'k')
    await client.openOrders(HEX, { before: 200, after: 100, limit: 50 })
    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(String(url)).toContain(`/v1/balance-managers/${HEX}/open-orders`)
    expect(url.searchParams.get('before')).toBe('200')
    expect(url.searchParams.get('after')).toBe('100')
    expect(url.searchParams.get('limit')).toBe('50')
  })

  it('maps HTTP statuses to specific typed codes', async () => {
    const respond = (
      status: number,
      statusText: string,
      body: unknown,
      headers?: Record<string, string>,
    ) => {
      ;(global as any).fetch = jest.fn(async () => ({
        ok: false,
        status,
        statusText,
        headers: { get: (k: string) => headers?.[k.toLowerCase()] ?? null },
        json: async () => body,
      }))
    }
    const client = new IndexerClient('https://api.example.test', 'k')

    // 401/403 → Unauthorized
    respond(401, 'Unauthorized', { error: 'bad key' })
    await expect(client.discovery()).rejects.toMatchObject({
      code: TriexError.Unauthorized,
      status: 401,
    })

    // 429 → RateLimited with retryAfterMs from Retry-After
    respond(429, 'Too Many Requests', {}, { 'retry-after': '2' })
    await expect(client.discovery()).rejects.toMatchObject({
      code: TriexError.RateLimited,
      status: 429,
      retryAfterMs: 2000,
    })

    // 404 → per-endpoint code
    respond(404, 'Not Found', { message: 'no such hub' })
    await expect(client.hubVault(HEX)).rejects.toMatchObject({
      code: TriexError.HubNotFound,
    })
    respond(404, 'Not Found', {})
    await expect(client.poolMetadata(HEX)).rejects.toMatchObject({
      code: TriexError.PoolNotFound,
    })
    respond(404, 'Not Found', {})
    await expect(client.openOrders(HEX)).rejects.toMatchObject({
      code: TriexError.BalanceManagerNotFound,
    })

    // 5xx → IndexerError, with the server's message surfaced
    respond(500, 'Internal Server Error', { message: 'db exploded' })
    await expect(client.discovery()).rejects.toMatchObject({
      code: TriexError.IndexerError,
      status: 500,
      message: expect.stringContaining('db exploded'),
    })
  })

  it('requires an apiKey before any request', async () => {
    const fetchMock = mockFetch([])
    const client = new IndexerClient('https://api.example.test', '')
    await expect(client.hubVault(HEX)).rejects.toMatchObject({
      code: TriexError.ApiKeyRequired,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('TriexClient.market composition', () => {
  const config = {
    suiClient: {} as any,
    apiKey: 'k',
    indexerUrl: 'https://api.example.test',
  }

  it('orderbook() fetches the combined hub-item endpoint in one call', async () => {
    const fetchMock = mockFetch([
      {
        hub_id: HEX,
        collection_id: '0xc0ffee',
        vault_config_id: HEX,
        pool_id: '0xp001',
        metadata: null,
        bids: [],
        asks: [],
      },
    ])
    const client = new TriexClient(config)
    const book = await client.market.orderbook({
      storageUnitId: HEX,
      assetId: '70810',
    })
    expect(book).toEqual({
      hubId: HEX,
      collectionId: '0xc0ffee',
      vaultConfigId: HEX,
      poolId: '0xp001',
      metadata: null,
      bids: [],
      asks: [],
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(String(url)).toContain(`/v1/hubs/${HEX}/items/70810/orderbook`)
  })

  it('orderbook() throws PoolNotFound when no market exists', async () => {
    mockFetch([
      {
        hub_id: HEX,
        collection_id: '0xc0ffee',
        vault_config_id: HEX,
        pool_id: null,
        metadata: null,
        bids: [],
        asks: [],
      },
    ])
    const client = new TriexClient(config)
    await expect(
      client.market.orderbook({ storageUnitId: HEX, assetId: '1' }),
    ).rejects.toMatchObject({ code: TriexError.PoolNotFound })
  })

  it('hub() pairs the vault descriptor with the location record', async () => {
    mockFetch([
      { hub_id: HEX, collection_id: '0xc0ffee', vault_config_id: '0xcfg' },
      {
        hub_id: HEX,
        assembly_item_id: '1',
        assembly_tenant: 'stillness',
        type_id: '2',
        owner_cap_id: '0xcap',
        owner: null,
        solar_system: '3',
        x: '0',
        y: '0',
        z: '0',
        updated_at: 1,
        tx_digest: 'd',
        is_public: false,
        region_id: null,
        solar_system_name: null,
      },
    ])
    const client = new TriexClient(config)
    const hub = await client.market.hub(HEX)
    expect(hub.collectionId).toBe('0xc0ffee')
    expect(hub.vaultConfigId).toBe('0xcfg')
    expect(hub.location?.ownerCapId).toBe('0xcap')
    expect(hub.location?.isPublic).toBe(false)
  })

  it('hub() returns a null location for unrevealed hubs (etl-api 404s them)', async () => {
    const payloads: unknown[] = [
      { hub_id: HEX, collection_id: '0xc0ffee', vault_config_id: '0xcfg' },
    ]
    ;(global as any).fetch = jest.fn(async (url: unknown) =>
      String(url).includes('/location')
        ? {
            ok: false,
            status: 404,
            statusText: 'Not Found',
            json: async () => ({
              message: 'No location found',
              statusCode: 404,
            }),
          }
        : {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => payloads.shift(),
          },
    )
    const client = new TriexClient(config)
    const hub = await client.market.hub(HEX)
    expect(hub.vaultConfigId).toBe('0xcfg')
    expect(hub.location).toBeNull()
  })
})

describe('error surface', () => {
  it('TriexClientError carries a stable code', () => {
    const err = new TriexClientError(TriexError.PoolNotFound, 'nope')
    expect(err.code).toBe('TRIEX_POOL_NOT_FOUND')
    expect(err).toBeInstanceOf(Error)
  })
})

/**
 * The `Marketplace | Locations` surface.
 *
 * These reads exist to answer "where is it / who owns it", and every one of
 * them is a query-parameter mapping away from being silently wrong: the
 * gateway ignores keys it does not recognise, so a misnamed filter returns a
 * cheerful, fully unfiltered 200. The assertions below pin the wire names.
 */
describe('IndexerClient location reads', () => {
  const client = new IndexerClient('https://api.example.test', 'k')

  /** One hub-placement row, as the gateway sends it. */
  const placement = {
    hub_id: HEX,
    assembly_item_id: '84955',
    assembly_tenant: 'nova',
    type_id: '84955',
    owner_cap_id: '0xcap',
    owner: '0xowner',
    solar_system: '30000142',
    x: '-91233855488',
    y: '7137397760',
    z: '120689905664',
    updated_at: 1755043200000,
    tx_digest: 'AbC123',
    is_public: true,
    region_id: 10000002,
  }

  it('maps hubLocations filters to the spec parameter names', async () => {
    const fetchMock = mockFetch([{ data: [], next_cursor: null }])
    await client.hubLocations({
      solarSystemId: 30000142,
      tenant: 'nova',
      hasVault: true,
      limit: 25,
      cursor: 'MTAw',
    })

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.pathname).toBe('/v1/hubs/locations')
    expect(url.searchParams.get('solar_system')).toBe('30000142')
    expect(url.searchParams.get('tenant')).toBe('nova')
    expect(url.searchParams.get('has_vault')).toBe('true')
    expect(url.searchParams.get('limit')).toBe('25')
    expect(url.searchParams.get('cursor')).toBe('MTAw')
  })

  it('parses a location page into camelCase with its cursor', async () => {
    mockFetch([
      {
        data: [{ ...placement, solar_system_name: 'Nod' }],
        next_cursor: 'MTAw',
      },
    ])
    const page = await client.hubLocations()
    expect(page.nextCursor).toBe('MTAw')
    expect(page.locations[0]).toMatchObject({
      hubId: HEX,
      assemblyTenant: 'nova',
      solarSystemId: '30000142',
      solarSystemName: 'Nod',
      isPublic: true,
      regionId: 10000002,
      txDigest: 'AbC123',
    })
  })

  it('puts the item id in the path, not the query, for itemLocations', async () => {
    const fetchMock = mockFetch([{ data: [], next_cursor: null }])
    await client.itemLocations('70810', { limit: 10 })

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.pathname).toBe('/v1/items/70810/locations')
    expect(url.searchParams.get('limit')).toBe('10')
    expect(url.searchParams.has('item_id')).toBe(false)
  })

  it('sends range and type_id for a nearby search and keeps the distance', async () => {
    const fetchMock = mockFetch([
      [{ ...placement, solar_system_name: 'Nod', distance_ly: '42.5' }],
    ])
    const hubs = await client.nearbyHubs({
      hubId: HEX,
      rangeLy: 500,
      assetId: '70810',
    })

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.pathname).toBe(`/v1/hubs/${HEX}/nearby`)
    expect(url.searchParams.get('range')).toBe('500')
    expect(url.searchParams.get('type_id')).toBe('70810')
    expect(hubs[0].distanceLy).toBe('42.5')
    expect(hubs[0].hubId).toBe(HEX)
  })

  it('sends the system origin as system_id for the by-system search', async () => {
    const fetchMock = mockFetch([[]])
    await client.nearbyHubsBySystem({ solarSystem: 'Nod', rangeLy: 100 })

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.pathname).toBe('/v1/hubs/nearby-by-system')
    expect(url.searchParams.get('system_id')).toBe('Nod')
    expect(url.searchParams.get('range')).toBe('100')
  })

  it('joins batch ids into one comma-separated ids parameter', async () => {
    const fetchMock = mockFetch([
      [{ ...placement, pool_count: 3, last_activity_at: null }],
    ])
    const hubs = await client.hubsEnriched([HEX, '0xabc'])

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.pathname).toBe('/v1/hubs/enriched')
    expect(url.searchParams.get('ids')).toBe(`${HEX},0xabc`)
    expect(hubs[0]).toMatchObject({ poolCount: 3, lastActivityAt: null })
    // This endpoint resolves no display name — that is what solarSystemNames is for.
    expect(hubs[0]).not.toHaveProperty('solarSystemName')
  })

  it('parses assembly, balance-manager and solar-system batch reads', async () => {
    mockFetch([
      [{ assembly_id: '0xass', owner: '0xowner' }],
      [
        {
          assembly_id: '0xass',
          owner: '0xowner',
          owner_character_name: 'Pilot',
          owner_character_id: '0xchar',
          assembly_name: 'Depot',
        },
      ],
      [
        {
          balance_manager_id: HEX,
          owner: 'ou:0xorg',
          owner_name: 'Loash Industries',
          root_ou_id: '0xroot',
        },
      ],
      [{ solar_system_id: 30000142, solar_system_name: 'Nod' }],
    ])

    expect(await client.assemblyOwners(['0xass'])).toEqual([
      { assemblyId: '0xass', owner: '0xowner' },
    ])
    expect((await client.assembliesEnriched(['0xass']))[0]).toMatchObject({
      ownerCharacterName: 'Pilot',
      assemblyName: 'Depot',
    })
    expect((await client.balanceManagerOwners([HEX]))[0]).toEqual({
      balanceManagerId: HEX,
      owner: 'ou:0xorg',
      ownerName: 'Loash Industries',
      rootOuId: '0xroot',
    })
    expect(await client.solarSystemNames([30000142])).toEqual([
      { solarSystemId: 30000142, solarSystemName: 'Nod' },
    ])
  })

  it('answers an empty id list without spending a request', async () => {
    // A 200-id batch endpoint given nothing to resolve would otherwise 400 —
    // and still cost the caller its compute units.
    const fetchMock = mockFetch([])
    expect(await client.hubsEnriched([])).toEqual([])
    expect(await client.assemblyOwners([])).toEqual([])
    expect(await client.assembliesEnriched([])).toEqual([])
    expect(await client.balanceManagerOwners([])).toEqual([])
    expect(await client.solarSystemNames([])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a private origin hub as HubNotFound rather than a generic error', async () => {
    ;(global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ message: 'No location found for assembly' }),
    }))
    await expect(client.nearbyHubs({ hubId: HEX })).rejects.toMatchObject({
      code: TriexError.HubNotFound,
    })
  })
})

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

  it('orderbook() chains hub vault → pool resolve → orderbook', async () => {
    const fetchMock = mockFetch([
      { hub_id: HEX, collection_id: '0xc0ffee', vault_config_id: HEX },
      { pool_id: '0xp001' },
      { bids: [], asks: [] },
    ])
    const client = new TriexClient(config)
    const book = await client.market.orderbook({
      storageUnitId: HEX,
      assetId: '70810',
    })
    expect(book).toEqual({ poolId: '0xp001', bids: [], asks: [] })

    const calls = fetchMock.mock.calls.map((c: any[]) => String(c[0]))
    expect(calls[0]).toContain(`/v1/hubs/${HEX}/vault`)
    expect(calls[1]).toContain('/v1/pools/resolve')
    expect(calls[1]).toContain('collection_id=0xc0ffee')
    expect(calls[2]).toContain('/v1/pools/0xp001/orderbook')
  })

  it('orderbook() throws PoolNotFound when no market exists', async () => {
    mockFetch([
      { hub_id: HEX, collection_id: '0xc0ffee', vault_config_id: HEX },
      { pool_id: null },
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

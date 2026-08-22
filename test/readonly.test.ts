import { jest } from '@jest/globals'
import { ReadOnlyClient } from '../src/ReadOnlyClient'
import { IndexerClient } from '../src/queries'
import { iterateTrades } from '../src/paging'

const HEX = '0x7f3a9b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8'

function routeFetch(routes: Array<[string, unknown]>): jest.Mock {
  const fn = jest.fn(async (url: unknown) => {
    const hit = routes.find(([p]) => String(url).includes(p))
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

afterEach(() => jest.restoreAllMocks())

describe('ReadOnlyClient', () => {
  const ro = new ReadOnlyClient({
    apiKey: 'k',
    indexerUrl: 'https://api.example.test',
  })

  it('fetches the combined hub-item orderbook in one call like the full client', async () => {
    const fetchMock = routeFetch([
      [
        '/orderbook',
        {
          hub_id: HEX,
          collection_id: '0xc0ffee',
          vault_config_id: HEX,
          pool_id: '0x' + '10'.repeat(32),
          metadata: null,
          bids: [],
          asks: [],
        },
      ],
    ])
    const book = await ro.orderbook({ storageUnitId: HEX, assetId: '70810' })
    expect(book.poolId).toBe('0x' + '10'.repeat(32))
    expect(book.collectionId).toBe('0xc0ffee')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('parses the sweepable manifest', async () => {
    routeFetch([
      [
        '/sweepable',
        {
          balance_manager_id: HEX,
          as_of_checkpoint: '9',
          pools: [],
          items: [
            {
              collection_id: HEX,
              asset_id: '70810',
              amount: '5',
              storage_unit_id: HEX,
              vault_config_id: HEX,
            },
          ],
        },
      ],
    ])
    const m = await ro.sweepable(HEX)
    expect(m.items[0].amount).toBe(5n)
    expect(m.asOfCheckpoint).toBe('9')
  })
})

describe('IndexerClient remaining param mappings', () => {
  const client = new IndexerClient('https://api.example.test', 'k')

  it('inventoryBalances maps all selector params', async () => {
    const fetchMock = routeFetch([
      [
        '/v1/inventory/balances',
        {
          storage_unit_id: HEX,
          collection_id: HEX,
          warehouse: [],
          marketplace: [],
          hangar: [],
          org_vaults: {},
        },
      ],
    ])
    await client.inventoryBalances({
      storageUnitId: HEX,
      address: '0xowner',
      balanceManagerId: '0xbm',
      inventoryKey: '0xcap',
      vaultIds: ['0xv1', '0xv2'],
    })
    const url = fetchMock.mock.calls[0][0] as URL
    expect(url.searchParams.get('storage_unit_id')).toBe(HEX)
    expect(url.searchParams.get('owner_address')).toBe('0xowner')
    expect(url.searchParams.get('balance_manager_id')).toBe('0xbm')
    expect(url.searchParams.get('inventory_key')).toBe('0xcap')
    expect(url.searchParams.get('vault_ids')).toBe('0xv1,0xv2')
  })

  it('fills and trades map their filter params', async () => {
    const fetchMock = routeFetch([['/fills', { data: [], next_cursor: null }]])
    await client.fills(HEX, { poolId: '0xp', side: 'maker', limit: 5 })
    let url = fetchMock.mock.calls[0][0] as URL
    expect(url.searchParams.get('pool_id')).toBe('0xp')
    expect(url.searchParams.get('side')).toBe('maker')

    const fetchMock2 = routeFetch([
      ['/trades', { data: [], next_cursor: null }],
    ])
    await client.trades(HEX, { side: 'taker', assetId: '70810' })
    url = fetchMock2.mock.calls[0][0] as URL
    expect(url.searchParams.get('side')).toBe('taker')
    expect(url.searchParams.get('asset_id')).toBe('70810')
  })
})

describe('iterateTrades', () => {
  it('advances the before bound like fills', async () => {
    const pages = [
      { trades: [{ tradedAt: 30 }, { tradedAt: 20 }], nextCursor: null },
      { trades: [], nextCursor: null },
    ]
    const indexer = { trades: async () => pages.shift() } as any
    const seen: number[] = []
    for await (const t of iterateTrades(indexer, '0xbm')) {
      seen.push((t as any).tradedAt)
    }
    expect(seen).toEqual([30, 20])
  })
})

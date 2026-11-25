/**
 * Read-your-writes: `minCheckpoint` on the reads the gateway supports it for,
 * the retry when the indexer answers from an older checkpoint, and
 * `checkpointOf` for the checkpoint a transaction landed in.
 */
import { jest } from '@jest/globals'
import { transactionCheckpoint } from '../src/checkpoint'
import { TriexError } from '../src/errors'
import { READ_YOUR_WRITES } from '../src/http'
import { IndexerClient } from '../src/queries'
import { ReadOnlyClient } from '../src/ReadOnlyClient'
import { TriexClient } from '../src/TriexClient'

const HEX = `0x${'7f'.repeat(32)}`

/** Queue responses; each carries an `X-Indexer-Checkpoint` header (or none). */
function mockFetch(
  responses: { body: unknown; checkpoint?: string }[],
): jest.Mock {
  const fn = jest.fn(async () => {
    const next = responses.shift()!
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'x-indexer-checkpoint'
            ? (next.checkpoint ?? null)
            : null,
      },
      json: async () => next.body,
    }
  })
  ;(global as any).fetch = fn
  return fn
}

const urlOf = (fetchMock: jest.Mock, i = 0) => fetchMock.mock.calls[i][0] as URL

const sweepable = {
  trading_account_id: HEX,
  as_of_checkpoint: '1',
  pools: [],
  items: [],
}
const openOrders = { data: [], next_cursor: null }

let savedDelays: number[]
beforeEach(() => {
  savedDelays = READ_YOUR_WRITES.retryDelaysMs
  READ_YOUR_WRITES.retryDelaysMs = [0, 0, 0]
})
afterEach(() => {
  READ_YOUR_WRITES.retryDelaysMs = savedDelays
  jest.restoreAllMocks()
})

const indexer = new IndexerClient('https://api.example.test', 'k', 'triex')
const ro = new ReadOnlyClient({
  apiKey: 'k',
  indexerUrl: 'https://api.example.test',
  gateway: 'triex' as const,
})

describe('the indexer catching up to minCheckpoint', () => {
  it('retries while the response comes from an older checkpoint', async () => {
    const fetchMock = mockFetch([
      { body: openOrders, checkpoint: '99' },
      { body: openOrders, checkpoint: '100' },
    ])
    await ro.openOrders(HEX, { minCheckpoint: 100n })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(urlOf(fetchMock, 1).searchParams.get('min_checkpoint')).toBe('100')
  })

  it('returns the first answer at or past the checkpoint', async () => {
    const fetchMock = mockFetch([{ body: openOrders, checkpoint: '150' }])
    await ro.openOrders(HEX, { minCheckpoint: '100' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('settles for what the indexer has once the retries run out', async () => {
    const fetchMock = mockFetch([
      { body: openOrders, checkpoint: '1' },
      { body: openOrders, checkpoint: '1' },
      { body: openOrders, checkpoint: '1' },
      { body: { data: [], next_cursor: 'last' }, checkpoint: '1' },
    ])
    const page = await ro.openOrders(HEX, { minCheckpoint: 100n })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(page.nextCursor).toBe('last')
  })

  it('never retries a read that did not ask for a checkpoint', async () => {
    const fetchMock = mockFetch([{ body: openOrders, checkpoint: '1' }])
    await ro.openOrders(HEX)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(urlOf(fetchMock).searchParams.has('min_checkpoint')).toBe(false)
  })

  it('does not retry when the gateway sends no checkpoint header', async () => {
    const fetchMock = mockFetch([{ body: openOrders }])
    await ro.openOrders(HEX, { minCheckpoint: 100n })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('minCheckpoint reaches every read that supports it', () => {
  const org = {
    org_id: HEX,
    name: null,
    units: [],
  }
  const cases: Array<{
    name: string
    call: () => Promise<unknown>
    body: unknown
    path: string
  }> = [
    {
      name: 'open orders',
      call: () => ro.openOrders(HEX, { minCheckpoint: 7n }),
      body: openOrders,
      path: `/v1/trading-accounts/${HEX}/open-orders`,
    },
    {
      name: 'trades',
      call: () => ro.trades(HEX, { minCheckpoint: 7n }),
      body: { data: [], next_cursor: null },
      path: `/v1/trading-accounts/${HEX}/trades`,
    },
    {
      name: 'sweepable',
      call: () => ro.sweepable(HEX, { minCheckpoint: 7n }),
      body: sweepable,
      path: `/v1/trading-accounts/${HEX}/sweepable`,
    },
    {
      name: 'pool order book',
      call: () => indexer.orderbook(HEX, { minCheckpoint: 7n }),
      body: { bids: [], asks: [] },
      path: `/v1/pools/${HEX}/orderbook`,
    },
    {
      name: 'item search',
      call: () => ro.searchItems('fuel', { limit: 5, minCheckpoint: 7n }),
      body: { data: [], count: 0 },
      path: '/v1/world/items/search',
    },
    {
      name: 'organization',
      call: () => ro.orgs.get(HEX, { minCheckpoint: 7n }),
      body: org,
      path: `/v1/orgs/${HEX}`,
    },
    {
      name: 'organization batch',
      call: () => ro.orgs.batch([HEX], { minCheckpoint: 7n }),
      body: [org],
      path: '/v1/orgs',
    },
    {
      name: 'player organizations',
      call: () => ro.orgs.forPlayer(HEX, { minCheckpoint: 7n }),
      body: [],
      path: `/v1/players/${HEX}/orgs`,
    },
    {
      name: 'hub organization vaults',
      call: () => ro.orgs.vaultsAtHub(HEX, { minCheckpoint: 7n }),
      body: [],
      path: `/v1/hubs/${HEX}/dao-vaults`,
    },
  ]

  it.each(cases)('$name', async ({ call, body, path }) => {
    const fetchMock = mockFetch([{ body }])
    // Shape errors are not the point here; the request is.
    await call().catch(() => undefined)
    expect(urlOf(fetchMock).pathname).toBe(path)
    expect(urlOf(fetchMock).searchParams.get('min_checkpoint')).toBe('7')
  })

  it('hub detail passes it to the vault read', async () => {
    const fetchMock = mockFetch([
      {
        body: {
          hub_id: HEX,
          collection_id: HEX,
          vault_config_id: HEX,
        },
      },
      { body: null },
    ])
    await ro.hub(HEX, { minCheckpoint: 7n }).catch(() => undefined)
    const vault = fetchMock.mock.calls
      .map((c) => c[0] as URL)
      .find((u) => u.pathname.endsWith('/vault'))!
    expect(vault.searchParams.get('min_checkpoint')).toBe('7')
  })
})

describe('checkpointOf', () => {
  const ledger = (responses: Array<bigint | undefined | Error>) => ({
    ledgerService: {
      getTransaction: jest.fn(async () => {
        const next = responses.shift()
        if (next instanceof Error) throw next
        return { response: { transaction: { checkpoint: next } } }
      }),
    },
  })

  it('polls until the fullnode reports the checkpoint', async () => {
    const sui = ledger([new Error('NOT_FOUND: transaction'), undefined, 4242n])
    const got = await transactionCheckpoint(sui, 'D1', { intervalMs: 0 })
    expect(got).toBe(4242n)
    expect(sui.ledgerService.getTransaction).toHaveBeenCalledTimes(3)
    expect(sui.ledgerService.getTransaction).toHaveBeenLastCalledWith({
      digest: 'D1',
      readMask: { paths: ['checkpoint'] },
    })
  })

  it('takes a TxResult or a digest on the client', async () => {
    const sui = ledger([7n, 8n])
    const client = new TriexClient({ apiKey: 'k', suiClient: sui as any })
    expect(
      await client.checkpointOf({ digest: 'D', createdObjects: [], raw: null }),
    ).toBe(7n)
    expect(await client.checkpointOf('D')).toBe(8n)
  })

  it('needs a gRPC client', async () => {
    await expect(transactionCheckpoint({}, 'D')).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
    })
  })

  it('times out when no checkpoint arrives', async () => {
    const sui = ledger(Array(10).fill(undefined))
    await expect(
      transactionCheckpoint(sui, 'D', { timeoutMs: 1, intervalMs: 5 }),
    ).rejects.toMatchObject({ code: TriexError.Timeout })
  })

  it('surfaces errors other than not-found', async () => {
    const sui = ledger([new Error('UNAVAILABLE: connection reset')])
    await expect(transactionCheckpoint(sui, 'D')).rejects.toThrow('UNAVAILABLE')
  })
})

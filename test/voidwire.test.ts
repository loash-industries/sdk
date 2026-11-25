import { jest } from '@jest/globals'
import {
  VOIDWIRE_FIXTURE,
  diffGateway,
  loadSpec,
  normalizePath,
  readGatewaySurface,
  readSdkCalls,
} from '../scripts/gateway-surface.mjs'
import { DEFAULT_INDEXER_URL, GATEWAY_URLS } from '../src'
import { TriexError } from '../src/errors'
import { gatewayPath } from '../src/gateways'
import { IndexerClient } from '../src/queries'
import { ReadOnlyClient } from '../src/ReadOnlyClient'

const PAGE = { data: [], next_cursor: null, prev_cursor: null }

function mockFetch(res: object): jest.Mock {
  const fn = jest.fn(async () => ({ ok: true, status: 200, ...res }))
  ;(global as any).fetch = fn
  return fn
}

const requested = (fn: jest.Mock) => (fn.mock.calls[0] as [URL])[0]

/** Call-site paths carry `${}` placeholders; stand in a real-looking segment. */
const concrete = (path: string) => path.replace(/\$\{\}/g, '0xabc')

describe('lock-step with the Voidwire gateway', () => {
  const surface = readGatewaySurface(loadSpec(VOIDWIRE_FIXTURE))
  const calls = readSdkCalls()
  const mapped = calls.map((c) => {
    const group = gatewayPath('voidwire', concrete(c.path)).split('/')[1]
    const path = `/${group}${c.path}`
    return { ...c, path, normalized: normalizePath(path) }
  })
  const diff = diffGateway(surface, mapped)

  it('sends every request to a path Voidwire publishes', () => {
    expect(mapped.length).toBeGreaterThanOrEqual(60)
    expect(diff.unknownEndpoints.map((u) => u.path)).toEqual([])
  })

  it('sends only parameters Voidwire declares, and every required one', () => {
    expect(diff.unknownParams.map((u) => `${u.param} → ${u.path}`)).toEqual([])
    expect(diff.missingRequired.map((m) => `${m.param} → ${m.path}`)).toEqual(
      [],
    )
  })

  it('covers every SDK call site', () => {
    expect(diff.matched.length).toBe(calls.length)
  })
})

describe('gatewayPath', () => {
  it('leaves the default gateway alone', () => {
    expect(gatewayPath('triex', '/v1/discovery')).toBe('/v1/discovery')
  })

  it.each([
    ['/v1/hubs/0x1/items', 'hubs'],
    ['/v1/hubs/0x1/items/84210/orderbook', 'trading'],
    ['/v1/orgs/0x1', 'orgs'],
    ['/v1/orgs/0x1/agreements', 'hauling'],
    ['/v1/players/0x1/orgs', 'orgs'],
    ['/v1/players/0x1/accessible-keyspaces', 'orgs'],
    ['/v1/players/0x1/agreements', 'hauling'],
    ['/v1/players/0x1/agreements/claimable', 'hauling'],
  ])('puts %s in %s', (path, group) => {
    expect(gatewayPath('voidwire', path)).toBe(`/${group}${path}`)
  })

  it('throws for a path in no known group rather than guessing', () => {
    expect(() => gatewayPath('voidwire', '/v1/mystery')).toThrow(
      expect.objectContaining({ code: TriexError.NotOnGateway }),
    )
  })
})

describe('client configuration', () => {
  it('reads from Trinary Exchange unless told otherwise', async () => {
    const fetchMock = mockFetch({ json: async () => PAGE })
    await new ReadOnlyClient({ apiKey: 'k' }).discover()
    expect(DEFAULT_INDEXER_URL).toBe('https://api.trinary.exchange')
    expect(requested(fetchMock).href).toBe(
      'https://api.trinary.exchange/v1/discovery',
    )
  })

  it('reads from Voidwire with `gateway: voidwire`', async () => {
    const fetchMock = mockFetch({ json: async () => PAGE })
    await new ReadOnlyClient({ apiKey: 'k', gateway: 'voidwire' }).discover()
    expect(requested(fetchMock).href).toBe(
      'https://api.voidwire.xyz/explore/v1/discovery',
    )
  })

  it('keeps the gateway path layout when only the host is overridden', async () => {
    const fetchMock = mockFetch({ json: async () => PAGE })
    await new ReadOnlyClient({
      apiKey: 'k',
      gateway: 'voidwire',
      indexerUrl: 'https://api-dev.example.test',
    }).discover()
    expect(requested(fetchMock).href).toBe(
      'https://api-dev.example.test/explore/v1/discovery',
    )
  })

  it('carries the gateway into organization and hauling reads', async () => {
    const indexer = new IndexerClient(GATEWAY_URLS.voidwire, 'k', 'voidwire')
    const notFound = { ok: false, status: 500, json: async () => ({}) }

    let fetchMock = mockFetch(notFound)
    await expect(indexer.orgs.directory()).rejects.toThrow()
    expect(requested(fetchMock).pathname).toBe('/orgs/v1/orgs/directory')

    fetchMock = mockFetch(notFound)
    await expect(indexer.hauling.agreements()).rejects.toThrow()
    expect(requested(fetchMock).pathname).toBe('/hauling/v1/agreements')
  })
})

describe('HTTP 402', () => {
  it('maps to PaymentRequired and passes on the top-up URL', async () => {
    mockFetch({
      ok: false,
      status: 402,
      statusText: 'Payment Required',
      json: async () => ({
        error: 'payment_required',
        reason: 'balance',
        balance_cu: 0,
        top_up_url: 'https://voidwire.xyz/account/billing',
      }),
    })
    const client = new ReadOnlyClient({ apiKey: 'k', gateway: 'voidwire' })
    await expect(client.discover()).rejects.toMatchObject({
      code: TriexError.PaymentRequired,
      status: 402,
      message: expect.stringContaining('https://voidwire.xyz/account/billing'),
    })
  })
})

import { jest } from '@jest/globals'
import { createContext } from '../src/context.js'
import { loadConfig } from '../src/env.js'
import { ALL_TOOLS } from '../src/registry.js'

/**
 * End-to-end wiring for the location tools: tool input → SDK method → the URL
 * that actually leaves the process.
 *
 * This is not belt-and-braces over the parity gate. That gate reads the SDK's
 * shipped declarations and checks NAMES; it cannot see that a handler forgot
 * to unwrap a positional argument, and TypeScript will not catch it here
 * either, because the SDK's `.d.ts` re-exports are extensionless and resolve to
 * `any` under NodeNext. The only thing that observes a mis-wired handler is a
 * call that goes out and is inspected.
 */
const config = loadConfig({
  TRIEX_MCP_MODE: 'read',
  TRIEX_INDEXER_URL: 'https://api.example.test',
} as NodeJS.ProcessEnv)

const HEX = '0x'.padEnd(66, 'a')

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

const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!

afterEach(() => jest.restoreAllMocks())

describe('location tools reach the endpoint their inputs describe', () => {
  const page = { data: [], next_cursor: null }

  const cases: Array<{
    tool: string
    args: Record<string, unknown>
    payload: unknown
    path: string
    query?: Record<string, string>
  }> = [
    {
      tool: 'market_hub_locations',
      args: { solarSystemId: 30000142, hasVault: true, limit: 10 },
      payload: page,
      path: '/v1/hubs/locations',
      query: { solar_system: '30000142', has_vault: 'true', limit: '10' },
    },
    {
      tool: 'market_item_locations',
      args: { assetId: '70810', limit: 5 },
      payload: page,
      // The item id belongs in the PATH — a handler that forgot to unwrap it
      // would send it as a query key the gateway ignores, and still 200.
      path: '/v1/items/70810/locations',
      query: { limit: '5' },
    },
    {
      tool: 'market_nearby_hubs',
      args: { hubId: HEX, rangeLy: 250, assetId: '70810' },
      payload: [],
      path: `/v1/hubs/${HEX}/nearby`,
      query: { range: '250', type_id: '70810' },
    },
    {
      tool: 'market_nearby_hubs_by_system',
      args: { solarSystem: 'Nod', rangeLy: 100 },
      payload: [],
      path: '/v1/hubs/nearby-by-system',
      query: { system_id: 'Nod', range: '100' },
    },
    {
      tool: 'market_hubs_enriched',
      args: { hubIds: [HEX, '0xbeef'] },
      payload: [],
      path: '/v1/hubs/enriched',
      query: { ids: `${HEX},0xbeef` },
    },
    {
      tool: 'market_assembly_owners',
      args: { assemblyIds: ['0xa1', '0xa2'] },
      payload: [],
      path: '/v1/assemblies/owners',
      query: { ids: '0xa1,0xa2' },
    },
    {
      tool: 'market_assemblies_enriched',
      args: { assemblyIds: ['0xa1'] },
      payload: [],
      path: '/v1/assemblies/enriched',
      query: { ids: '0xa1' },
    },
    {
      tool: 'market_solar_system_names',
      args: { solarSystemIds: [30000142, 30000143] },
      payload: [],
      path: '/v1/solar-systems/names',
      query: { ids: '30000142,30000143' },
    },
    {
      tool: 'account_owners',
      args: { balanceManagerIds: [HEX] },
      payload: [],
      path: '/v1/balance-managers/owners',
      query: { ids: HEX },
    },
  ]

  it.each(cases)(
    '$tool → $path',
    async ({ tool: name, args, payload, path, query }) => {
      const fetchMock = captureFetch(payload)
      const ctx = createContext('tenant-key', config, {} as any)

      const result = await tool(name).handler(ctx, args)
      expect(result.isError).toBeFalsy()

      const url = fetchMock.mock.calls[0]![0] as URL
      expect(url.pathname).toBe(path)
      for (const [key, value] of Object.entries(query ?? {})) {
        expect(url.searchParams.get(key)).toBe(value)
      }
    },
  )

  it('validates its inputs before spending the caller a request', () => {
    // The batch reads cap at 200 ids upstream; rejecting locally turns a
    // compute-unit charge and a 400 into a schema error.
    const shape = tool('market_hubs_enriched').inputShape as any
    expect(shape.hubIds.safeParse([]).success).toBe(false)
    expect(
      shape.hubIds.safeParse(Array.from({ length: 201 }, () => HEX)).success,
    ).toBe(false)
    expect(shape.hubIds.safeParse([HEX]).success).toBe(true)
  })

  it('carries the calling tenant key onto every location request', () => {
    const fetchMock = captureFetch(page)
    const ctx = createContext('tenant-key', config, {} as any)
    return tool('market_hub_locations')
      .handler(ctx, {})
      .then(() => {
        const init = fetchMock.mock.calls[0]![1] as RequestInit
        expect((init.headers as Record<string, string>)['x-api-key']).toBe(
          'tenant-key',
        )
      })
  })
})

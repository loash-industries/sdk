import { jest } from '@jest/globals'
import { createContext } from '../src/context.js'
import { loadConfig } from '../src/env.js'
import { ALL_TOOLS, toolsForMode } from '../src/registry.js'
import { fail } from '../src/result.js'

/**
 * The star-map tools: input → SDK → the URL that leaves the process.
 *
 * TypeScript cannot check these handlers (the SDK's shipped `.d.ts`
 * re-exports are extensionless and resolve to `any` under NodeNext), and the
 * parity gate only checks names, so a handler that forgot to unwrap a
 * positional argument would pass both. An inspected request is the witness.
 */
const config = loadConfig({
  TRIEX_MCP_MODE: 'read',
  TRIEX_INDEXER_URL: 'https://api.example.test',
} as NodeJS.ProcessEnv)

const COORDS = {
  x: '-6523761465801880000',
  y: '-253634337518181280',
  z: '4013616888017946600',
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

const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!
const body = (res: { content: { text: string }[] }) =>
  JSON.parse(res.content[0]!.text)

afterEach(() => jest.restoreAllMocks())

describe('spatial tools reach the endpoint their inputs describe', () => {
  const cases: Array<{
    tool: string
    args: Record<string, unknown>
    payload: unknown
    path: string
    query?: Record<string, string>
  }> = [
    {
      tool: 'spatial_system',
      args: { solarSystem: 'EHK-KH7' },
      payload: {
        solar_system_id: 30000142,
        solar_system_name: 'EHK-KH7',
        location: COORDS,
      },
      // The identifier belongs in the PATH; as a query key it would be ignored.
      path: '/v1/spatial/systems/EHK-KH7',
    },
    {
      tool: 'spatial_systems',
      args: { solarSystemNames: ['EHK-KH7', 'IF3-HS9'] },
      payload: { count: 0, systems: [] },
      path: '/v1/spatial/systems',
      query: { solar_system_names: 'EHK-KH7,IF3-HS9' },
    },
    {
      tool: 'spatial_nearby_systems',
      args: { solarSystem: 'EHK-KH7', radiusLy: 100, limit: 5 },
      payload: {
        solar_system_id: 30000142,
        solar_system_name: 'EHK-KH7',
        radius_ly: '100',
        count: 0,
        systems: [],
      },
      path: '/v1/spatial/systems/EHK-KH7/nearby',
      query: { radius_ly: '100', limit: '5' },
    },
    {
      tool: 'spatial_systems_near_coordinates',
      args: { ...COORDS, radiusLy: 50 },
      payload: { location: COORDS, radius_ly: '50', count: 0, systems: [] },
      path: '/v1/spatial/coordinates/nearby',
      query: { ...COORDS, radius_ly: '50' },
    },
    {
      tool: 'spatial_autocomplete_systems',
      args: { query: 'EHK', limit: 3 },
      payload: { count: 0, systems: [] },
      path: '/v1/spatial/systems/search/autocomplete',
      query: { q: 'EHK', limit: '3' },
    },
    {
      tool: 'spatial_stats',
      args: {},
      payload: { total_systems: 24018, status: 'operational' },
      path: '/v1/spatial/stats',
    },
  ]

  it.each(cases)(
    '$tool → $path',
    async ({ tool: name, args, payload, path, query }) => {
      const fetchMock = captureFetch(payload)
      const ctx = createContext('tenant-key', config, {} as any)

      const res = await tool(name).handler(ctx, args)
      expect(res.isError).toBeFalsy()

      const url = fetchMock.mock.calls[0]![0] as URL
      expect(url.pathname).toBe(path)
      for (const [key, value] of Object.entries(query ?? {})) {
        expect(url.searchParams.get(key)).toBe(value)
      }
    },
  )
})

describe('spatial tool inputs', () => {
  it('rejects the XOR violation locally, before any request goes out', async () => {
    const fetchMock = captureFetch({})
    const ctx = createContext('tenant-key', config, {} as any)

    const call = tool('spatial_systems').handler(ctx, {
      solarSystemIds: [30000142],
      solarSystemNames: ['EHK-KH7'],
    })

    // The gateway answers this with a 400 — and bills the compute units first.
    await expect(call).rejects.toMatchObject({
      code: 'TRIEX_VALIDATION_FAILED',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders that rejection as a coded tool result for the model', async () => {
    // The server catches a throwing handler and returns fail(e), so the model
    // reads the code rather than seeing the call disappear.
    const ctx = createContext('tenant-key', config, {} as any)
    captureFetch({})
    const res = await tool('spatial_systems')
      .handler(ctx, { solarSystemIds: [1], solarSystemNames: ['A'] })
      .catch((e: unknown) => fail(e))

    expect(res.isError).toBe(true)
    expect(body(res).code).toBe('TRIEX_VALIDATION_FAILED')
    expect(body(res).error).toMatch(/exactly one of/)
  })

  it('keeps coordinates as decimal strings, negatives included', () => {
    const shape = tool('spatial_systems_near_coordinates').inputShape as any
    expect(shape.x.safeParse('-6523761465801880000').success).toBe(true)
    expect(shape.x.safeParse('32426925571366360000').success).toBe(true)
    // A JSON number here is the precision bug this guards against.
    expect(shape.x.safeParse(-6523761465801880000).success).toBe(false)
    expect(shape.x.safeParse('1.5').success).toBe(false)
  })

  it('preserves coordinate precision through the whole call', async () => {
    // 32426925571366360000 is past 2^53; a double would round it.
    const huge = '32426925571366360000'
    const fetchMock = captureFetch({
      location: { ...COORDS, x: huge },
      radius_ly: '1',
      count: 0,
      systems: [],
    })
    const ctx = createContext('tenant-key', config, {} as any)

    const res = await tool('spatial_systems_near_coordinates').handler(ctx, {
      ...COORDS,
      x: huge,
      radiusLy: 1,
    })

    expect((fetchMock.mock.calls[0]![0] as URL).searchParams.get('x')).toBe(
      huge,
    )
    expect(body(res).origin.x).toBe(huge)
  })

  it('bounds the radius at the documented maximum', () => {
    const shape = tool('spatial_nearby_systems').inputShape as any
    expect(shape.radiusLy.safeParse(10_000).success).toBe(true)
    expect(shape.radiusLy.safeParse(10_001).success).toBe(false)
    expect(shape.radiusLy.safeParse(0).success).toBe(false)
  })

  it('exposes the whole star map to a read-only deployment', () => {
    const names = toolsForMode('read').map((t) => t.name)
    for (const name of [
      'spatial_system',
      'spatial_systems',
      'spatial_nearby_systems',
      'spatial_systems_near_coordinates',
      'spatial_autocomplete_systems',
      'spatial_stats',
    ]) {
      expect(names).toContain(name)
    }
  })
})

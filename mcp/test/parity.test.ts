import {
  diffParams,
  diffSurface,
  readSdkSurface,
} from '../scripts/sdk-surface.mjs'
import type { SdkMethod, ToolLike } from '../scripts/sdk-surface.mjs'
import {
  ALL_TOOLS,
  EXCLUDED_SDK_PATHS,
  GLOBAL_SYNTHETIC_PARAMS,
  toolsForMode,
} from '../src/registry.js'

/**
 * Lock-step coverage of the SDK, in both dimensions.
 *
 * The surface is read from `@trinaryex/sdk`'s SHIPPED type declarations, so it
 * reflects the published contract: `private` helpers are excluded structurally,
 * each method's return type says whether it is a read or a write, and each
 * parameter type resolves to the properties that method accepts. That makes
 * this gate self-maintaining in two ways — a new SDK method fails CI until it
 * is wrapped by a tool of the correct kind, and a tool input the SDK does not
 * accept fails CI until it is renamed, dropped, or waived with a reason.
 */
const surface = readSdkSurface()
const diff = diffSurface(surface, ALL_TOOLS as ToolLike[], EXCLUDED_SDK_PATHS)
const params = diffParams(
  surface,
  ALL_TOOLS as ToolLike[],
  GLOBAL_SYNTHETIC_PARAMS,
)

describe('SDK surface', () => {
  it('parses a plausible client surface from the shipped declarations', () => {
    expect(surface.length).toBeGreaterThanOrEqual(20)
    expect(surface.some((m) => m.kind === 'write')).toBe(true)
    expect(surface.some((m) => m.kind === 'read')).toBe(true)
  })

  it('classifies transaction-returning methods as writes', () => {
    const limit = surface.find((m) => m.path === 'orders.limit')
    expect(limit?.kind).toBe('write')
    const book = surface.find((m) => m.path === 'market.orderbook')
    expect(book?.kind).toBe('read')
  })

  it('excludes TypeScript-private helpers structurally', () => {
    for (const path of [
      'orders.ownBm',
      'orders.requirePool',
      'orders.beginCancelTx',
      'orders.depositQuoteDeficit',
    ]) {
      expect(surface.map((m) => m.path)).not.toContain(path)
    }
  })
})

describe('lock-step coverage', () => {
  it('covers every SDK method with a tool or an explicit exclusion', () => {
    expect(diff.missing.map((m) => `${m.path} (${m.kind})`)).toEqual([])
  })

  it('wraps every write with a prepare tool and every read with a read tool', () => {
    expect(
      diff.miscovered.map(
        (m) => `${m.path}: expected ${m.expected}, got ${m.actual} (${m.tool})`,
      ),
    ).toEqual([])
  })

  it('has no tool pointing at an SDK method that no longer exists', () => {
    expect(diff.dangling).toEqual([])
  })

  it('has no stale exclusions', () => {
    expect(diff.staleExclusions).toEqual([])
  })

  it('gives every exclusion a reason', () => {
    for (const [path, reason] of Object.entries(EXCLUDED_SDK_PATHS)) {
      expect(reason.length).toBeGreaterThan(20)
      expect(path).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
    }
  })

  it('accounts for the entire surface exactly once', () => {
    expect(diff.covered.length + Object.keys(EXCLUDED_SDK_PATHS).length).toBe(
      surface.length,
    )
  })

  it('never wraps the same SDK method twice', () => {
    const paths = ALL_TOOLS.map((t) => t.sdkPath)
    expect(new Set(paths).size).toBe(paths.length)
  })
})

/**
 * Lock-step ARGUMENTS.
 *
 * Naming the right method is only half of it. An input the SDK does not accept
 * is not rejected anywhere — the property is dropped in transit and the caller
 * gets a successful response that quietly ignored what was asked. `hubId` on a
 * method that filters by `storageUnitIds` returned the entire market; a
 * `cursor` on a timestamp-windowed read paged forever over page one. Both
 * type-checked, both passed coverage, neither did anything.
 */
describe('lock-step arguments', () => {
  it('declares no tool input its SDK method cannot accept', () => {
    expect(
      params.unknown.map(
        (u) =>
          `${u.tool}.${u.param} (${u.sdkPath} accepts: ${u.accepted.join(', ')})`,
      ),
    ).toEqual([])
  })

  it('supplies every required SDK parameter', () => {
    expect(
      params.missingRequired.map((m) => `${m.tool} → ${m.sdkPath}(${m.param})`),
    ).toEqual([])
  })

  it('has no parameter waiver that no longer holds', () => {
    expect(params.stale.map((s) => `${s.tool}.${s.param} ${s.why}`)).toEqual([])
  })

  it('resolves parameters through ReadOnlyClient as well as the namespaced APIs', () => {
    // Read tools call ReadOnlyClient, whose methods take identity explicitly.
    // Without it, every account-scoped read would look like a violation.
    const openOrders = surface.find((m) => m.path === 'orders.openOrders')
    expect(openOrders?.params.map((p) => p.name)).toContain('balanceManagerId')
  })

  it('expands object parameters without expanding primitives', () => {
    const limit = surface.find((m) => m.path === 'orders.limit')
    // Properties of LimitOrderParams, resolved from a sibling declaration file.
    expect(limit?.params.map((p) => p.name)).toEqual(
      expect.arrayContaining(['assetId', 'price', 'quantity', 'side']),
    )
    // A `query: string` parameter contributes its own name, not String's methods.
    const search = surface.find((m) => m.path === 'market.searchItems')
    expect(search?.params.map((p) => p.name)).toContain('query')
    expect(search?.params.map((p) => p.name)).not.toContain('charCodeAt')
  })

  it('marks optional parameters as optional', () => {
    const search = surface.find((m) => m.path === 'market.searchItems')
    expect(search?.params.find((p) => p.name === 'query')?.optional).toBe(false)
    expect(search?.params.find((p) => p.name === 'limit')?.optional).toBe(true)
  })

  it('gives every synthetic parameter a reason', () => {
    const waivers = [
      ...Object.entries(GLOBAL_SYNTHETIC_PARAMS),
      ...ALL_TOOLS.flatMap((t) => Object.entries(t.syntheticParams ?? {})),
      ...ALL_TOOLS.flatMap((t) => Object.entries(t.derivedParams ?? {})),
    ]
    for (const [param, reason] of waivers) {
      expect(param).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/)
      expect(reason.length).toBeGreaterThan(20)
    }
  })

  it('keeps paging shapes matched to what each read actually supports', () => {
    // Regression guard: cursor paging and timestamp windows are not the same,
    // and offering the wrong one is silently useless.
    const keys = (name: string) =>
      Object.keys(ALL_TOOLS.find((t) => t.name === name)!.inputShape)
    expect(keys('market_discover')).toContain('cursor')
    for (const name of ['orders_open', 'orders_fills', 'orders_trades']) {
      expect(keys(name)).not.toContain('cursor')
      expect(keys(name)).toEqual(expect.arrayContaining(['before', 'after']))
    }
  })

  it('lets a caller scan several hubs in one discovery call', () => {
    const discover = ALL_TOOLS.find((t) => t.name === 'market_discover')!
    expect(Object.keys(discover.inputShape)).toContain('storageUnitIds')
    expect(Object.keys(discover.inputShape)).not.toContain('hubId')
  })
})

/**
 * A gate that cannot fail is not a gate. These drive `diffSurface` with
 * doctored inputs to prove each failure mode is actually detected.
 */
describe('the parity gate detects drift', () => {
  const fakeSurface: SdkMethod[] = [
    {
      path: 'orders.limit',
      namespace: 'orders',
      method: 'limit',
      kind: 'write',
      returns: 'TxResult',
      params: [],
    },
    {
      path: 'market.hub',
      namespace: 'market',
      method: 'hub',
      kind: 'read',
      returns: 'TradeHubDetail',
      params: [],
    },
  ]

  it('flags an SDK method with no tool', () => {
    const result = diffSurface(fakeSurface, [], {})
    expect(result.missing.map((m) => m.path).sort()).toEqual([
      'market.hub',
      'orders.limit',
    ])
  })

  it('flags a write covered by a read tool', () => {
    const tools: ToolLike[] = [
      { name: 'orders_limit', sdkPath: 'orders.limit', kind: 'read' },
      { name: 'market_hub', sdkPath: 'market.hub', kind: 'read' },
    ]
    const result = diffSurface(fakeSurface, tools, {})
    expect(result.miscovered).toHaveLength(1)
    expect(result.miscovered[0]).toMatchObject({
      path: 'orders.limit',
      expected: 'prepare',
      actual: 'read',
    })
  })

  it('flags a read covered by a prepare tool', () => {
    const tools: ToolLike[] = [
      { name: 'prepare_limit_order', sdkPath: 'orders.limit', kind: 'prepare' },
      { name: 'prepare_hub', sdkPath: 'market.hub', kind: 'prepare' },
    ]
    const result = diffSurface(fakeSurface, tools, {})
    expect(result.miscovered.map((m) => m.path)).toEqual(['market.hub'])
  })

  it('flags a tool pointing at a removed SDK method', () => {
    const tools: ToolLike[] = [
      { name: 'gone', sdkPath: 'orders.doesNotExist', kind: 'read' },
    ]
    expect(diffSurface(fakeSurface, tools, {}).dangling).toEqual([
      'orders.doesNotExist',
    ])
  })

  it('flags a stale exclusion', () => {
    const result = diffSurface(fakeSurface, [], { 'orders.removed': 'gone' })
    expect(result.staleExclusions).toEqual(['orders.removed'])
  })

  it('treats an excluded method as neither missing nor miscovered', () => {
    const result = diffSurface(fakeSurface, [], {
      'orders.limit': 'x',
      'market.hub': 'y',
    })
    expect(result.missing).toEqual([])
    expect(result.miscovered).toEqual([])
  })
})

/** The argument gate, driven with doctored inputs to prove each failure mode. */
describe('the argument gate detects drift', () => {
  const fakeSurface: SdkMethod[] = [
    {
      path: 'market.discover',
      namespace: 'market',
      method: 'discover',
      kind: 'read',
      returns: 'DiscoveryResult',
      params: [
        { name: 'storageUnitIds', optional: true },
        { name: 'assetId', optional: true },
      ],
    },
    {
      path: 'market.orderbook',
      namespace: 'market',
      method: 'orderbook',
      kind: 'read',
      returns: 'HubItemOrderbook',
      params: [
        { name: 'storageUnitId', optional: false },
        { name: 'assetId', optional: false },
      ],
    },
  ]

  const tool = (over: Partial<ToolLike>): ToolLike => ({
    name: 'market_discover',
    sdkPath: 'market.discover',
    kind: 'read',
    ...over,
  })

  it('flags the exact bug that shipped: a singular name for a plural filter', () => {
    const result = diffParams(fakeSurface, [tool({ inputKeys: ['hubId'] })])
    expect(result.unknown).toHaveLength(1)
    expect(result.unknown[0]).toMatchObject({
      tool: 'market_discover',
      param: 'hubId',
    })
    expect(result.unknown.flatMap((u) => u.accepted)).toContain(
      'storageUnitIds',
    )
  })

  it('flags an input the method silently ignores', () => {
    const result = diffParams(fakeSurface, [
      tool({
        name: 'market_orderbook',
        sdkPath: 'market.orderbook',
        inputKeys: ['storageUnitId', 'assetId', 'depth'],
      }),
    ])
    expect(result.unknown.map((u) => u.param)).toEqual(['depth'])
  })

  it('accepts an input that matches the SDK exactly', () => {
    const result = diffParams(fakeSurface, [
      tool({ inputKeys: ['storageUnitIds', 'assetId'] }),
    ])
    expect(result.unknown).toEqual([])
  })

  it('accepts a synthetic input that carries a written reason', () => {
    const result = diffParams(
      fakeSurface,
      [tool({ inputKeys: ['sender', 'assetId'] })],
      { sender: 'the address a prepared transaction is built for' },
    )
    expect(result.unknown).toEqual([])
  })

  it('honours a per-tool waiver as well as a global one', () => {
    const result = diffParams(fakeSurface, [
      tool({
        inputKeys: ['assetId', 'verbose'],
        syntheticParams: { verbose: 'presentation only, never sent upstream' },
      }),
    ])
    expect(result.unknown).toEqual([])
  })

  it('flags a required parameter no input supplies', () => {
    const result = diffParams(fakeSurface, [
      tool({
        name: 'market_orderbook',
        sdkPath: 'market.orderbook',
        inputKeys: ['storageUnitId'],
      }),
    ])
    expect(result.missingRequired.map((m) => m.param)).toEqual(['assetId'])
  })

  it('accepts a required parameter the handler derives itself', () => {
    const result = diffParams(fakeSurface, [
      tool({
        name: 'market_orderbook',
        sdkPath: 'market.orderbook',
        inputKeys: ['storageUnitId'],
        derivedParams: { assetId: 'resolved from the pool the caller named' },
      }),
    ])
    expect(result.missingRequired).toEqual([])
  })

  it('flags a waiver for something that is a real parameter', () => {
    const result = diffParams(fakeSurface, [
      tool({
        inputKeys: ['assetId'],
        syntheticParams: { assetId: 'unnecessary — the SDK takes this' },
      }),
    ])
    expect(result.stale).toHaveLength(1)
    expect(result.stale.map((s) => s.why).join(' ')).toMatch(
      /real market\.discover parameter/,
    )
  })

  it('flags a waiver for an input the tool no longer declares', () => {
    const result = diffParams(fakeSurface, [
      tool({
        inputKeys: ['assetId'],
        syntheticParams: { removed: 'left behind by an earlier refactor' },
      }),
    ])
    expect(result.stale.map((s) => s.param)).toEqual(['removed'])
  })

  it('ignores a tool whose sdkPath no longer exists, leaving that to diffSurface', () => {
    const result = diffParams(fakeSurface, [
      tool({ sdkPath: 'market.gone', inputKeys: ['anything'] }),
    ])
    expect(result.unknown).toEqual([])
  })
})

describe('server modes', () => {
  it('read mode registers no prepare tools at all', () => {
    const tools = toolsForMode('read')
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every((t) => t.kind === 'read')).toBe(true)
    expect(tools.some((t) => t.name.startsWith('prepare_'))).toBe(false)
  })

  it('prepare mode registers both kinds', () => {
    const tools = toolsForMode('prepare')
    expect(tools.some((t) => t.kind === 'read')).toBe(true)
    expect(tools.some((t) => t.kind === 'prepare')).toBe(true)
  })

  it('has unique, snake_case tool names', () => {
    const names = ALL_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('names every prepare tool with a prepare_ prefix', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name.startsWith('prepare_')).toBe(tool.kind === 'prepare')
    }
  })
})

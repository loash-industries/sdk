import { diffSurface, readSdkSurface } from '../scripts/sdk-surface.mjs'
import type { SdkMethod, ToolLike } from '../scripts/sdk-surface.mjs'
import { ALL_TOOLS, EXCLUDED_SDK_PATHS, toolsForMode } from '../src/registry.js'

/**
 * Lock-step coverage of the SDK.
 *
 * The surface is read from `@trinaryex/sdk`'s SHIPPED type declarations, so it
 * reflects the published contract: `private` helpers are excluded structurally,
 * and each method's return type says whether it is a read or a write. That
 * makes this gate self-maintaining — a new SDK method fails CI here until it is
 * wrapped by a tool of the correct kind or explicitly excluded with a reason.
 */
const surface = readSdkSurface()
const diff = diffSurface(surface, ALL_TOOLS as ToolLike[], EXCLUDED_SDK_PATHS)

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
    },
    {
      path: 'market.hub',
      namespace: 'market',
      method: 'hub',
      kind: 'read',
      returns: 'TradeHubDetail',
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

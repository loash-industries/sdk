import { TriexClient } from '@trinaryex/sdk'
import {
  ALL_TOOLS,
  EXCLUDED_SDK_PATHS,
  INTERNAL_SDK_PATHS,
  toolsForMode,
} from '../src/registry.js'

/**
 * The namespaces of the SDK client whose surface this server is expected to
 * cover. Adding a namespace upstream should fail this test until it is either
 * wrapped or explicitly excluded.
 */
const NAMESPACES = ['account', 'balances', 'market', 'orders'] as const

function stubClient(): any {
  return new TriexClient({
    suiClient: {} as any,
    apiKey: 'test-key',
    address: '0x'.padEnd(66, 'a'),
  })
}

/** Public, non-internal method names on a namespace object. */
function methodsOf(namespace: object): string[] {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(namespace))
    .filter((name) => name !== 'constructor')
    .filter((name) => !name.startsWith('_'))
    .sort()
}

function sdkSurface(): string[] {
  const client = stubClient()
  const paths: string[] = []
  for (const ns of NAMESPACES) {
    const target = client[ns]
    expect(target).toBeDefined()
    for (const method of methodsOf(target)) paths.push(`${ns}.${method}`)
  }
  return paths.sort()
}

describe('SDK parity', () => {
  it('covers every public SDK client method with a tool or an explicit exclusion', () => {
    const covered = new Set(ALL_TOOLS.map((t) => t.sdkPath))
    const excluded = new Set(Object.keys(EXCLUDED_SDK_PATHS))

    const internal = new Set(INTERNAL_SDK_PATHS)

    const uncovered = sdkSurface().filter(
      (path) =>
        !covered.has(path) && !excluded.has(path) && !internal.has(path),
    )

    expect(uncovered).toEqual([])
  })

  it('has no tool pointing at an SDK method that no longer exists', () => {
    const surface = new Set(sdkSurface())
    const dangling = ALL_TOOLS.map((t) => t.sdkPath).filter(
      (path) => !surface.has(path),
    )
    expect(dangling).toEqual([])
  })

  it('has no stale exclusions', () => {
    const surface = new Set(sdkSurface())
    const stale = Object.keys(EXCLUDED_SDK_PATHS).filter(
      (path) => !surface.has(path),
    )
    expect(stale).toEqual([])
  })

  it('has no stale internal-helper entries', () => {
    const surface = new Set(sdkSurface())
    const stale = INTERNAL_SDK_PATHS.filter((path) => !surface.has(path))
    expect(stale).toEqual([])
  })

  it('keeps internal helpers out of the tool surface', () => {
    const covered = new Set(ALL_TOOLS.map((t) => t.sdkPath))
    for (const path of INTERNAL_SDK_PATHS) expect(covered.has(path)).toBe(false)
  })

  it('gives every exclusion a reason', () => {
    for (const [path, reason] of Object.entries(EXCLUDED_SDK_PATHS)) {
      expect(reason.length).toBeGreaterThan(20)
      expect(path).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
    }
  })

  it('never wraps the same SDK method twice', () => {
    const paths = ALL_TOOLS.map((t) => t.sdkPath)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('has unique, snake_case tool names', () => {
    const names = ALL_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
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

  it('names every prepare tool with a prepare_ prefix', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name.startsWith('prepare_')).toBe(tool.kind === 'prepare')
    }
  })
})

import { z } from 'zod'
import { ALL_TOOLS } from '../src/registry.js'

/**
 * Every prepare tool, wired to the SDK method it names — checked for all of
 * them at once, so a new tool is covered the moment it is registered.
 *
 * The parity gate proves each SDK write has a tool and that the tool's input
 * names exist on the method. It cannot see the handler: a tool that calls the
 * wrong method, or forgets to pass (or mis-unwraps) one of its inputs, passes
 * the gate and type-checks (the SDK's `.d.ts` re-exports resolve to `any`
 * under NodeNext). This runs each handler against a RECORDING client — every
 * property access and call is logged, nothing touches a network — with inputs
 * synthesised from the tool's own schema, and asserts:
 *
 *   1. the handler calls exactly the SDK method its `sdkPath` names, and
 *   2. every input it was given reaches that call's arguments (as-is, or as
 *      the bigint / number its decimal string encodes).
 *
 * Byte-level correctness — Move targets, type arguments, pinned objects — is
 * the job of the end-to-end prepare tests (coins, hauling, org), which build
 * real transactions against a fake fullnode.
 */

interface Call {
  path: string[]
  args: unknown[]
}

const HEX_FALLBACK = '0x' + '1'.repeat(64)

/** A deep proxy that records calls and is usable sync, async and as a string. */
function recorder(calls: Call[], path: string[] = []): any {
  const target = function () {}
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined // `await proxy` → the proxy
      if (prop === Symbol.toPrimitive) return () => HEX_FALLBACK
      // Iterable and empty, so a handler can spread or `new Set()` a list.
      if (prop === Symbol.iterator) return function* () {}
      if (typeof prop === 'symbol') return undefined
      if (prop === 'toJSON') return () => null
      if (prop === 'toString') return () => HEX_FALLBACK
      return recorder(calls, [...path, prop])
    },
    apply(_t, _this, args) {
      calls.push({ path, args })
      return recorder(calls, [...path, '()'])
    },
  })
}

/** `org.()`-style call markers out, so `org(id).orders.limit` → `org.orders.limit`. */
const methodPath = (path: string[]) => path.filter((p) => p !== '()').join('.')

// ─── Input synthesis from the tool's zod schema ─────────────────────────────

let counter = 0
const uniqueHex = () =>
  '0x' + (0xa000 + ++counter).toString(16).padStart(64, '0')
const stringCandidates = () => {
  const n = ++counter
  return [
    uniqueHex(),
    String(100000 + n),
    `0x${(0xb000 + n).toString(16).padStart(64, '0')}::coin${n}::COIN${n}`,
    `NAME-${n}`,
    `text ${n}`,
  ]
}

function sample(schema: z.ZodType, depth = 0): unknown {
  const def: any = (schema as any)._zod?.def ?? (schema as any).def
  const type: string = def?.type
  if (depth > 8) return undefined
  switch (type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'catch':
      return sample(def.innerType, depth + 1)
    case 'pipe':
      return sample(def.in, depth + 1)
    case 'string':
      for (const c of stringCandidates()) {
        if (schema.safeParse(c).success) return c
      }
      return undefined
    case 'number':
      for (const n of [7 + (++counter % 50), 1, 100, 0.5]) {
        if (schema.safeParse(n).success) return n
      }
      return undefined
    case 'bigint':
      return BigInt(7 + ++counter)
    case 'boolean':
      return true
    case 'literal':
      return def.values?.[0] ?? def.value
    case 'enum':
      return Object.values(def.entries ?? {})[0]
    case 'array': {
      // Lengths a schema is likely to demand: one, a pair, or a 32-byte digest.
      for (const n of [1, 2, 32]) {
        const list = Array.from({ length: n }, () =>
          sample(def.element, depth + 1),
        )
        if (schema.safeParse(list).success) return list
      }
      return [sample(def.element, depth + 1)]
    }
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries<any>(def.shape)) {
        const s = sample(v, depth + 1)
        if (s !== undefined) out[k] = s
      }
      return out
    }
    case 'union': {
      for (const option of def.options) {
        const s = sample(option, depth + 1)
        if (schema.safeParse(s).success) return s
      }
      return sample(def.options[0], depth + 1)
    }
    default:
      return undefined
  }
}

/** A full input (every optional set), or the required-only one if that fails. */
function sampleInput(
  shape: Record<string, z.ZodType>,
): Record<string, unknown> {
  const object = z.object(shape)
  const full: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(shape)) {
    const s = sample(v)
    if (s !== undefined) full[k] = s
  }
  if (object.safeParse(full).success) return full
  const required: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(shape)) {
    if (!v.safeParse(undefined).success) required[k] = full[k]
  }
  return required
}

// ─── Value containment ──────────────────────────────────────────────────────

function leaves(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(leaves)
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(leaves)
  }
  return [value]
}

function reaches(haystack: unknown, needle: unknown, depth = 0): boolean {
  if (depth > 10) return false
  if (typeof haystack === 'function') return false // a recorder proxy
  if (haystack === needle) return true
  if (
    (typeof haystack === 'bigint' || typeof haystack === 'number') &&
    typeof needle === 'string' &&
    String(haystack) === needle
  ) {
    return true
  }
  if (Array.isArray(haystack)) {
    return haystack.some((h) => reaches(h, needle, depth + 1))
  }
  if (haystack && typeof haystack === 'object') {
    return Object.values(haystack).some((h) => reaches(h, needle, depth + 1))
  }
  return false
}

/**
 * Inputs a handler may consume itself rather than pass to its SDK call, with
 * why — prepare and read tools alike. Everything else must reach the call.
 */
const CONSUMED_BY_HANDLER: Record<string, Record<string, string>> = {
  orders_fees: {
    storageUnitId:
      'An alternative pool selector: with poolId given, the handler uses poolId alone.',
    assetId:
      'An alternative pool selector: with poolId given, the handler uses poolId alone.',
  },
  prepare_coin_swap: {
    slippageBps:
      'Only derives minOut from a live quote when minOut is omitted; with an explicit minOut it has nothing to do.',
  },
}

/** Calls whose result a handler forwards into its write, so their inputs count. */
const RESOLVERS = new Set(['coins.resolvePool'])

const prepareTools = ALL_TOOLS.filter((t) => t.kind === 'prepare')

describe('prepare tools reach the SDK method they name', () => {
  it('covers every prepare tool', () => {
    expect(prepareTools.length).toBeGreaterThan(100)
  })

  it.each(prepareTools.map((t) => [t.name, t] as const))(
    '%s',
    async (_name, tool) => {
      const shape = tool.inputShape as Record<string, z.ZodType>
      const args = sampleInput(shape)
      const parsed = z.object(shape).safeParse(args)
      if (!parsed.success) {
        throw new Error(
          `could not synthesise a valid input for ${tool.name}: ${parsed.error.message}`,
        )
      }

      const calls: Call[] = []
      const ctx: any = {
        apiKey: 'k',
        config: { mode: 'prepare', network: 'testnet' },
        writeClient: () => recorder(calls),
        readClient: () => recorder(calls, ['#read']),
        keyspaceClient: () => recorder(calls, ['#keyspace']),
        suiClient: () => recorder(calls, ['#sui']),
      }

      await tool.handler(ctx, parsed.data)

      const target = calls.filter((c) => methodPath(c.path) === tool.sdkPath)
      expect({ tool: tool.name, calls: target.length }).toEqual({
        tool: tool.name,
        calls: expect.any(Number),
      })
      if (target.length === 0) {
        throw new Error(
          `${tool.name} never called ${tool.sdkPath}; it called: ${[
            ...new Set(calls.map((c) => methodPath(c.path))),
          ].join(', ')}`,
        )
      }

      // Inputs may reach the method itself, the handle it hangs off
      // (`org(orgId, { seat })` for `org.*.x`), or a resolver whose result
      // the handler passes on (the coin-pool selector).
      const targetPath = target[0].path
      const feeding = calls.filter((c) => {
        const p = methodPath(c.path)
        if (RESOLVERS.has(p)) return true
        return (
          c.path.length < targetPath.length &&
          c.path.every((seg, i) => targetPath[i] === seg)
        )
      })
      const consumed = CONSUMED_BY_HANDLER[tool.name] ?? {}
      const passed = [...target, ...feeding].flatMap((c) => c.args)
      const lost: string[] = []
      for (const [key, value] of Object.entries(parsed.data)) {
        if (key === 'sender' || key in consumed) continue
        for (const leaf of leaves(value)) {
          if (leaf === undefined || typeof leaf === 'boolean') continue
          if (!reaches(passed, leaf)) lost.push(`${key}=${String(leaf)}`)
        }
      }
      expect(lost).toEqual([])
    },
  )
})

/**
 * The read tools, more loosely. `ReadOnlyClient` names its methods its own
 * way (`orders.get` → `order`, `routing.compare` → `compareRoutes`), so
 * method identity is left to the parity gate's alias rules; what this checks
 * is the bug the gate can't see — an input that never reaches the SDK.
 */
const readTools = ALL_TOOLS.filter((t) => t.kind === 'read')

describe('read tools pass every input to the SDK', () => {
  it.each(readTools.map((t) => [t.name, t] as const))(
    '%s',
    async (_name, tool) => {
      const shape = tool.inputShape as Record<string, z.ZodType>
      const parsed = z.object(shape).safeParse(sampleInput(shape))
      if (!parsed.success) {
        throw new Error(
          `could not synthesise a valid input for ${tool.name}: ${parsed.error.message}`,
        )
      }
      const calls: Call[] = []
      const ctx: any = {
        apiKey: 'k',
        config: { mode: 'read', network: 'testnet' },
        // Identity passed to a client counts as reaching the SDK.
        writeClient: (...args: unknown[]) => {
          calls.push({ path: ['#ctx.writeClient'], args })
          return recorder(calls)
        },
        readClient: () => recorder(calls, ['#read']),
        keyspaceClient: () => recorder(calls, ['#keyspace']),
        suiClient: () => recorder(calls, ['#sui']),
      }
      // A handler may validate locally and throw by design for a synthetic
      // input (an XOR of two optional filters); what it passed before that
      // still counts.
      await tool.handler(ctx, parsed.data).catch(() => undefined)

      expect(calls.length).toBeGreaterThan(0)
      const consumed = CONSUMED_BY_HANDLER[tool.name] ?? {}
      const passed = calls.flatMap((c) => c.args)
      const lost: string[] = []
      for (const [key, value] of Object.entries(parsed.data)) {
        if (key in consumed) continue
        for (const leaf of leaves(value)) {
          if (leaf === undefined || typeof leaf === 'boolean') continue
          if (!reaches(passed, leaf)) lost.push(`${key}=${String(leaf)}`)
        }
      }
      expect(lost).toEqual([])
    },
  )
})

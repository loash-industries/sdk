import { createContext } from '../src/context.js'
import { loadConfig } from '../src/env.js'

/**
 * Which gateway a caller's key is sent to. The trading and Keyspace clients
 * must agree, or one tool works and the next 401s with the same key.
 */
describe('TRIEX_GATEWAY', () => {
  const realFetch = global.fetch
  let requested: URL[]

  beforeEach(() => {
    requested = []
    global.fetch = (async (input: any) => {
      requested.push(new URL(String(input)))
      return new Response(
        JSON.stringify({ data: [], next_cursor: null, prev_cursor: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
  })
  afterEach(() => {
    global.fetch = realFetch
  })

  /** One trading read and one Keyspace read through a fresh context. */
  async function readBoth(env: Record<string, string>): Promise<string[]> {
    const ctx = createContext(
      'k',
      loadConfig({ TRIEX_MCP_MODE: 'read', ...env } as NodeJS.ProcessEnv),
      {} as never,
    )
    await ctx.readClient().discover()
    await ctx
      .keyspaceClient()
      .getAccessibleAcls('0xabc')
      .catch(() => undefined)
    return requested.map((u) => `${u.origin}${u.pathname}`)
  }

  it('reads through Voidwire by default', async () => {
    expect(await readBoth({})).toEqual([
      'https://api.voidwire.xyz/explore/v1/discovery',
      'https://api.voidwire.xyz/orgs/v1/players/0xabc/accessible-keyspaces',
    ])
  })

  it('reads through Trinary Exchange with TRIEX_GATEWAY=triex', async () => {
    expect(await readBoth({ TRIEX_GATEWAY: 'triex' })).toEqual([
      'https://api.trinary.exchange/v1/discovery',
      'https://api.trinary.exchange/v1/players/0xabc/accessible-keyspaces',
    ])
  })

  it('keeps Trinary Exchange for a TRIEX_API_URL that names it', async () => {
    expect(
      await readBoth({ TRIEX_API_URL: 'https://api.trinary.exchange' }),
    ).toEqual([
      'https://api.trinary.exchange/v1/discovery',
      'https://api.trinary.exchange/v1/players/0xabc/accessible-keyspaces',
    ])
  })

  it('rejects anything but voidwire or triex', () => {
    expect(() =>
      loadConfig({ TRIEX_GATEWAY: 'sluice' } as NodeJS.ProcessEnv),
    ).toThrow('TRIEX_GATEWAY must be "voidwire" or "triex"')
  })
})

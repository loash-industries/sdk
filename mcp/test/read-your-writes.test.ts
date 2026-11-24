import { jest } from '@jest/globals'
import { createContext } from '../src/context.js'
import { loadConfig } from '../src/env.js'
import { ALL_TOOLS } from '../src/registry.js'

/**
 * `minCheckpoint` on the read tools whose endpoints support read-your-writes:
 * it must reach the wire as `min_checkpoint`, or the agent's "read past my
 * write" silently becomes a plain, possibly stale read.
 */
const config = loadConfig({
  TRIEX_MCP_MODE: 'read',
  TRIEX_INDEXER_URL: 'https://api.example.test',
} as NodeJS.ProcessEnv)
const HEX = `0x${'7f'.repeat(32)}`

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

describe('minCheckpoint reaches the gateway', () => {
  it.each([
    ['orders_open', { tradingAccountId: HEX }, { data: [], next_cursor: null }],
    [
      'orders_trades',
      { tradingAccountId: HEX },
      { data: [], next_cursor: null },
    ],
    [
      'account_sweepable',
      { tradingAccountId: HEX },
      { trading_account_id: HEX, as_of_checkpoint: '1', pools: [], items: [] },
    ],
    ['org_for_player', { address: HEX }, []],
    ['org_vaults_at_hub', { hubId: HEX }, []],
  ])('%s', async (name, args, payload) => {
    const fetchMock = captureFetch(payload)
    const ctx = createContext('tenant-key', config, {} as any)
    await tool(name)
      .handler(ctx, { ...args, minCheckpoint: '410269239' })
      .catch(() => undefined)
    const url = fetchMock.mock.calls[0]![0] as URL
    expect(url.searchParams.get('min_checkpoint')).toBe('410269239')
  })

  it('takes the checkpoint as a decimal string, never a JSON number', () => {
    const shape = tool('orders_open').inputShape as any
    expect(shape.minCheckpoint.safeParse('410269239').success).toBe(true)
    expect(shape.minCheckpoint.safeParse(410269239).success).toBe(false)
  })
})

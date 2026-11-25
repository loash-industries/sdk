import { jest } from '@jest/globals'
import { createContext } from '../src/context.js'
import { loadConfig } from '../src/env.js'
import { ALL_TOOLS, toolsForMode } from '../src/registry.js'

/**
 * The hauling-agreement tools: input → SDK → the URL that leaves the process,
 * plus the bigint amounts coming back as decimal strings. TypeScript cannot
 * check these handlers against the SDK, and the parity gate only checks
 * names, so an inspected request is the witness.
 */
const config = loadConfig({
  TRIEX_MCP_MODE: 'read',
  TRIEX_INDEXER_URL: 'https://api.example.test',
  TRIEX_GATEWAY: 'triex',
} as NodeJS.ProcessEnv)

const HEX = `0x${'7f'.repeat(32)}`
const WALLET = `0x${'2a'.repeat(32)}`
const CRED = '0x9f3a1b2c::cred::CRED'

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

const coin = { coin_type: CRED, symbol: 'CRED', name: null, decimals: 9 }
const party = { address: WALLET, character_name: null }
const agreement = {
  agreement_id: HEX,
  status: 'open',
  posted_at: 1,
  accept_deadline_at: 2,
  haul_duration_ms: 3,
  lister: party,
  beneficiary: party,
  pays_cap_holder: false,
  on_behalf_of: null,
  cargo: [],
  want: [],
  currency: coin,
  reward: '123456789012345678901',
  collateral: '0',
  delivery_fee_bps: 250,
  claim_gated: false,
  has_other_rules: false,
  hauler: null,
  hauler_identity: null,
  accepted_at: null,
  delivery_deadline_at: null,
  closed_at: null,
  closed_by: null,
  hauler_reward: null,
  delivery_fee: null,
  refunded_to: null,
  cap_id: HEX,
  posted_tx_digest: 'D',
  accepted_tx_digest: null,
  closed_tx_digest: null,
}
const page = { data: [agreement], next_cursor: null, evaluated_at: 9 }
const actionsPage = { data: [], next_cursor: null, evaluated_at: 9 }
const statusCounts = {
  open: 0,
  lapsed: 0,
  accepted: 0,
  overdue: 0,
  delivered: 0,
  defaulted: 0,
  forfeited: 0,
  cancelled: 0,
  closed_lapsed: 0,
}

describe('hauling tools reach the endpoint their inputs describe', () => {
  const cases: Array<{
    tool: string
    args: Record<string, unknown>
    payload: unknown
    path: string
    query?: Record<string, string>
  }> = [
    {
      tool: 'hauling_agreements',
      args: {
        status: ['open', 'accepted'],
        minReward: '1000',
        sourceHubId: HEX,
        claimableBy: WALLET,
        sort: 'reward_desc',
        limit: 10,
        minCheckpoint: '42',
      },
      payload: page,
      path: '/v1/agreements',
      query: {
        status: 'open,accepted',
        min_reward: '1000',
        source_hub_id: HEX,
        claimable_by: WALLET,
        sort: 'reward_desc',
        limit: '10',
        min_checkpoint: '42',
      },
    },
    {
      tool: 'hauling_agreement',
      args: { agreementId: HEX, viewer: WALLET },
      payload: {
        ...agreement,
        requirements: [],
        observer: null,
        cap: {
          cap_id: HEX,
          owner_kind: null,
          owner: null,
          owner_name: null,
          receives_proceeds: true,
          ended_kind: null,
        },
        proceeds: null,
        fees: {
          post_fee: null,
          delivery_fee_bps: 250,
          delivery_fee: null,
          treasury: WALLET,
        },
        claims: [],
        timeline: [],
        viewer: null,
        evaluated_at: 9,
      },
      path: `/v1/agreements/${HEX}`,
      query: { viewer: WALLET },
    },
    {
      tool: 'hauling_config',
      args: {},
      payload: {
        config_id: HEX,
        currencies: [coin],
        post_fee: null,
        delivery_fee_bps: 250,
        treasury: WALLET,
        updated_at: 1,
        history: [],
      },
      path: '/v1/agreements/config',
    },
    {
      tool: 'hauling_stats',
      args: {},
      payload: {
        by_status: statusCounts,
        by_currency: [],
        post_fees: [],
        lanes: [],
        evaluated_at: 9,
      },
      path: '/v1/agreements/stats',
    },
    {
      tool: 'hauling_org_agreements',
      args: { orgId: HEX, relation: 'claimed_via', status: 'delivered' },
      payload: page,
      path: `/v1/orgs/${HEX}/agreements`,
      query: { relation: 'claimed_via', status: 'delivered' },
    },
    {
      tool: 'hauling_player_agreements',
      args: { address: WALLET, role: ['hauler'], cursor: 'c' },
      payload: page,
      // The address belongs in the PATH; as a query key it would be ignored.
      path: `/v1/players/${WALLET}/agreements`,
      query: { role: 'hauler', cursor: 'c' },
    },
    {
      tool: 'hauling_actions',
      args: { address: WALLET },
      payload: actionsPage,
      path: `/v1/players/${WALLET}/agreements/actions`,
    },
    {
      tool: 'hauling_claimable',
      args: { address: WALLET, includeUnknown: true },
      payload: { ...actionsPage },
      path: `/v1/players/${WALLET}/agreements/claimable`,
      query: { include_unknown: 'true' },
    },
    {
      tool: 'hauling_reputation',
      args: { address: WALLET },
      payload: {
        address: WALLET,
        as_hauler: {
          accepted: 0,
          in_progress: 0,
          overdue: 0,
          delivered: 0,
          defaulted: 0,
          forfeited: 0,
          completion_rate: null,
          net_reward: [],
          collateral_lost: [],
        },
        as_lister: { posted: 0, ...statusCounts, in_progress: 0 },
        evaluated_at: 9,
      },
      path: `/v1/players/${WALLET}/agreements/reputation`,
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

describe('hauling tool outputs and inputs', () => {
  it('returns amounts past 2^53 as exact decimal strings', async () => {
    captureFetch(page)
    const ctx = createContext('tenant-key', config, {} as any)
    const res = await tool('hauling_agreements').handler(ctx, {})
    expect(body(res).agreements[0].reward).toBe('123456789012345678901')
  })

  it('takes amounts and checkpoints as decimal strings, never JSON numbers', () => {
    const shape = tool('hauling_agreements').inputShape as any
    expect(shape.minReward.safeParse('1000').success).toBe(true)
    expect(shape.minReward.safeParse(1000).success).toBe(false)
    expect(shape.minCheckpoint.safeParse('42').success).toBe(true)
    expect(shape.minCheckpoint.safeParse(42).success).toBe(false)
  })

  it('requires the address on player-scoped tools — this server has no player', () => {
    for (const name of [
      'hauling_player_agreements',
      'hauling_actions',
      'hauling_claimable',
      'hauling_reputation',
    ]) {
      const shape = tool(name).inputShape as any
      expect(shape.address.safeParse(undefined).success).toBe(false)
    }
  })

  it('exposes every hauling read to a read-only deployment', () => {
    const names = toolsForMode('read').map((t) => t.name)
    for (const name of [
      'hauling_agreements',
      'hauling_agreement',
      'hauling_config',
      'hauling_stats',
      'hauling_org_agreements',
      'hauling_player_agreements',
      'hauling_actions',
      'hauling_claimable',
      'hauling_reputation',
    ]) {
      expect(names).toContain(name)
    }
  })
})

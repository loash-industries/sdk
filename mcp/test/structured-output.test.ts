import { jest } from '@jest/globals'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createContext } from '../src/context.js'
import { loadConfig } from '../src/env.js'
import { ok } from '../src/result.js'
import { createServer } from '../src/server.js'

/**
 * Structured tool output, through the real MCP server: prepare tools
 * advertise the prepared-transaction envelope as their outputSchema, every
 * successful call carries structuredContent, and the server's own output
 * validation accepts what the tools return.
 */
const config = loadConfig({
  TRIEX_MCP_MODE: 'prepare',
  TRIEX_INDEXER_URL: 'https://api.example.test',
  TRIEX_GATEWAY: 'triex',
} as NodeJS.ProcessEnv)

async function connect(sui: any = {}) {
  const ctx = createContext('tenant-key', config, sui)
  const server = createServer(ctx)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

afterEach(() => jest.restoreAllMocks())

describe('structured tool output', () => {
  it('wraps arrays and primitives so structuredContent is always an object', () => {
    expect(ok({ a: 1n }).structuredContent).toEqual({ a: '1' })
    expect(ok([1, 2]).structuredContent).toEqual({ items: [1, 2] })
    expect(ok('x').structuredContent).toEqual({ value: 'x' })
  })

  it('advertises the prepared envelope on prepare tools only', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    const prepare = tools.filter((t) => t.name.startsWith('prepare_'))
    const read = tools.filter((t) => !t.name.startsWith('prepare_'))
    expect(prepare.length).toBeGreaterThan(100)
    for (const t of prepare) {
      expect(t.outputSchema?.properties).toHaveProperty('prepared')
      expect(t.outputSchema?.properties).toHaveProperty('txKindBytes')
      expect(t.outputSchema?.required).toEqual(['prepared'])
    }
    for (const t of read) expect(t.outputSchema).toBeUndefined()
  })

  it('a read call returns structuredContent next to the text', async () => {
    ;(global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => ({
        by_status: {
          open: 1,
          lapsed: 0,
          accepted: 0,
          overdue: 0,
          delivered: 0,
          defaulted: 0,
          forfeited: 0,
          cancelled: 0,
          closed_lapsed: 0,
        },
        by_currency: [],
        post_fees: [],
        lanes: [],
        evaluated_at: 9,
      }),
    }))
    const client = await connect()
    const res: any = await client.callTool({
      name: 'hauling_stats',
      arguments: {},
    })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toMatchObject({ byStatus: { open: 1 } })
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent)
  })

  it('a built prepare call passes the server’s own output validation', async () => {
    const SENDER = '0x'.padEnd(66, 'a')
    const AGREEMENT = '0x'.padEnd(66, '1')
    const CAP = '0x'.padEnd(66, 'c')
    const party = { address: SENDER, character_name: null }
    ;(global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => ({
        agreement_id: AGREEMENT,
        status: 'open',
        posted_at: 1,
        accept_deadline_at: 2,
        haul_duration_ms: 3,
        lister: party,
        beneficiary: party,
        pays_cap_holder: true,
        on_behalf_of: null,
        cargo: [],
        want: [],
        currency: {
          coin_type: '0x2::sui::SUI',
          symbol: 'SUI',
          name: null,
          decimals: 9,
        },
        reward: '1',
        collateral: '1',
        delivery_fee_bps: 0,
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
        cap_id: CAP,
        posted_tx_digest: 'D',
        accepted_tx_digest: null,
        closed_tx_digest: null,
        requirements: [],
        observer: null,
        cap: {
          cap_id: CAP,
          owner_kind: 'address',
          owner: SENDER,
          owner_name: null,
          receives_proceeds: true,
          ended_kind: null,
        },
        proceeds: null,
        fees: {
          post_fee: null,
          delivery_fee_bps: 0,
          delivery_fee: null,
          treasury: SENDER,
        },
        claims: [],
        timeline: [],
        viewer: null,
        evaluated_at: 9,
      }),
    }))
    // A fullnode that resolves the cap (owned) and the agreement (shared).
    const arity: Record<string, number> = { cancel: 3, pay_all: 1 }
    const sui = {
      core: new Proxy(
        {},
        {
          get: (_t, name: string) =>
            name === 'resolveTransactionPlugin'
              ? () => undefined
              : async (args: any) => {
                  if (name === 'getObjects') {
                    return {
                      objects: args.objectIds.map((objectId: string) => ({
                        objectId,
                        version: '7',
                        digest: '11111111111111111111111111111111',
                        owner:
                          objectId === CAP
                            ? { $kind: 'AddressOwner', AddressOwner: SENDER }
                            : {
                                $kind: 'Shared',
                                Shared: { initialSharedVersion: '1' },
                              },
                      })),
                    }
                  }
                  if (name === 'getMoveFunction') {
                    return {
                      function: {
                        parameters: Array.from(
                          { length: arity[args.name] ?? 0 },
                          () => ({
                            reference: 'mutable',
                            body: {
                              $kind: 'datatype',
                              datatype: {
                                typeName: '0x2::object::UID',
                                typeParameters: [],
                              },
                            },
                          }),
                        ),
                      },
                    }
                  }
                  throw new Error(`core.${name} not stubbed`)
                },
        },
      ),
    }
    const client = await connect(sui)
    const res: any = await client.callTool({
      name: 'prepare_hauling_cancel',
      arguments: { sender: SENDER, agreementId: AGREEMENT },
    })
    // Had the envelope not matched the declared outputSchema, the server
    // would have answered with an output-validation error instead.
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toMatchObject({
      prepared: true,
      sender: SENDER,
      intent: { action: 'hauling_cancel' },
    })
    expect(typeof res.structuredContent.txKindBytes).toBe('string')
  })
})

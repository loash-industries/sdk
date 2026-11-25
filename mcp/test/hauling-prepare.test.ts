import { jest } from '@jest/globals'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { createContext } from '../src/context.js'
import { loadConfig } from '../src/env.js'
import { ALL_TOOLS, toolsForMode } from '../src/registry.js'

/**
 * The hauling prepare tools, driven end to end: tool input → SDK write →
 * captured transaction → prepared bytes, against a fake fullnode and a stubbed
 * gateway. The intent's Move targets come from the built bytes, so they are
 * what a caller's allowlist would check.
 */
const config = loadConfig({
  TRIEX_MCP_MODE: 'prepare',
  TRIEX_INDEXER_URL: 'https://api.example.test',
  TRIEX_GATEWAY: 'triex',
} as NodeJS.ProcessEnv)

const SENDER = '0x'.padEnd(66, 'a')
const AGREEMENT = '0x'.padEnd(66, '1')
const CAP = '0x'.padEnd(66, 'c')
const DIGEST = '11111111111111111111111111111111'

const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!
const body = (res: { content: { text: string }[] }) =>
  JSON.parse(res.content[0]!.text)

/** Fullnode stub: the lister cap is the sender's, everything else shared. */
function fakeSui(arity: Record<string, number>): any {
  const impl: Record<string, (args: any) => any> = {
    getObjects: ({ objectIds }: { objectIds: string[] }) => ({
      objects: objectIds.map((objectId) => ({
        objectId,
        version: '7',
        digest: DIGEST,
        owner:
          objectId === CAP
            ? { $kind: 'AddressOwner', AddressOwner: SENDER }
            : { $kind: 'Shared', Shared: { initialSharedVersion: '1' } },
      })),
    }),
    getMoveFunction: ({ name }: { name: string }) => {
      const n = arity[name]
      if (n === undefined)
        throw new Error(`getMoveFunction(${name}) not stubbed`)
      return {
        function: {
          parameters: Array.from({ length: n }, () => ({
            reference: 'mutable',
            body: {
              $kind: 'datatype',
              datatype: { typeName: '0x2::object::UID', typeParameters: [] },
            },
          })),
        },
      }
    },
  }
  return {
    core: new Proxy(
      {},
      {
        get: (_t, name: string) =>
          name === 'resolveTransactionPlugin'
            ? () => undefined
            : async (args: any) => {
                const fn = impl[name]
                if (!fn) throw new Error(`core.${name} not stubbed`)
                return fn(args)
              },
      },
    ),
  }
}

function stubAgreement(over: Record<string, unknown>) {
  const coin = {
    coin_type: '0x2::sui::SUI',
    symbol: 'SUI',
    name: null,
    decimals: 9,
  }
  const party = { address: SENDER, character_name: null }
  const payload = {
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
    currency: coin,
    reward: '1000',
    collateral: '300',
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
      delivery_fee_bps: 250,
      delivery_fee: null,
      treasury: SENDER,
    },
    claims: [],
    timeline: [],
    viewer: null,
    evaluated_at: 9,
    ...over,
  }
  ;(global as any).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => payload,
  }))
}

afterEach(() => jest.restoreAllMocks())

describe('hauling prepare tools', () => {
  it('prepare_hauling_cancel returns cargo and reward to the lister', async () => {
    stubAgreement({ status: 'open' })
    const ctx = createContext(
      'tenant-key',
      config,
      fakeSui({ cancel: 3, pay_all: 1 }),
    )
    const res = await tool('prepare_hauling_cancel').handler(ctx, {
      sender: SENDER,
      agreementId: AGREEMENT,
    })
    expect(res.isError).toBeFalsy()
    const prepared = body(res)
    const hauling = normalizeSuiAddress(
      ctx.writeClient(SENDER).ids.haulingAgreements!,
    )
    const agreements = normalizeSuiAddress(
      ctx.writeClient(SENDER).ids.agreements!,
    )
    expect(prepared.intent.targets).toEqual([
      `${hauling}::hauling::cancel`,
      `${agreements}::payout::pay_all`,
    ])
    expect(prepared.intent.action).toBe('hauling_cancel')
    expect(prepared.pinnedObjects).toEqual(
      expect.arrayContaining([
        { objectId: CAP, version: '7', kind: 'owned' },
        { objectId: AGREEMENT, version: '1', kind: 'shared' },
      ]),
    )
  })

  it('prepare_hauling_default builds the permissionless default', async () => {
    stubAgreement({ status: 'overdue' })
    const ctx = createContext('tenant-key', config, fakeSui({ default: 2 }))
    const res = await tool('prepare_hauling_default').handler(ctx, {
      sender: SENDER,
      agreementId: AGREEMENT,
    })
    expect(res.isError).toBeFalsy()
    expect(body(res).intent.targets).toHaveLength(1)
    expect(body(res).intent.targets[0]).toMatch(/::hauling::default$/)
  })

  it('refuses before building when the status rules the action out', async () => {
    stubAgreement({ status: 'delivered' })
    const ctx = createContext('tenant-key', config, fakeSui({}))
    await expect(
      tool('prepare_hauling_forfeit').handler(ctx, {
        sender: SENDER,
        agreementId: AGREEMENT,
      }),
    ).rejects.toMatchObject({ code: 'TRIEX_VALIDATION_FAILED' })
  })

  it('is registered for prepare deployments only', () => {
    const read = toolsForMode('read').map((t) => t.name)
    const prepare = toolsForMode('prepare').map((t) => t.name)
    for (const name of [
      'prepare_hauling_post',
      'prepare_hauling_accept',
      'prepare_hauling_deliver',
      'prepare_hauling_cancel',
      'prepare_hauling_default',
      'prepare_hauling_forfeit',
      'prepare_hauling_collect',
      'prepare_hauling_delete_cap',
    ]) {
      expect(prepare).toContain(name)
      expect(read).not.toContain(name)
    }
  })
})

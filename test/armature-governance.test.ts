import { jest } from '@jest/globals'
import {
  fetchDaoGovernance,
  parseEnabledProposalTypes,
  parseProposalConfigs,
  parseTypeBindings,
} from '../src/armature/governance'

/** gRPC proto-JSON: struct fields exposed directly. */
const grpcDao = {
  enabled_proposal_types: { contents: ['SetBoard', 'Composite'] },
  proposal_configs: {
    contents: [
      {
        key: 'SetBoard',
        value: {
          quorum: 6600,
          approval_threshold: 6600,
          propose_threshold: '0',
          expiry_ms: '604800000',
          execution_delay_ms: '0',
          cooldown_ms: '0',
          composable_allowed: true,
        },
      },
    ],
  },
  type_bindings: {
    contents: [{ key: 'SetBoard', value: '0x2::set_board::SetBoard' }],
  },
}

/** JSON-RPC: the same struct, nested one `.fields` layer deeper. */
const jsonRpcDao = {
  enabled_proposal_types: { fields: { contents: ['SetBoard', 'Composite'] } },
  proposal_configs: {
    fields: {
      contents: [
        {
          fields: {
            key: 'SetBoard',
            value: {
              fields: {
                quorum: 6600,
                approval_threshold: 6600,
                propose_threshold: '0',
                expiry_ms: '604800000',
                execution_delay_ms: '0',
                cooldown_ms: '0',
                composable_allowed: true,
              },
            },
          },
        },
      ],
    },
  },
  type_bindings: {
    fields: {
      contents: [
        { fields: { key: 'SetBoard', value: '0x2::set_board::SetBoard' } },
      ],
    },
  },
}

describe('governance parsing', () => {
  it.each([
    ['gRPC proto-JSON', grpcDao],
    ['JSON-RPC (.fields nested)', jsonRpcDao],
  ])('parses identically across transports: %s', (_label, dao) => {
    expect([...parseEnabledProposalTypes(dao)]).toEqual([
      'SetBoard',
      'Composite',
    ])
    expect(parseProposalConfigs(dao).get('SetBoard')).toEqual({
      quorum: 6600,
      approvalThreshold: 6600,
      proposeThreshold: 0,
      // u64s arrive as decimal STRINGS and must survive as numbers.
      expiryMs: 604_800_000,
      executionDelayMs: 0,
      cooldownMs: 0,
      composableAllowed: true,
    })
    expect(parseTypeBindings(dao).get('SetBoard')).toBe(
      '0x2::set_board::SetBoard',
    )
  })

  it('defaults composable_allowed to false when absent', () => {
    const cfg = parseProposalConfigs({
      proposal_configs: { contents: [{ key: 'X', value: { quorum: 1 } }] },
    })
    expect(cfg.get('X')?.composableAllowed).toBe(false)
    // Missing numerics default to 0 rather than NaN.
    expect(cfg.get('X')?.expiryMs).toBe(0)
  })

  it('returns empties for a DAO object missing the fields entirely', () => {
    expect(parseEnabledProposalTypes({}).size).toBe(0)
    expect(parseProposalConfigs({}).size).toBe(0)
    expect(parseTypeBindings({}).size).toBe(0)
  })

  it('skips malformed entries instead of throwing', () => {
    const cfg = parseProposalConfigs({
      proposal_configs: {
        contents: [
          { key: 42, value: { quorum: 1 } }, // non-string key
          { key: 'ok', value: null }, // no value
          { key: 'good', value: { quorum: 7 } },
        ],
      },
    })
    expect([...cfg.keys()]).toEqual(['good'])

    expect([
      ...parseEnabledProposalTypes({
        enabled_proposal_types: { contents: ['a', 5, null, 'b'] },
      }),
    ]).toEqual(['a', 'b'])
  })
})

describe('fetchDaoGovernance', () => {
  it('reads the DAO object once and returns all three views', async () => {
    const getObject = jest.fn(async () => ({ object: { json: grpcDao } }))
    const suiClient = { core: { getObject } } as never

    const gov = await fetchDaoGovernance(suiClient, '0xdao')
    expect(getObject).toHaveBeenCalledWith({
      objectId: '0xdao',
      include: { json: true },
    })
    expect(gov.enabledTypes.has('Composite')).toBe(true)
    expect(gov.configs.get('SetBoard')?.quorum).toBe(6600)
    expect(gov.typeBindings.size).toBe(1)
  })

  it('tolerates an object with no json payload', async () => {
    const suiClient = {
      core: { getObject: async () => ({ object: {} }) },
    } as never
    const gov = await fetchDaoGovernance(suiClient, '0xdao')
    expect(gov.enabledTypes.size).toBe(0)
  })
})

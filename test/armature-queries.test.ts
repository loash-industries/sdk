import { jest } from '@jest/globals'
import { IndexerClient } from '../src/queries'
import { ReadOnlyClient } from '../src/ReadOnlyClient'
import { TriexClientError, TriexError } from '../src/errors'
import { iterateOrgDirectory } from '../src/paging'

const ORG = '0x7f3a9b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8'
const OFFICERS =
  '0x1111111111111111111111111111111111111111111111111111111111111111'
const ADDR =
  '0x2a4b6e7c8d9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b'

/** Queue JSON payloads; each fetch call shifts one. Returns the call log. */
function mockFetch(payloads: unknown[]): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payloads.shift(),
  }))
  ;(global as any).fetch = fn
  return fn
}

function mockStatus(status: number, body: unknown = {}): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: false,
    status,
    statusText: 'Err',
    headers: { get: () => null },
    json: async () => body,
  }))
  ;(global as any).fetch = fn
  return fn
}

/** A minimal wire org; `over` patches the top level. */
function wireOrg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org_id: ORG,
    charter_id: null,
    treasury_id: null,
    capability_vault_id: null,
    emergency_freeze_id: null,
    name: 'Northwind',
    metadata_uri: null,
    metadata: {},
    members: [],
    ous: [],
    trading_account_id: null,
    subdao_control_cap_id: null,
    ...over,
  }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('OrgQueries request building', () => {
  it('parses a nested org tree and camelCases the whole way down', async () => {
    mockFetch([
      wireOrg({
        charter_id: ORG,
        treasury_id: ORG,
        capability_vault_id: ORG,
        emergency_freeze_id: ORG,
        metadata: { image_url: 'ipfs://icon', description: 'hi', version: 1 },
        members: [ADDR],
        actors: { [ADDR]: { type: 'player', name: 'Rin Farshot' } },
        ous: [
          {
            ...wireOrg({
              org_id: OFFICERS,
              name: 'Northwind — Officers',
              emergency_freeze_id: OFFICERS,
              members: [ADDR],
              trading_account_id: OFFICERS,
              subdao_control_cap_id: OFFICERS,
            }),
          },
        ],
      }),
    ])
    const org = await new IndexerClient('https://api.test', 'k').orgs.get(ORG)

    expect(org.orgId).toBe(ORG)
    expect(org.capabilityVaultId).toBe(ORG)
    expect(org.metadata.imageUrl).toBe('ipfs://icon')
    expect(org.actors?.[ADDR].name).toBe('Rin Farshot')
    // Recursion carries the transform into children.
    expect(org.ous[0].tradingAccountId).toBe(OFFICERS)
    expect(org.ous[0].subdaoControlCapId).toBe(OFFICERS)
  })

  it('surfaces unresolved batch rows instead of dropping them', async () => {
    mockFetch([
      [
        wireOrg(),
        wireOrg({ name: null, metadata: { error_reason: 'unresolved' } }),
      ],
    ])
    const orgs = await new IndexerClient('https://api.test', 'k').orgs.batch([
      ORG,
      '0xdead',
    ])
    expect(orgs).toHaveLength(2)
    expect(orgs[1].name).toBeNull()
    expect(orgs[1].metadata.errorReason).toBe('unresolved')
  })

  it('rejects an over-sized batch locally rather than paying for the 400', async () => {
    const fetchMock = mockFetch([])
    const client = new IndexerClient('https://api.test', 'k')
    await expect(
      client.orgs.batch(Array.from({ length: 201 }, () => ORG)),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('short-circuits an empty batch without a request', async () => {
    const fetchMock = mockFetch([])
    const client = new IndexerClient('https://api.test', 'k')
    await expect(client.orgs.batch([])).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends directory paging params', async () => {
    const fetchMock = mockFetch([{ data: [], next_cursor: null }])
    await new IndexerClient('https://api.test', 'k').orgs.directory({
      limit: 50,
      cursor: 'MTAw',
      sort: 'name',
    })
    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(String(url)).toContain('/v1/orgs/directory')
    expect(url.searchParams.get('limit')).toBe('50')
    expect(url.searchParams.get('cursor')).toBe('MTAw')
    expect(url.searchParams.get('sort')).toBe('name')
  })

  it('scopes search to orgs and reads only the orgs group', async () => {
    const fetchMock = mockFetch([
      {
        characters: [
          { object_id: ORG, address: ADDR, name: 'Rin', tribe_id: null },
        ],
        orgs: [
          {
            org_id: OFFICERS,
            name: 'Northwind — Officers',
            treasury_id: ORG,
            root_org_id: ORG,
            root_name: 'Northwind',
            depth: 1,
          },
        ],
      },
    ])
    const hits = await new IndexerClient('https://api.test', 'k').orgs.search(
      'north',
      { limit: 10, enrich: true },
    )
    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.searchParams.get('q')).toBe('north')
    expect(url.searchParams.get('orgs')).toBe('true')
    expect(url.searchParams.get('characters')).toBe('false')
    expect(url.searchParams.get('enrich_orgs')).toBe('true')
    expect(hits).toEqual([
      expect.objectContaining({ orgId: OFFICERS, rootOrgId: ORG, depth: 1 }),
    ])
  })

  it('tolerates a search response with no orgs key', async () => {
    mockFetch([{ characters: [] }])
    await expect(
      new IndexerClient('https://api.test', 'k').orgs.search('nope'),
    ).resolves.toEqual([])
  })

  it('parses composite proposal steps', async () => {
    mockFetch([
      [
        {
          proposal_id: ORG,
          org_id: ORG,
          type_key: 'Composite',
          proposer: ADDR,
          status: 'pending',
          yes_weight: 1,
          no_weight: 0,
          payload_type: '0x2::composite::CompositePayload',
          frame_id: OFFICERS,
          created_checkpoint: 4321,
          composite: [
            {
              step_index: 0,
              step_type_key: 'SetBoard',
              step_type: '0x2::set_board::SetBoard',
            },
            { step_index: 1, step_type_key: 'UpdateMetadata', step_type: null },
          ],
        },
      ],
    ])
    const [p] = await new IndexerClient('https://api.test', 'k').orgs.proposals(
      ORG,
    )
    expect(p.frameId).toBe(OFFICERS)
    expect(p.createdCheckpoint).toBe(4321)
    expect(p.composite?.[1]).toEqual({
      stepIndex: 1,
      stepTypeKey: 'UpdateMetadata',
      stepType: null,
    })
  })

  it('passes the keyspace role filter through', async () => {
    const fetchMock = mockFetch([
      [
        {
          acl_id: ORG,
          matched_org_id: null,
          name: 'locations',
          registrant_org_id: null,
          match_via: 'player_grant',
          roles: ['read'],
        },
      ],
    ])
    const rows = await new IndexerClient(
      'https://api.test',
      'k',
    ).orgs.accessibleKeyspaces(ADDR, 'read')
    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(String(url)).toContain(`/v1/players/${ADDR}/accessible-keyspaces`)
    expect(url.searchParams.get('role')).toBe('read')
    expect(rows[0]).toEqual(
      expect.objectContaining({ aclId: ORG, matchVia: 'player_grant' }),
    )
  })

  it('reshapes vault ACL rows into principals', async () => {
    mockFetch([
      [
        {
          vault_id: ORG,
          registrant_dao_id: OFFICERS,
          hub_id: ORG,
          collection_id: ORG,
          status: 'active',
          acl: [
            {
              role: 'deposit',
              principal_kind: 'ou',
              principal_value: OFFICERS,
            },
            { role: 'edit', principal_kind: 'player', principal_value: ADDR },
          ],
        },
      ],
    ])
    const [v] = await new IndexerClient(
      'https://api.test',
      'k',
    ).orgs.vaultsAtHub(ORG)
    expect(v.registrantOrgId).toBe(OFFICERS)
    expect(v.acl).toEqual([
      { role: 'deposit', principal: { kind: 'ou', value: OFFICERS } },
      { role: 'edit', principal: { kind: 'player', value: ADDR } },
    ])
  })

  it('maps a 404 org to OrgNotFound, not a generic indexer error', async () => {
    mockStatus(404, { message: 'no such org' })
    await expect(
      new IndexerClient('https://api.test', 'k').orgs.get(ORG),
    ).rejects.toMatchObject({ code: TriexError.OrgNotFound, status: 404 })
  })

  it('shares the trading surface error mapping (401 → Unauthorized)', async () => {
    mockStatus(401)
    await expect(
      new IndexerClient('https://api.test', 'k').orgs.directory(),
    ).rejects.toBeInstanceOf(TriexClientError)
    mockStatus(401)
    await expect(
      new IndexerClient('https://api.test', 'k').orgs.directory(),
    ).rejects.toMatchObject({ code: TriexError.Unauthorized })
  })
})

describe('ReadOnlyClient.orgs', () => {
  it('requires an explicit address — it has no configured player', async () => {
    const client = new ReadOnlyClient({ apiKey: 'k' })
    await expect(client.orgs.forPlayer()).rejects.toMatchObject({
      code: TriexError.AddressRequired,
    })
  })

  it('resolves seats and the trading account from one fetch', async () => {
    const tree = wireOrg({
      emergency_freeze_id: ORG,
      members: [ADDR],
      ous: [
        wireOrg({
          org_id: OFFICERS,
          name: 'Officers',
          emergency_freeze_id: OFFICERS,
          members: [ADDR],
          trading_account_id: '0xbm',
        }),
      ],
    })
    mockFetch([tree, tree])
    const client = new ReadOnlyClient({ apiKey: 'k' })

    const seats = await client.orgs.seats(ORG, ADDR)
    expect(seats.map((s) => s.daoId)).toEqual([ORG, OFFICERS])
    // Highest authority first — the root outranks the officers unit.
    expect(seats[0].rank).toBe(0)

    const trading = await client.orgs.tradingAccount(ORG)
    expect(trading?.tradingAccountId).toBe('0xbm')
    expect(trading?.node.daoId).toBe(OFFICERS)
  })
})

describe('iterateOrgDirectory', () => {
  it('follows next_cursor and stops at maxItems', async () => {
    const entry = (id: string) => ({
      org_id: id,
      name: id,
      treasury_id: ORG,
      member_count: 1,
    })
    const fetchMock = mockFetch([
      { data: [entry('a'), entry('b')], next_cursor: 'p2' },
      { data: [entry('c'), entry('d')], next_cursor: null },
    ])
    const indexer = new IndexerClient('https://api.test', 'k')

    const seen: string[] = []
    for await (const e of iterateOrgDirectory(indexer, { sort: 'name' })) {
      seen.push(e.orgId)
    }
    expect(seen).toEqual(['a', 'b', 'c', 'd'])
    const [, second] = fetchMock.mock.calls as unknown as [URL[], URL[]]
    expect((second[0] as URL).searchParams.get('cursor')).toBe('p2')

    mockFetch([{ data: [entry('a'), entry('b')], next_cursor: 'p2' }])
    const capped: string[] = []
    for await (const e of iterateOrgDirectory(indexer, undefined, {
      maxItems: 1,
    })) {
      capped.push(e.orgId)
    }
    expect(capped).toEqual(['a'])
  })
})

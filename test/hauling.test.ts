/**
 * Hauling-agreement reads (`client.hauling`). Each endpoint is pinned three
 * ways, like the other gateway reads: the URL and query names it sends (a
 * misnamed filter is silently ignored upstream), the camelCase shape it
 * returns, and the typed error its failure maps to.
 */
import { jest } from '@jest/globals'
import { IndexerClient } from '../src/queries'
import { ReadOnlyClient } from '../src/ReadOnlyClient'
import { TriexClient } from '../src/TriexClient'
import { TriexError } from '../src/errors'
import {
  iterateAgreements,
  iterateClaimableAgreements,
  iteratePlayerAgreements,
} from '../src/paging'

const HEX = '0x7f3a9b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8'
const WALLET =
  '0x2a4b6e7c8d9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b'
const ORG = `0x${'0a'.repeat(32)}`
const CRED = '0x9f3a1b2c::cred::CRED'

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

function mock404(): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    json: async () => ({ message: 'Agreement not found' }),
  }))
  ;(global as any).fetch = fn
  return fn
}

const urlOf = (fetchMock: jest.Mock, i = 0) => fetchMock.mock.calls[i][0] as URL
const queryOf = (fetchMock: jest.Mock, i = 0) =>
  Object.fromEntries(urlOf(fetchMock, i).searchParams)

afterEach(() => jest.restoreAllMocks())

const indexer = new IndexerClient('https://api.example.test', 'k')
const ro = new ReadOnlyClient({
  apiKey: 'k',
  indexerUrl: 'https://api.example.test',
})
const me = new TriexClient({
  apiKey: 'k',
  indexerUrl: 'https://api.example.test',
  address: WALLET,
  suiClient: {} as any,
})

const coin = { coin_type: CRED, symbol: 'CRED', name: 'Cred', decimals: 9 }
const party = { address: WALLET, character_name: 'Rin Farshot' }

/** An accepted agreement, as list reads return it. */
const agreement = {
  agreement_id: HEX,
  status: 'accepted',
  posted_at: 1775000000000,
  accept_deadline_at: 1775086400000,
  haul_duration_ms: 86400000,
  lister: party,
  beneficiary: party,
  pays_cap_holder: false,
  on_behalf_of: null,
  cargo: [
    {
      collection_id: HEX,
      asset_id: '78437',
      quantity: '120',
      hub_id: HEX,
      hub_name: 'Source',
      verified: true,
    },
  ],
  want: [],
  currency: coin,
  reward: '5000000000',
  collateral: '1000000000',
  delivery_fee_bps: 250,
  claim_gated: true,
  has_other_rules: false,
  hauler: { address: WALLET, character_name: null },
  hauler_identity: null,
  accepted_at: 1775001000000,
  delivery_deadline_at: 1775087400000,
  closed_at: null,
  closed_by: null,
  hauler_reward: null,
  delivery_fee: null,
  refunded_to: null,
  cap_id: HEX,
  posted_tx_digest: 'Dp',
  accepted_tx_digest: 'Da',
  closed_tx_digest: null,
  viewer_roles: ['hauler'],
}
const page = (data: unknown[], next: string | null = null) => ({
  data,
  next_cursor: next,
  evaluated_at: 1775002000000,
})

describe('hauling.agreements (job board)', () => {
  it('maps every filter to its wire name', async () => {
    const fetchMock = mockFetch([page([agreement])])
    await indexer.hauling.agreements({
      limit: 20,
      cursor: 'c1',
      status: ['open', 'accepted'],
      currency: CRED,
      minReward: 1_000_000n,
      sourceHubId: HEX,
      destinationHubId: HEX,
      cargoCollectionId: HEX,
      wantCollectionId: HEX,
      cargoAssetId: '78437',
      wantAssetId: '1',
      lister: WALLET,
      hauler: WALLET,
      orgId: ORG,
      gated: false,
      claimableBy: WALLET,
      acceptDeadlineBefore: 1775086400000,
      sort: 'reward_desc',
      minCheckpoint: 123456789n,
    })
    expect(urlOf(fetchMock).pathname).toBe('/v1/agreements')
    expect(queryOf(fetchMock)).toEqual({
      limit: '20',
      cursor: 'c1',
      status: 'open,accepted',
      currency: CRED,
      min_reward: '1000000',
      source_hub_id: HEX,
      destination_hub_id: HEX,
      cargo_collection_id: HEX,
      want_collection_id: HEX,
      cargo_asset_id: '78437',
      want_asset_id: '1',
      lister: WALLET,
      hauler: WALLET,
      org_id: ORG,
      gated: 'false',
      claimable_by: WALLET,
      accept_deadline_before: '1775086400000',
      sort: 'reward_desc',
      min_checkpoint: '123456789',
    })
  })

  it('returns camelCase rows with bigint amounts', async () => {
    mockFetch([page([agreement], 'next')])
    const got = await ro.hauling.agreements()
    expect(got.nextCursor).toBe('next')
    expect(got.evaluatedAt).toBe(1775002000000)
    expect(got.agreements[0]).toMatchObject({
      agreementId: HEX,
      status: 'accepted',
      reward: 5_000_000_000n,
      collateral: 1_000_000_000n,
      deliveryFeeBps: 250,
      currency: { coinType: CRED, symbol: 'CRED', decimals: 9 },
      cargo: [{ assetId: '78437', quantity: 120n, hubName: 'Source' }],
      hauler: { address: WALLET, characterName: null },
      deliveryDeadlineAt: 1775087400000,
      haulerReward: null,
      eligibility: null,
      viewerRoles: ['hauler'],
    })
  })

  it('accepts a status added upstream without failing the page', async () => {
    mockFetch([page([{ ...agreement, status: 'disputed' }])])
    const got = await ro.hauling.agreements()
    expect(got.agreements[0].status).toBe('disputed')
  })
})

describe('hauling.agreement (detail)', () => {
  const detail = {
    ...agreement,
    requirements: [
      {
        req_index: 0,
        rule: 'claim',
        type_name: 'agreement_roles::claim::ClaimGate',
        is_identity_rule: false,
        principals: [{ kind: 'ou', id: ORG, name: 'Haulers Guild' }],
        data: null,
      },
    ],
    observer: null,
    cap: {
      cap_id: HEX,
      owner_kind: 'address',
      owner: WALLET,
      owner_name: null,
      receives_proceeds: true,
      ended_kind: null,
    },
    proceeds: null,
    fees: {
      post_fee: { currency: coin, amount: '100' },
      delivery_fee_bps: 250,
      delivery_fee: null,
      treasury: WALLET,
    },
    claims: [
      {
        actor: party,
        principal: { kind: 'ou', id: ORG, name: 'Haulers Guild' },
        tx_digest: 'Dc',
      },
    ],
    timeline: [
      {
        kind: 'posted',
        actor: party,
        at: 1775000000000,
        checkpoint: '987654321',
        tx_digest: 'Dp',
      },
    ],
    viewer: {
      address: WALLET,
      roles: ['hauler'],
      claim_plan: {
        eligibility: 'eligible',
        steps: [
          {
            req_index: 0,
            rule: 'claim',
            type_name: 'agreement_roles::claim::ClaimGate',
            is_identity_rule: false,
            action: 'satisfy',
            org_id: ORG,
          },
        ],
      },
    },
    evaluated_at: 1775002000000,
  }

  it('reads one agreement for a viewer', async () => {
    const fetchMock = mockFetch([detail])
    const got = await ro.hauling.agreement({
      agreementId: HEX,
      viewer: WALLET,
      minCheckpoint: '5',
    })
    expect(urlOf(fetchMock).pathname).toBe(`/v1/agreements/${HEX}`)
    expect(queryOf(fetchMock)).toEqual({ viewer: WALLET, min_checkpoint: '5' })
    expect(got).toMatchObject({
      agreementId: HEX,
      requirements: [
        { reqIndex: 0, rule: 'claim', principals: [{ kind: 'ou', id: ORG }] },
      ],
      cap: { ownerKind: 'address', receivesProceeds: true, endedKind: null },
      fees: { postFee: { amount: 100n }, deliveryFeeBps: 250 },
      claims: [{ principal: { kind: 'ou' }, txDigest: 'Dc' }],
      timeline: [{ kind: 'posted', checkpoint: 987654321n }],
      viewer: {
        roles: ['hauler'],
        claimPlan: {
          eligibility: 'eligible',
          steps: [{ action: 'satisfy', orgId: ORG }],
        },
      },
    })
  })

  it('maps a 404 to AgreementNotFound', async () => {
    mock404()
    await expect(
      ro.hauling.agreement({ agreementId: HEX }),
    ).rejects.toMatchObject({ code: TriexError.AgreementNotFound })
  })
})

describe('player-scoped reads', () => {
  it('default to the configured player on TriexClient', async () => {
    const fetchMock = mockFetch([
      page([agreement]),
      page([]),
      page([]),
      {
        address: WALLET,
        as_hauler: {
          accepted: 3,
          in_progress: 1,
          overdue: 0,
          delivered: 2,
          defaulted: 0,
          forfeited: 0,
          completion_rate: 1,
          net_reward: [{ currency: coin, amount: '9000000000' }],
          collateral_lost: [],
        },
        as_lister: {
          posted: 1,
          open: 1,
          lapsed: 0,
          in_progress: 0,
          delivered: 0,
          defaulted: 0,
          forfeited: 0,
          cancelled: 0,
          closed_lapsed: 0,
        },
        evaluated_at: 1775002000000,
      },
    ])
    await me.hauling.playerAgreements({ role: ['lister', 'hauler'] })
    await me.hauling.actions()
    await me.hauling.claimable({ includeUnknown: true })
    const rep = await me.hauling.reputation()

    expect(urlOf(fetchMock, 0).pathname).toBe(
      `/v1/players/${WALLET}/agreements`,
    )
    expect(queryOf(fetchMock, 0)).toEqual({ role: 'lister,hauler' })
    expect(urlOf(fetchMock, 1).pathname).toBe(
      `/v1/players/${WALLET}/agreements/actions`,
    )
    expect(urlOf(fetchMock, 2).pathname).toBe(
      `/v1/players/${WALLET}/agreements/claimable`,
    )
    expect(queryOf(fetchMock, 2)).toEqual({ include_unknown: 'true' })
    expect(urlOf(fetchMock, 3).pathname).toBe(
      `/v1/players/${WALLET}/agreements/reputation`,
    )
    expect(rep).toMatchObject({
      asHauler: {
        inProgress: 1,
        completionRate: 1,
        netReward: [{ amount: 9_000_000_000n }],
      },
      asLister: { posted: 1, closedLapsed: 0 },
    })
  })

  it('require an explicit address on ReadOnlyClient', async () => {
    const fetchMock = mockFetch([])
    for (const call of [
      () => ro.hauling.playerAgreements(),
      () => ro.hauling.actions(),
      () => ro.hauling.claimable(),
      () => ro.hauling.reputation(),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: TriexError.AddressRequired,
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the to-do list with its Move calls', async () => {
    mockFetch([
      page([
        {
          action: 'deliver',
          move_call: 'hauling::deliver',
          type_argument: CRED,
          agreement_id: HEX,
          cap_id: null,
          proceeds_id: null,
          due_at: 1775087400000,
          agreement,
        },
      ]),
    ])
    const got = await ro.hauling.actions({ address: WALLET })
    expect(got.actions[0]).toMatchObject({
      action: 'deliver',
      moveCall: 'hauling::deliver',
      typeArgument: CRED,
      dueAt: 1775087400000,
      agreement: { agreementId: HEX },
    })
  })

  it('reads claimable agreements with their claim plans', async () => {
    mockFetch([
      page([
        {
          ...agreement,
          status: 'open',
          eligibility: 'eligible',
          claim_plan: { eligibility: 'eligible', steps: [] },
        },
      ]),
    ])
    const got = await ro.hauling.claimable({ address: WALLET })
    expect(got.agreements[0]).toMatchObject({
      status: 'open',
      eligibility: 'eligible',
      claimPlan: { eligibility: 'eligible', steps: [] },
    })
  })
})

describe('organization, config and stats reads', () => {
  it('reads an organization’s agreements and maps a 404 to OrgNotFound', async () => {
    const fetchMock = mockFetch([page([agreement])])
    await ro.hauling.orgAgreements({
      orgId: ORG,
      relation: 'claimed_via',
      status: 'delivered',
      limit: 5,
    })
    expect(urlOf(fetchMock).pathname).toBe(`/v1/orgs/${ORG}/agreements`)
    expect(queryOf(fetchMock)).toEqual({
      relation: 'claimed_via',
      status: 'delivered',
      limit: '5',
    })

    mock404()
    await expect(
      ro.hauling.orgAgreements({ orgId: ORG }),
    ).rejects.toMatchObject({ code: TriexError.OrgNotFound })
  })

  it('reads the protocol config', async () => {
    const fetchMock = mockFetch([
      {
        config_id: HEX,
        currencies: [coin],
        post_fee: null,
        delivery_fee_bps: 250,
        treasury: WALLET,
        updated_at: 1775000000000,
        history: [
          {
            currencies: [CRED],
            post_fee_currency: null,
            post_fee_amount: null,
            delivery_fee_bps: 250,
            treasury: WALLET,
            updated_at: 1775000000000,
            updated_by: WALLET,
            tx_digest: 'Dx',
          },
        ],
      },
    ])
    const got = await ro.hauling.config()
    expect(urlOf(fetchMock).pathname).toBe('/v1/agreements/config')
    expect(got).toMatchObject({
      configId: HEX,
      currencies: [{ coinType: CRED }],
      postFee: null,
      history: [{ postFeeAmount: null, updatedBy: WALLET }],
    })
  })

  it('reads protocol stats', async () => {
    const fetchMock = mockFetch([
      {
        by_status: {
          open: 4,
          lapsed: 1,
          accepted: 2,
          overdue: 0,
          delivered: 9,
          defaulted: 1,
          forfeited: 0,
          cancelled: 1,
          closed_lapsed: 0,
        },
        by_currency: [
          {
            currency: coin,
            agreements: 18,
            reward_posted: '90',
            reward_paid: '45',
            delivery_fees: '1',
            collateral_forfeited: '0',
          },
        ],
        post_fees: [{ currency: coin, amount: '7' }],
        lanes: [
          {
            source_hub_id: HEX,
            source_hub_name: null,
            destination_hub_id: HEX,
            destination_hub_name: 'Dest',
            agreements: 5,
            delivered: 4,
          },
        ],
        evaluated_at: 1775002000000,
      },
    ])
    const got = await ro.hauling.stats({ minCheckpoint: 7n })
    expect(urlOf(fetchMock).pathname).toBe('/v1/agreements/stats')
    expect(queryOf(fetchMock)).toEqual({ min_checkpoint: '7' })
    expect(got).toMatchObject({
      byStatus: { delivered: 9, closedLapsed: 0 },
      byCurrency: [{ rewardPosted: 90n, rewardPaid: 45n }],
      postFees: [{ amount: 7n }],
      lanes: [{ destinationHubName: 'Dest', delivered: 4 }],
    })
  })
})

describe('hauling iterators', () => {
  it('follow the cursor until it runs out', async () => {
    const fetchMock = mockFetch([
      page([agreement, agreement], 'c2'),
      page([agreement], null),
    ])
    const got = []
    for await (const a of iterateAgreements(indexer, { status: 'open' })) {
      got.push(a)
    }
    expect(got).toHaveLength(3)
    expect(queryOf(fetchMock, 1)).toEqual({ status: 'open', cursor: 'c2' })
  })

  it('stop at maxItems', async () => {
    mockFetch([page([agreement, agreement, agreement], 'c2')])
    const got = []
    for await (const a of iteratePlayerAgreements(
      indexer,
      { address: WALLET },
      { maxItems: 2 },
    )) {
      got.push(a)
    }
    expect(got).toHaveLength(2)
  })

  it('walk claimable agreements', async () => {
    const fetchMock = mockFetch([
      page([
        { ...agreement, claim_plan: { eligibility: 'eligible', steps: [] } },
      ]),
    ])
    const got = []
    for await (const a of iterateClaimableAgreements(indexer, {
      address: WALLET,
    })) {
      got.push(a)
    }
    expect(got).toHaveLength(1)
    expect(urlOf(fetchMock).pathname).toBe(
      `/v1/players/${WALLET}/agreements/claimable`,
    )
  })
})

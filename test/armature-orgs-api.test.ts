/**
 * `client.orgs` — the organization read surface (thin delegation plus the
 * tree helpers built on it) and creation, which has to work out which of the
 * three created units is the root, the officers and the members.
 */
import { jest } from '@jest/globals'
import { bcs } from '@mysten/sui/bcs'

import { OrgsApi, OrgsWriteApi } from '../src/armature/OrgsApi'
import type { Org } from '../src/armature/types'
import { resolvePackageIds } from '../src/config'
import { TriexError } from '../src/errors'
import { mockOuChain } from './helpers/ouChain'

const hex = (pair: string) => `0x${pair.repeat(32)}`
const ROOT = hex('c1')
const OFFICERS = hex('c2')
const MEMBERS = hex('c3')
const ALICE = hex('11')
const BOB = hex('22')
const ACCOUNT = hex('ac')
const ids = resolvePackageIds('testnet')

function unit(orgId: string, over: Partial<Org> = {}): Org {
  return {
    orgId,
    charterId: null,
    treasuryId: null,
    capabilityVaultId: null,
    emergencyFreezeId: null,
    name: orgId,
    metadataUri: null,
    metadata: {},
    members: [],
    ous: [],
    tradingAccountId: null,
    subdaoControlCapId: null,
    ...over,
  }
}

const TREE = unit(ROOT, {
  members: [ALICE],
  ous: [
    unit(OFFICERS, { members: [ALICE, BOB], tradingAccountId: ACCOUNT }),
    unit(MEMBERS, { members: [BOB] }),
  ],
})

function fakeIndexer() {
  const orgs = {
    get: jest.fn(async () => TREE),
    batch: jest.fn(async () => [TREE]),
    directory: jest.fn(async () => ({ entries: [], nextCursor: null })),
    forPlayer: jest.fn(async () => [TREE]),
    search: jest.fn(async () => []),
    proposals: jest.fn(async () => []),
    accessibleKeyspaces: jest.fn(async () => []),
    vaultsAtHub: jest.fn(async () => []),
  }
  return { indexer: { orgs } as any, orgs }
}

const requireAddress = (a?: string) => {
  if (!a) throw new Error('no address')
  return a
}

describe('orgs reads', () => {
  it('delegates each read with its arguments, minCheckpoint included', async () => {
    const { indexer, orgs } = fakeIndexer()
    const api = new OrgsApi(indexer, requireAddress)
    const cp = { minCheckpoint: 9n }
    await api.get(ROOT, cp)
    await api.batch([ROOT, OFFICERS], cp)
    await api.directory({ limit: 5 })
    await api.forPlayer(ALICE, cp)
    await api.search('guild', { enrich: true } as any)
    await api.proposals(ROOT)
    await api.accessibleKeyspaces(ALICE, 'read')
    await api.vaultsAtHub(hex('ab'), cp)
    expect(orgs.get).toHaveBeenCalledWith(ROOT, cp)
    expect(orgs.batch).toHaveBeenCalledWith([ROOT, OFFICERS], cp)
    expect(orgs.directory).toHaveBeenCalledWith({ limit: 5 })
    expect(orgs.forPlayer).toHaveBeenCalledWith(ALICE, cp)
    expect(orgs.search).toHaveBeenCalledWith('guild', { enrich: true })
    expect(orgs.proposals).toHaveBeenCalledWith(ROOT)
    expect(orgs.accessibleKeyspaces).toHaveBeenCalledWith(ALICE, 'read')
    expect(orgs.vaultsAtHub).toHaveBeenCalledWith(hex('ab'), cp)
  })

  it('flattens the tree, finds seats and the trading account', async () => {
    const api = new OrgsApi(fakeIndexer().indexer, requireAddress)
    const nodes = await api.nodes(ROOT)
    expect(nodes.map((n) => n.daoId)).toEqual([ROOT, OFFICERS, MEMBERS])

    const seats = await api.seats(ROOT, ALICE)
    expect(seats.map((s) => s.daoId)).toEqual([ROOT, OFFICERS])
    // A preferred seat the address still holds wins; otherwise the highest.
    expect((await api.seat(ROOT, OFFICERS, ALICE))?.daoId).toBe(OFFICERS)
    expect((await api.seat(ROOT, MEMBERS, ALICE))?.daoId).toBe(ROOT)
    expect(await api.seat(ROOT, null, hex('99'))).toBeNull()

    expect(await api.tradingAccount(ROOT)).toMatchObject({
      tradingAccountId: ACCOUNT,
      node: { daoId: OFFICERS },
    })
  })
})

// ─── creation ────────────────────────────────────────────────────────────────

const VaultBcs = bcs.struct('CapabilityVault', {
  id: bcs.Address,
  ou_id: bcs.Address,
  cap_types: bcs.struct('VecSet', { contents: bcs.vector(bcs.string()) }),
  cap_ids: bcs.struct('VecSet', { contents: bcs.vector(bcs.Address) }),
  ids_by_type: bcs.struct('VecMap', {
    contents: bcs.vector(
      bcs.struct('Entry', {
        key: bcs.string(),
        value: bcs.vector(bcs.Address),
      }),
    ),
  }),
})

function writeApi(createdOus: string[]) {
  const OFFICERS_CAP = hex('e7')
  const MEMBERS_CAP = hex('e8')
  const ROOT_VAULT = hex('e2')
  const chain = mockOuChain(
    {
      [ROOT]: { members: [ALICE], slots: [], capabilityVaultId: ROOT_VAULT },
      [OFFICERS]: {
        members: [ALICE],
        slots: [],
        controllerCapId: OFFICERS_CAP,
      },
      [MEMBERS]: { members: [ALICE], slots: [], controllerCapId: MEMBERS_CAP },
    },
    {
      // The root's vault holds the officers' control cap — that is how the
      // officers unit is told apart from the members unit.
      [ROOT_VAULT]: {
        content: VaultBcs.serialize({
          id: ROOT_VAULT,
          ou_id: ROOT,
          cap_types: { contents: [] },
          cap_ids: { contents: [OFFICERS_CAP] },
          ids_by_type: { contents: [] },
        }).toBytes(),
      },
    },
  )
  const executor = jest.fn(async () => ({
    digest: 'D',
    objectChanges: createdOus.map((objectId) => ({
      type: 'created',
      objectId,
      objectType: `${ids.armature}::ou::OU`,
    })),
  }))
  const api = new OrgsWriteApi(fakeIndexer().indexer, () => ALICE, {
    suiClient: { core: chain.core } as any,
    ids,
    requireExecutor: () => executor,
  })
  return { api, executor }
}

describe('orgs.create', () => {
  it('tells the root, officers and members apart, in any created order', async () => {
    const { api, executor } = writeApi([MEMBERS, ROOT, OFFICERS])
    const created = await api.create({
      name: 'Haulers',
      metadataUri: 'ipfs://h',
      officers: [BOB],
    })
    expect(executor).toHaveBeenCalledTimes(1)
    expect(created).toMatchObject({
      orgId: ROOT,
      officersId: OFFICERS,
      membersId: MEMBERS,
    })
  })

  it('fails typed when the executor does not surface the three units', async () => {
    const { api } = writeApi([ROOT])
    await expect(
      api.create({ name: 'X', metadataUri: 'ipfs://x', enableTrading: false }),
    ).rejects.toMatchObject({ code: TriexError.UnexpectedResponse })
  })

  it('createStandalone returns the new unit', async () => {
    const { api } = writeApi([OFFICERS])
    const created = await api.createStandalone({
      name: 'Solo',
      metadataUri: 'ipfs://s',
    })
    expect(created.ouId).toBe(OFFICERS)
  })
})

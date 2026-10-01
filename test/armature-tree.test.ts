import {
  execContextFor,
  findNodeAcross,
  flattenOrg,
  nodeById,
  resolveSeat,
  roleForDepth,
  rootNode,
  seatsFor,
  tradingNode,
} from '../src/armature/tree'
import type { Org } from '../src/armature/types'

const ROOT = '0xroot'
const OFFICERS = '0xofficers'
const MEMBERS = '0xmembers'
const ALICE = '0xAAAA'
const BOB = '0xbbbb'

/** A domain-shaped org unit; `over` patches it. */
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

/** Root → officers → members, fully linked for the control path. */
function fullTree(): Org {
  return unit(ROOT, {
    emergencyFreezeId: `${ROOT}-freeze`,
    capabilityVaultId: `${ROOT}-caps`,
    members: [ALICE],
    ous: [
      unit(OFFICERS, {
        emergencyFreezeId: `${OFFICERS}-freeze`,
        capabilityVaultId: `${OFFICERS}-caps`,
        members: [ALICE, BOB],
        tradingAccountId: '0xbm',
        subdaoControlCapId: '0xcap-root-officers',
        ous: [
          unit(MEMBERS, {
            emergencyFreezeId: `${MEMBERS}-freeze`,
            members: [BOB],
            subdaoControlCapId: '0xcap-officers-members',
          }),
        ],
      }),
    ],
  })
}

describe('flattenOrg', () => {
  it('walks depth-first, root first, with parent + child linkage', () => {
    const nodes = flattenOrg(fullTree())
    expect(nodes.map((n) => n.daoId)).toEqual([ROOT, OFFICERS, MEMBERS])
    expect(nodes[0].parentDaoId).toBeNull()
    expect(nodes[0].childDaoIds).toEqual([OFFICERS])
    expect(nodes[1].parentDaoId).toBe(ROOT)
    expect(nodes[2].depth).toBe(2)
  })

  it('labels roles by depth and ranks by authority', () => {
    const nodes = flattenOrg(fullTree())
    expect(nodes.map((n) => n.roleKey)).toEqual(['admin', 'officer', 'member'])
    expect(nodes.map((n) => n.rank)).toEqual([0, 1, 2])
    // Anything deeper than the named tiers keeps falling into `member`.
    expect(roleForDepth(7)).toEqual({ key: 'member', label: 'Member' })
  })

  it('handles a single-unit org with no children', () => {
    const nodes = flattenOrg(unit(ROOT))
    expect(nodes).toHaveLength(1)
    expect(nodes[0].childDaoIds).toEqual([])
    expect(rootNode(nodes)?.daoId).toBe(ROOT)
  })

  it('walks branching trees, not just a single chain', () => {
    const branched = unit(ROOT, {
      ous: [unit('0xa'), unit('0xb', { ous: [unit('0xb1')] }), unit('0xc')],
    })
    expect(flattenOrg(branched).map((n) => n.daoId)).toEqual([
      ROOT,
      '0xa',
      '0xb',
      '0xb1',
      '0xc',
    ])
  })
})

describe('lookups', () => {
  it('matches ids case-insensitively and returns null for misses', () => {
    const nodes = flattenOrg(fullTree())
    expect(nodeById(nodes, '0xOFFICERS'.toLowerCase())?.daoId).toBe(OFFICERS)
    expect(nodeById(nodes, '0xnope')).toBeNull()
    expect(nodeById(nodes, null)).toBeNull()
  })

  it('finds the trading unit by capability, not by role label', () => {
    expect(tradingNode(flattenOrg(fullTree()))?.daoId).toBe(OFFICERS)
    expect(tradingNode(flattenOrg(unit(ROOT)))).toBeNull()
  })

  it('resolves a unit across several memberships', () => {
    const other = unit('0xother', { ous: [unit('0xother-sub')] })
    expect(findNodeAcross([fullTree(), other], '0xother-sub')?.depth).toBe(1)
    expect(findNodeAcross([fullTree(), other], '0xstranger')).toBeNull()
  })
})

describe('seats', () => {
  it('returns every board the address sits on, highest authority first', () => {
    const nodes = flattenOrg(fullTree())
    expect(seatsFor(nodes, ALICE).map((s) => s.daoId)).toEqual([ROOT, OFFICERS])
    expect(seatsFor(nodes, BOB).map((s) => s.daoId)).toEqual([
      OFFICERS,
      MEMBERS,
    ])
    expect(seatsFor(nodes, '0xstranger')).toEqual([])
  })

  it('matches board membership case-insensitively', () => {
    const nodes = flattenOrg(fullTree())
    expect(seatsFor(nodes, ALICE.toUpperCase())).toHaveLength(2)
  })

  it('honours a held preference and falls back when the seat is gone', () => {
    const nodes = flattenOrg(fullTree())
    expect(resolveSeat(nodes, ALICE, OFFICERS)?.daoId).toBe(OFFICERS)
    // A stale selection (removed from that board) degrades to best available…
    expect(resolveSeat(nodes, ALICE, MEMBERS)?.daoId).toBe(ROOT)
    // …and no seat at all is null, not a throw.
    expect(resolveSeat(nodes, '0xstranger', ROOT)).toBeNull()
  })
})

describe('execContextFor', () => {
  it('builds the parent linkage the control strategies need', () => {
    const ctx = execContextFor(flattenOrg(fullTree()), OFFICERS)
    expect(ctx).toEqual({
      daoId: OFFICERS,
      board: [ALICE, BOB],
      emergencyFreezeId: `${OFFICERS}-freeze`,
      parent: {
        daoId: ROOT,
        board: [ALICE],
        emergencyFreezeId: `${ROOT}-freeze`,
        capVaultId: `${ROOT}-caps`,
        controlCapId: '0xcap-root-officers',
      },
    })
  })

  it('leaves parent undefined at the root', () => {
    const ctx = execContextFor(flattenOrg(fullTree()), ROOT)
    expect(ctx?.daoId).toBe(ROOT)
    expect(ctx?.parent).toBeUndefined()
  })

  it('drops the parent linkage when any required piece is missing', () => {
    // No control cap → the parent cannot act on this child.
    const noCap = unit(ROOT, {
      emergencyFreezeId: 'f',
      capabilityVaultId: 'c',
      ous: [unit(OFFICERS, { emergencyFreezeId: 'f2' })],
    })
    expect(execContextFor(flattenOrg(noCap), OFFICERS)?.parent).toBeUndefined()

    // No parent CapabilityVault → likewise.
    const noVault = unit(ROOT, {
      emergencyFreezeId: 'f',
      ous: [
        unit(OFFICERS, { emergencyFreezeId: 'f2', subdaoControlCapId: 'x' }),
      ],
    })
    expect(
      execContextFor(flattenOrg(noVault), OFFICERS)?.parent,
    ).toBeUndefined()
  })

  it('returns null for a unit that cannot execute at all', () => {
    // No EmergencyFreeze → every submit_vote_execute would fail; say so early.
    const noFreeze = unit(ROOT, { ous: [unit(OFFICERS)] })
    expect(execContextFor(flattenOrg(noFreeze), OFFICERS)).toBeNull()
    expect(execContextFor(flattenOrg(fullTree()), '0xstranger')).toBeNull()
  })
})

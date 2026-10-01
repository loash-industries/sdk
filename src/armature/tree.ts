import type { Org, OrgNode, OrgSeat, OuExecContext, OuParent } from './types'

/**
 * Pure lookups over an organization's control tree.
 *
 * `Org` arrives from the indexer as a nested `ous` structure, which is awkward
 * to address: every consumer ends up walking it. These helpers flatten it once
 * into `OrgNode[]` keyed by `daoId` and answer the questions that actually get
 * asked — where do I sit, which unit trades, what does the resolver need.
 *
 * Nothing here does I/O and nothing imports the Sui runtime, so the whole
 * module is directly unit-testable. Ported from triex-app-api's
 * `src/utils/orgNodes.ts`, minus its fixed admin/officer/member shim
 * (DESIGN-ARMATURE.md D-A3).
 */

/** Depth-derived role labels. Today's model; see {@link roleForDepth}. */
const ROLE_BY_DEPTH: { key: string; label: string }[] = [
  { key: 'admin', label: 'Admin' },
  { key: 'officer', label: 'Officer' },
]
const MEMBER_ROLE = { key: 'member', label: 'Member' }

/**
 * Role label for a tree depth: 0 → admin, 1 → officer, 2+ → member.
 *
 * This is the ONE place the current taxonomy is encoded, and it is the seam to
 * replace when governance-defined roles land. Consumers should order by `rank`
 * and display `roleLabel` rather than branching on `roleKey`.
 */
export function roleForDepth(depth: number): { key: string; label: string } {
  return ROLE_BY_DEPTH[depth] ?? MEMBER_ROLE
}

/** Case-insensitive Sui address comparison. */
const sameAddress = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase()

/**
 * Flatten an organization into its control-tree nodes, depth-first, root
 * first. Every unit in the tree appears exactly once and is addressable by
 * `daoId`.
 */
export function flattenOrg(org: Org): OrgNode[] {
  const nodes: OrgNode[] = []
  const walk = (unit: Org, parentDaoId: string | null, depth: number): void => {
    const role = roleForDepth(depth)
    nodes.push({
      daoId: unit.orgId,
      parentDaoId,
      depth,
      childDaoIds: unit.ous.map((child) => child.orgId),
      name: unit.name,
      charterId: unit.charterId,
      treasuryId: unit.treasuryId,
      capabilityVaultId: unit.capabilityVaultId,
      emergencyFreezeId: unit.emergencyFreezeId,
      members: unit.members,
      balanceManagerId: unit.balanceManagerId,
      subdaoControlCapId: unit.subdaoControlCapId,
      roleKey: role.key,
      roleLabel: role.label,
      rank: depth,
    })
    for (const child of unit.ous) walk(child, unit.orgId, depth + 1)
  }
  walk(org, null, 0)
  return nodes
}

/** A node by DAO id, or null. */
export function nodeById(
  nodes: readonly OrgNode[],
  daoId: string | null | undefined,
): OrgNode | null {
  if (!daoId) return null
  return nodes.find((n) => sameAddress(n.daoId, daoId)) ?? null
}

/** The root (depth 0) node. */
export function rootNode(nodes: readonly OrgNode[]): OrgNode | null {
  return nodes.find((n) => n.depth === 0) ?? null
}

/**
 * The unit carrying the organization's shared trading account.
 *
 * Defined by CAPABILITY — the first node holding a `balanceManagerId` — not by
 * a role label, so an organization that seats trading somewhere unusual still
 * resolves. Null when the organization has never set up trading.
 */
export function tradingNode(nodes: readonly OrgNode[]): OrgNode | null {
  return nodes.find((n) => n.balanceManagerId) ?? null
}

/**
 * Every unit whose board `address` currently sits on, highest authority
 * (lowest `rank`) first. An empty result means the address governs nothing in
 * this organization — it may still be a member of the game-world tribe.
 */
export function seatsFor(
  nodes: readonly OrgNode[],
  address: string,
): OrgSeat[] {
  return nodes
    .filter((n) => n.members.some((m) => sameAddress(m, address)))
    .sort((a, b) => a.rank - b.rank)
    .map((n) => ({ ...n, address }))
}

/**
 * Resolve the seat to act through: the explicitly requested one if the address
 * actually holds it, otherwise the highest-authority seat. Returns null when
 * the address holds no seat at all.
 *
 * Requesting a seat you do not hold falls back rather than throwing, because
 * the common cause is a stale selection (a board change removed you) and the
 * useful answer is "here is what you can still do".
 */
export function resolveSeat(
  nodes: readonly OrgNode[],
  address: string,
  preferredDaoId?: string | null,
): OrgSeat | null {
  const seats = seatsFor(nodes, address)
  if (preferredDaoId) {
    const exact = seats.find((s) => sameAddress(s.daoId, preferredDaoId))
    if (exact) return exact
  }
  return seats[0] ?? null
}

/**
 * Build the strategy resolver's view of one unit: its own board and freeze
 * object, plus the parent linkage that makes the `control-*` strategies
 * possible.
 *
 * The parent linkage needs four things to exist together — the parent's DAO,
 * its `EmergencyFreeze`, its `CapabilityVault`, and the `SubDAOControl` cap on
 * the parent pointing at THIS child (which the indexer hands us as the child's
 * own `subdaoControlCapId`). Any one missing means no control path, and
 * `parent` is left undefined so the resolver simply never offers those
 * strategies. Returns null when the unit itself is unusable — no
 * `EmergencyFreeze` means it cannot execute anything.
 */
export function execContextFor(
  nodes: readonly OrgNode[],
  daoId: string,
): OuExecContext | null {
  const node = nodeById(nodes, daoId)
  if (!node || !node.emergencyFreezeId) return null

  const parentNode = nodeById(nodes, node.parentDaoId)
  let parent: OuParent | undefined
  if (
    parentNode &&
    parentNode.emergencyFreezeId &&
    parentNode.capabilityVaultId &&
    node.subdaoControlCapId
  ) {
    parent = {
      daoId: parentNode.daoId,
      board: parentNode.members,
      emergencyFreezeId: parentNode.emergencyFreezeId,
      capVaultId: parentNode.capabilityVaultId,
      controlCapId: node.subdaoControlCapId,
    }
  }

  return {
    daoId: node.daoId,
    board: node.members,
    emergencyFreezeId: node.emergencyFreezeId,
    parent,
  }
}

/**
 * Find a unit by DAO id across several organizations — e.g. labelling a
 * counterparty from an order book against everything the caller belongs to.
 * Null when it belongs to none of them, so callers can fall back to the raw id.
 */
export function findNodeAcross(
  orgs: readonly Org[],
  daoId: string | null | undefined,
): OrgNode | null {
  if (!daoId) return null
  for (const org of orgs) {
    const hit = nodeById(flattenOrg(org), daoId)
    if (hit) return hit
  }
  return null
}

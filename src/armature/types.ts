import type { z } from 'zod'
import type {
  AccessibleKeyspaceSchema,
  HubDaoVaultSchema,
  OrgDirectoryPageSchema,
  ProposalCompositeStepSchema,
  ProposalSummarySchema,
  VaultAclEntrySchema,
} from './schemas'

// ─── Domain types (inferred from the pinned wire schemas — see schemas.ts) ───

export type {
  Org,
  OrgActor,
  OrgDirectoryEntry,
  OrgMetadata,
  OrgSearchResult,
} from './schemas'

export type OrgDirectoryPage = z.output<typeof OrgDirectoryPageSchema>
export type ProposalSummary = z.output<typeof ProposalSummarySchema>
export type ProposalCompositeStep = z.output<typeof ProposalCompositeStepSchema>
export type ProposalStatus = ProposalSummary['status']
export type AccessibleKeyspace = z.output<typeof AccessibleKeyspaceSchema>
export type KeyspaceRole = AccessibleKeyspace['roles'][number]
export type KeyspaceMatchVia = AccessibleKeyspace['matchVia']
export type HubDaoVault = z.output<typeof HubDaoVaultSchema>
export type VaultAclEntry = z.output<typeof VaultAclEntrySchema>
export type VaultRole = VaultAclEntry['role']

/** A vault ACL subject: an individual wallet, or an organization unit. */
export interface VaultPrincipal {
  kind: 'player' | 'ou'
  /** Wallet address (`player`) or organization id (`ou`). */
  value: string
}

// ─── Request params ─────────────────────────────────────────────────────────

export interface OrgDirectoryParams {
  /** 1–50; the endpoint defaults to 8. */
  limit?: number
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string
  /** `members` (largest first — the endpoint default) or `name`. */
  sort?: 'members' | 'name'
}

export interface OrgSearchParams {
  /** Max results (endpoint default 8, max 50). */
  limit?: number
  /** Resolve each hit's `imageUrl`/`description` — costs a metadata lookup. */
  enrich?: boolean
}

// ─── Control-tree graph (see tree.ts) ───────────────────────────────────────

/**
 * One DAO in an organization's control tree, flattened out of the nested
 * `Org.ous` shape and addressable by `daoId`.
 *
 * Capabilities live on the node, so callers address by identity + capability
 * rather than a hardcoded role name — `roleKey` is a LABEL derived from depth,
 * not a taxonomy to branch on (DESIGN-ARMATURE.md D-A3). Find the trading
 * account with `balanceManagerId`, not with `roleKey === 'officer'`.
 */
export interface OrgNode {
  daoId: string
  parentDaoId: string | null
  /** 0 for the root; +1 per level down. */
  depth: number
  childDaoIds: string[]
  name: string | null
  charterId: string | null
  treasuryId: string | null
  capabilityVaultId: string | null
  emergencyFreezeId: string | null
  /** This unit's own governance board. */
  members: string[]
  balanceManagerId: string | null
  /** The parent's `SubDAOControl` cap pointing here. Null at the root. */
  subdaoControlCapId: string | null
  /**
   * Depth-derived role label. Open set — today `admin` / `officer` / `member`,
   * but treat it as display text and order by `rank`.
   */
  roleKey: string
  roleLabel: string
  /** Authority rank; LOWER is more authority (equals `depth` today). */
  rank: number
}

/** A node the caller actually holds a board seat on. */
export interface OrgSeat extends OrgNode {
  /** The address this seat was resolved for. */
  address: string
}

/** Parent linkage for a sub-DAO — absent for a top-level organization. */
export interface OuParent {
  daoId: string
  board: string[]
  emergencyFreezeId: string
  /** Parent's CapabilityVault holding the `SubDAOControl` cap over this child. */
  capVaultId: string
  /** The `SubDAOControl` cap id pointing at this child. */
  controlCapId: string
}

/**
 * Everything the strategy resolver needs about one unit: its own board and
 * freeze object, plus the parent linkage that makes the `control-*` strategies
 * possible. Built by `execContextFor()`; consumed by the harness in Phase B.
 */
export interface OuExecContext {
  daoId: string
  board: string[]
  emergencyFreezeId: string
  parent?: OuParent
}

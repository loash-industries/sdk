import { z } from 'zod'

/**
 * Zod schemas for the Armature (organizations & governance) indexer surface,
 * pinned against the published gateway spec at
 * `https://api.trinary.exchange/swagger.json` (verified 2026-09-11).
 *
 * Same conventions as `src/schemas.ts`: validate the snake_case wire shape and
 * TRANSFORM into the SDK's camelCase domain shape, with the domain types in
 * `armature/types.ts` inferred from here (single source of truth). Epoch-ms
 * timestamps stay `number`; vote weights are small integers (board voting is
 * weight-1 per member) so they stay `number` rather than becoming `bigint`.
 *
 * See DESIGN-ARMATURE.md §2 / §13.1 for the route inventory.
 */

// ─── Organizations (A1–A5) ───────────────────────────────────────────────────

/** Expanded org metadata, or `{ errorReason }` when `metadata_uri` failed. */
export interface OrgMetadata {
  imageUrl?: string
  description?: string
  version?: number
  /** Present INSTEAD of the other fields when resolution failed. */
  errorReason?: string
}

export const OrgMetadataSchema = z
  .object({
    image_url: z.string().optional(),
    description: z.string().optional(),
    version: z.number().optional(),
    error_reason: z.string().optional(),
  })
  .transform((v): OrgMetadata => ({
    imageUrl: v.image_url,
    description: v.description,
    version: v.version,
    errorReason: v.error_reason,
  }))

/** A member address resolved to a game participant. `player` is the only kind today. */
export const OrgActorSchema = z
  .object({ type: z.literal('player'), name: z.string() })
  .transform((v) => ({ type: v.type, name: v.name }))

export type OrgActor = z.output<typeof OrgActorSchema>

/**
 * One organization (or organizational unit) and, recursively, its children.
 *
 * The wire type is self-referential (`ous: OrgResponse[]`), so the output type
 * is declared explicitly and the schema annotated against it — `z.lazy` alone
 * cannot infer through a `.transform()` cycle.
 */
export interface Org {
  /** Object ID of this organization / unit. */
  orgId: string
  /** Charter object (name + metadata). Null when unresolved. */
  charterId: string | null
  /** TreasuryVault — the deposit target for this unit. Null when unresolved. */
  treasuryId: string | null
  /** CapabilityVault holding the control caps officer actions need. */
  capabilityVaultId: string | null
  /** EmergencyFreeze object — required by every `submit_vote_execute`. */
  emergencyFreezeId: string | null
  name: string | null
  metadataUri: string | null
  metadata: OrgMetadata
  /** Governance board of THIS unit (empty for models without a member board). */
  members: string[]
  /** Child units — same shape, arbitrarily deep. */
  ous: Org[]
  /**
   * Member addresses across the WHOLE tree resolved to character names.
   * Present on the top-level organization only; unresolved addresses omitted.
   */
  actors?: Record<string, OrgActor>
  /** The unit's trading BalanceManager. Null when it has no trading account. */
  balanceManagerId: string | null
  /**
   * The `SubDAOControl` cap on the PARENT that points at this unit — what the
   * `control-*` strategies consume. Null for a top-level organization.
   */
  subdaoControlCapId: string | null
}

export const OrgSchema: z.ZodType<Org, unknown> = z.lazy(() =>
  z
    .object({
      org_id: z.string(),
      charter_id: z.string().nullable(),
      treasury_id: z.string().nullable(),
      capability_vault_id: z.string().nullable(),
      emergency_freeze_id: z.string().nullable(),
      name: z.string().nullable(),
      metadata_uri: z.string().nullable(),
      metadata: OrgMetadataSchema,
      members: z.array(z.string()),
      ous: z.array(OrgSchema),
      actors: z.record(z.string(), OrgActorSchema).optional(),
      balance_manager_id: z.string().nullable(),
      subdao_control_cap_id: z.string().nullable(),
    })
    .transform((v): Org => ({
      orgId: v.org_id,
      charterId: v.charter_id,
      treasuryId: v.treasury_id,
      capabilityVaultId: v.capability_vault_id,
      emergencyFreezeId: v.emergency_freeze_id,
      name: v.name,
      metadataUri: v.metadata_uri,
      metadata: v.metadata,
      members: v.members,
      ous: v.ous,
      actors: v.actors,
      balanceManagerId: v.balance_manager_id,
      subdaoControlCapId: v.subdao_control_cap_id,
    })),
)

export const OrgListSchema = z.array(OrgSchema)

/** One row of the discovery directory — top-level organizations only. */
export interface OrgDirectoryEntry {
  orgId: string
  name: string
  treasuryId: string
  imageUrl?: string
  description?: string
  /** Line members across the whole tree — a size hint, not officers. */
  memberCount: number
}

export const OrgDirectoryEntrySchema = z
  .object({
    org_id: z.string(),
    name: z.string(),
    treasury_id: z.string(),
    image_url: z.string().optional(),
    description: z.string().optional(),
    member_count: z.number(),
  })
  .transform((v): OrgDirectoryEntry => ({
    orgId: v.org_id,
    name: v.name,
    treasuryId: v.treasury_id,
    imageUrl: v.image_url,
    description: v.description,
    memberCount: v.member_count,
  }))

export const OrgDirectoryPageSchema = z
  .object({
    data: z.array(OrgDirectoryEntrySchema),
    next_cursor: z.string().nullable(),
  })
  .transform((v) => ({ entries: v.data, nextCursor: v.next_cursor }))

/** A search hit — may be a unit deep in a tree, hence the `root*` fields. */
export interface OrgSearchResult {
  orgId: string
  name: string
  treasuryId: string
  imageUrl?: string
  description?: string
  rootOrgId: string
  rootName: string
  /** 0 = the organization itself, 1 = officer tier, 2+ = member tier. */
  depth: number
}

export const OrgSearchResultSchema = z
  .object({
    org_id: z.string(),
    name: z.string(),
    treasury_id: z.string(),
    image_url: z.string().optional(),
    description: z.string().optional(),
    root_org_id: z.string(),
    root_name: z.string(),
    depth: z.number(),
  })
  .transform((v): OrgSearchResult => ({
    orgId: v.org_id,
    name: v.name,
    treasuryId: v.treasury_id,
    imageUrl: v.image_url,
    description: v.description,
    rootOrgId: v.root_org_id,
    rootName: v.root_name,
    depth: v.depth,
  }))

/** `/v1/search` returns both groups; `orgs.search()` reads only `orgs`. */
export const OrgSearchResponseSchema = z
  .object({ orgs: z.array(OrgSearchResultSchema).optional() })
  .transform((v) => v.orgs ?? [])

// ─── Proposals (A7) ──────────────────────────────────────────────────────────

export const ProposalCompositeStepSchema = z
  .object({
    step_index: z.number(),
    step_type_key: z.string(),
    step_type: z.string().nullable(),
  })
  .transform((v) => ({
    stepIndex: v.step_index,
    stepTypeKey: v.step_type_key,
    /** Fully-qualified payload type for `advance_step<P>`; null if undecoded. */
    stepType: v.step_type,
  }))

/**
 * Indexer proposal summary — DISCOVERY ONLY. Per-proposal governance config and
 * snapshot weights are deliberately absent; hydrate the live object for those
 * (DESIGN-ARMATURE.md §8, `governance.proposal()` in Phase B).
 */
export const ProposalSummarySchema = z
  .object({
    proposal_id: z.string(),
    org_id: z.string(),
    type_key: z.string().nullable(),
    proposer: z.string().nullable(),
    status: z.enum(['pending', 'passed', 'executed', 'expired']),
    yes_weight: z.number(),
    no_weight: z.number(),
    payload_type: z.string().nullable(),
    frame_id: z.string().nullable(),
    created_checkpoint: z.number(),
    composite: z.array(ProposalCompositeStepSchema).optional(),
  })
  .transform((v) => ({
    proposalId: v.proposal_id,
    orgId: v.org_id,
    typeKey: v.type_key,
    proposer: v.proposer,
    /** `pending` INCLUDES a lapsed voting window that was never finalized. */
    status: v.status,
    yesWeight: v.yes_weight,
    noWeight: v.no_weight,
    payloadType: v.payload_type,
    /** Shared CompositeFrame id; null for every non-composite proposal. */
    frameId: v.frame_id,
    /** Checkpoint sequence number, NOT a timestamp. */
    createdCheckpoint: v.created_checkpoint,
    composite: v.composite,
  }))

export const ProposalSummaryListSchema = z.array(ProposalSummarySchema)

// ─── Keyspaces (A10) ─────────────────────────────────────────────────────────

export const AccessibleKeyspaceSchema = z
  .object({
    acl_id: z.string(),
    matched_org_id: z.string().nullable(),
    name: z.string(),
    registrant_org_id: z.string().nullable(),
    match_via: z.enum(['created', 'player_grant', 'ou_grant']),
    roles: z.array(z.enum(['grant', 'read', 'write'])),
  })
  .transform((v) => ({
    aclId: v.acl_id,
    /** The org the access came through; null for a direct/personal grant. */
    matchedOrgId: v.matched_org_id,
    name: v.name,
    registrantOrgId: v.registrant_org_id,
    /** `created` takes precedence over grants. */
    matchVia: v.match_via,
    roles: v.roles,
  }))

export const AccessibleKeyspaceListSchema = z.array(AccessibleKeyspaceSchema)

// ─── Shared storage / DaoReceiptVault (E1) ───────────────────────────────────

export const VaultAclEntrySchema = z
  .object({
    role: z.enum(['deposit', 'withdraw', 'edit']),
    principal_kind: z.enum(['player', 'ou']),
    principal_value: z.string(),
  })
  .transform((v) => ({
    role: v.role,
    /** Wallet address (`player`) or organization id (`ou`). */
    principal: { kind: v.principal_kind, value: v.principal_value },
  }))

export const HubDaoVaultSchema = z
  .object({
    vault_id: z.string(),
    registrant_dao_id: z.string().nullable(),
    hub_id: z.string(),
    collection_id: z.string().nullable(),
    status: z.string(),
    acl: z.array(VaultAclEntrySchema),
  })
  .transform((v) => ({
    vaultId: v.vault_id,
    /** The org that registered the vault — half of the registry key. */
    registrantOrgId: v.registrant_dao_id,
    hubId: v.hub_id,
    collectionId: v.collection_id,
    /** Only `active` vaults are returned by the endpoint. */
    status: v.status,
    /** Grant/revoke-netted, one entry per principal per role. */
    acl: v.acl,
  }))

export const HubDaoVaultListSchema = z.array(HubDaoVaultSchema)

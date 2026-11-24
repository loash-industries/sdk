import type { z } from 'zod'
import type {
  AGREEMENT_ROLES,
  AGREEMENT_STATUSES,
  ClaimableAgreementPageSchema,
  ClaimableAgreementSchema,
  HaulingActionPageSchema,
  HaulingAgreementDetailSchema,
  HaulingAgreementPageSchema,
  HaulingAgreementSchema,
  HaulingClaimPlanSchema,
  HaulingCoinSchema,
  HaulingConfigSchema,
  HaulingItemsSchema,
  HaulingReputationSchema,
  HaulingStatsSchema,
} from './schemas'

export type HaulingAgreement = z.output<typeof HaulingAgreementSchema>
export type HaulingAgreementPage = z.output<typeof HaulingAgreementPageSchema>
export type HaulingAgreementDetail = z.output<
  typeof HaulingAgreementDetailSchema
>
export type ClaimableAgreement = z.output<typeof ClaimableAgreementSchema>
export type ClaimableAgreementPage = z.output<
  typeof ClaimableAgreementPageSchema
>
export type HaulingActionPage = z.output<typeof HaulingActionPageSchema>
export type HaulingAction = HaulingActionPage['actions'][number]
export type HaulingClaimPlan = z.output<typeof HaulingClaimPlanSchema>
export type HaulingCoin = z.output<typeof HaulingCoinSchema>
export type HaulingItems = z.output<typeof HaulingItemsSchema>
export type HaulingConfig = z.output<typeof HaulingConfigSchema>
export type HaulingStats = z.output<typeof HaulingStatsSchema>
export type HaulingReputation = z.output<typeof HaulingReputationSchema>

/** An agreement status; open to values added upstream. */
export type AgreementStatus =
  (typeof AGREEMENT_STATUSES)[number] | (string & NonNullable<unknown>)

/** A part an address plays in an agreement; open to values added upstream. */
export type AgreementRole =
  (typeof AGREEMENT_ROLES)[number] | (string & NonNullable<unknown>)

/** Job-board sort orders. */
export type AgreementSort =
  | 'posted_desc'
  | 'reward_desc'
  | 'accept_deadline_asc'
  | 'delivery_deadline_asc'

/**
 * Read-your-writes: serve data that includes at least this indexer checkpoint
 * (e.g. the checkpoint of your transaction). If the indexer has not reached
 * it, the gateway waits briefly and then answers with older data.
 */
export interface MinCheckpoint {
  minCheckpoint?: string | bigint
}

/** Cursor paging shared by the agreement lists. */
export interface AgreementPageParams extends MinCheckpoint {
  /** 1–100, default 50. */
  limit?: number
  /** `nextCursor` from the previous page. */
  cursor?: string
}

/** Filters for the job board (`hauling.agreements`). */
export interface AgreementFilters extends AgreementPageParams {
  /** One status or several; default open. */
  status?: AgreementStatus | AgreementStatus[]
  /** Reward coin type, e.g. the CRED type. */
  currency?: string
  /** Minimum reward, raw base units. */
  minReward?: bigint | string
  sourceHubId?: string
  destinationHubId?: string
  cargoCollectionId?: string
  wantCollectionId?: string
  cargoAssetId?: string
  wantAssetId?: string
  lister?: string
  hauler?: string
  /** Agreements gated to (or posted for) this organization. */
  orgId?: string
  /** Only agreements with (true) or without (false) a claim gate. */
  gated?: boolean
  /** Report `eligibility` for this address on every row. */
  claimableBy?: string
  /** Epoch ms: only agreements whose accept deadline is before this. */
  acceptDeadlineBefore?: number
  sort?: AgreementSort
}

/** One agreement, optionally from a viewer's point of view. */
export interface AgreementParams extends MinCheckpoint {
  agreementId: string
  /** Include this address's roles and claim plan as `viewer`. */
  viewer?: string
}

/** An organization's agreements. */
export interface OrgAgreementsParams extends AgreementPageParams {
  orgId: string
  /**
   * `gated_to` (default): its board members may claim; `claimed_via`:
   * accepted through it; `posted_for`: posted on its behalf.
   */
  relation?: 'gated_to' | 'claimed_via' | 'posted_for'
  status?: AgreementStatus | AgreementStatus[]
}

/** An address's agreements. */
export interface PlayerAgreementsParams extends AgreementPageParams {
  /** Defaults to the configured player on `TriexClient`. */
  address?: string
  role?: AgreementRole | AgreementRole[]
  status?: AgreementStatus | AgreementStatus[]
}

/** Agreements an address can accept. */
export interface ClaimableAgreementsParams extends AgreementPageParams {
  /** Defaults to the configured player on `TriexClient`. */
  address?: string
  /**
   * Also list agreements whose eligibility can't be decided (rules the
   * indexer cannot evaluate). Default false.
   */
  includeUnknown?: boolean
}

/** An address-scoped read with no other parameters. */
export interface PlayerHaulingParams extends MinCheckpoint {
  /** Defaults to the configured player on `TriexClient`. */
  address?: string
}

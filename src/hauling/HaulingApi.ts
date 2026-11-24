import type { HaulingQueries } from './queries'
import type {
  AgreementFilters,
  AgreementParams,
  ClaimableAgreementPage,
  ClaimableAgreementsParams,
  HaulingActionPage,
  HaulingAgreementDetail,
  HaulingAgreementPage,
  HaulingConfig,
  HaulingReputation,
  HaulingStats,
  MinCheckpoint,
  OrgAgreementsParams,
  PlayerAgreementsParams,
  PlayerHaulingParams,
} from './types'

/**
 * Hauling agreements: on-chain jobs to move cargo between hubs for an escrowed
 * reward. These are the reads — the job board, one agreement in full, what a
 * player can accept and what they must do next, reputations and protocol
 * stats.
 *
 * The same class serves both clients. On `TriexClient` the player-scoped reads
 * default `address` to the configured player; on `ReadOnlyClient` it must be
 * passed. Every read takes `minCheckpoint` for read-your-writes after a
 * transaction.
 */
export class HaulingApi {
  constructor(
    private readonly q: HaulingQueries,
    private readonly requireAddress: (address?: string) => string,
  ) {}

  /**
   * The job board: open agreements by default, newest first. Filter by
   * status, currency, reward, hubs, items, parties and gating; pass
   * `claimableBy` to get each row's `eligibility` for an address. 50 CU.
   */
  agreements(filters?: AgreementFilters): Promise<HaulingAgreementPage> {
    return this.q.agreements(filters)
  }

  /**
   * One agreement in full: parties, cargo and wanted items, payment and
   * deadlines, accept requirements, cap, proceeds, fees, claims and timeline.
   * Pass `viewer` for that address's roles and claim plan. 30 CU.
   * @throws `AgreementNotFound`.
   */
  agreement(params: AgreementParams): Promise<HaulingAgreementDetail> {
    return this.q.agreement(params)
  }

  /** What posting costs and accepts: currencies, posting fee, delivery fee. 20 CU. */
  config(params?: MinCheckpoint): Promise<HaulingConfig> {
    return this.q.config(params)
  }

  /** Protocol-wide counts, volumes per currency and the busiest lanes. 50 CU. */
  stats(params?: MinCheckpoint): Promise<HaulingStats> {
    return this.q.stats(params)
  }

  /**
   * An organization's agreements: those its board may claim (`gated_to`,
   * default), accepted through it (`claimed_via`) or posted for it
   * (`posted_for`). 30 CU.
   * @throws `OrgNotFound`.
   */
  orgAgreements(params: OrgAgreementsParams): Promise<HaulingAgreementPage> {
    return this.q.orgAgreements(params)
  }

  /**
   * Agreements an address plays a part in, newest first; each row's
   * `viewerRoles` says which. 50 CU.
   * @throws `AddressRequired` when no address is configured or passed.
   */
  async playerAgreements(
    params?: PlayerAgreementsParams,
  ): Promise<HaulingAgreementPage> {
    return this.q.playerAgreements({
      ...params,
      address: this.requireAddress(params?.address),
    })
  }

  /**
   * The address's hauling to-do list: collect proceeds, delete a spent cap,
   * cancel a listing nobody accepted, deliver before the deadline (soonest
   * first) or default an overdue job it is owed. Each names its Move call.
   * 30 CU.
   * @throws `AddressRequired`.
   */
  async actions(params?: PlayerHaulingParams): Promise<HaulingActionPage> {
    return this.q.actions({
      ...params,
      address: this.requireAddress(params?.address),
    })
  }

  /**
   * Open agreements, before their accept deadline, that the address can
   * accept — each with its claim plan. 50 CU.
   * @throws `AddressRequired`.
   */
  async claimable(
    params?: ClaimableAgreementsParams,
  ): Promise<ClaimableAgreementPage> {
    return this.q.claimable({
      ...params,
      address: this.requireAddress(params?.address),
    })
  }

  /**
   * The address's record as hauler (completion rate, net reward, collateral
   * lost) and as lister. 30 CU.
   * @throws `AddressRequired`.
   */
  async reputation(params?: PlayerHaulingParams): Promise<HaulingReputation> {
    return this.q.reputation({
      ...params,
      address: this.requireAddress(params?.address),
    })
  }
}

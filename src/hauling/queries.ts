import type { TriexGateway } from '../gateways'
import { TriexError } from '../errors'
import {
  checkpointParam as checkpoint,
  indexerGet,
  type QueryParams,
} from '../http'
import { parseWith } from '../schemas'
import {
  ClaimableAgreementPageSchema,
  HaulingActionPageSchema,
  HaulingAgreementDetailSchema,
  HaulingAgreementPageSchema,
  HaulingConfigSchema,
  HaulingReputationSchema,
  HaulingStatsSchema,
} from './schemas'
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
} from './types'

/** Comma-join a one-or-many filter, as the gateway takes it. */
function list(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.join(',') : value
}

/**
 * Raw hauling-agreement reads: one method per gateway operation, identity
 * always explicit. `TriexClient.hauling` / `ReadOnlyClient.hauling` wrap this.
 *
 * Every request is a literal path and query object so the gateway drift gate
 * (`scripts/gateway-surface.mjs`) can check it against the published contract.
 */
export class HaulingQueries {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly gateway: TriexGateway = 'triex',
    private readonly tenant?: string,
  ) {}

  private get<T = unknown>(
    path: string,
    query?: QueryParams,
    notFound?: TriexError,
  ): Promise<T> {
    return indexerGet<T>(
      this.baseUrl,
      this.apiKey,
      path,
      query,
      notFound,
      this.gateway,
      this.tenant,
    )
  }

  /** The job board: open agreements by default, newest first. 50 CU. */
  async agreements(filters?: AgreementFilters): Promise<HaulingAgreementPage> {
    const data = await this.get('/v1/agreements', {
      limit: filters?.limit,
      cursor: filters?.cursor,
      status: list(filters?.status),
      currency: filters?.currency,
      min_reward:
        filters?.minReward === undefined
          ? undefined
          : String(filters.minReward),
      source_hub_id: filters?.sourceHubId,
      destination_hub_id: filters?.destinationHubId,
      cargo_collection_id: filters?.cargoCollectionId,
      want_collection_id: filters?.wantCollectionId,
      cargo_asset_id: filters?.cargoAssetId,
      want_asset_id: filters?.wantAssetId,
      lister: filters?.lister,
      hauler: filters?.hauler,
      org_id: filters?.orgId,
      gated: filters?.gated,
      claimable_by: filters?.claimableBy,
      accept_deadline_before: filters?.acceptDeadlineBefore,
      sort: filters?.sort,
      min_checkpoint: checkpoint(filters),
    })
    return parseWith(HaulingAgreementPageSchema, data, 'hauling.agreements')
  }

  /** One agreement in full. 30 CU. */
  async agreement(params: AgreementParams): Promise<HaulingAgreementDetail> {
    const data = await this.get(
      `/v1/agreements/${encodeURIComponent(params.agreementId)}`,
      { viewer: params.viewer, min_checkpoint: checkpoint(params) },
      TriexError.AgreementNotFound,
    )
    return parseWith(HaulingAgreementDetailSchema, data, 'hauling.agreement')
  }

  /**
   * The protocol config: approved currencies, posting fee, delivery fee and
   * treasury. The gateway answers 503 until the indexer has seen the first
   * config. 20 CU.
   */
  async config(params?: MinCheckpoint): Promise<HaulingConfig> {
    const data = await this.get('/v1/agreements/config', {
      min_checkpoint: checkpoint(params),
    })
    return parseWith(HaulingConfigSchema, data, 'hauling.config')
  }

  /** Protocol-wide stats; cached for 30 s upstream. 50 CU. */
  async stats(params?: MinCheckpoint): Promise<HaulingStats> {
    const data = await this.get('/v1/agreements/stats', {
      min_checkpoint: checkpoint(params),
    })
    return parseWith(HaulingStatsSchema, data, 'hauling.stats')
  }

  /** An organization's agreements, newest first. 30 CU. */
  async orgAgreements(
    params: OrgAgreementsParams,
  ): Promise<HaulingAgreementPage> {
    const data = await this.get(
      `/v1/orgs/${encodeURIComponent(params.orgId)}/agreements`,
      {
        limit: params.limit,
        cursor: params.cursor,
        relation: params.relation,
        status: list(params.status),
        min_checkpoint: checkpoint(params),
      },
      TriexError.OrgNotFound,
    )
    return parseWith(HaulingAgreementPageSchema, data, 'hauling.orgAgreements')
  }

  /** Agreements an address plays a part in, newest first. 50 CU. */
  async playerAgreements(
    params: PlayerAgreementsParams & { address: string },
  ): Promise<HaulingAgreementPage> {
    const data = await this.get(
      `/v1/players/${encodeURIComponent(params.address)}/agreements`,
      {
        limit: params.limit,
        cursor: params.cursor,
        role: list(params.role),
        status: list(params.status),
        min_checkpoint: checkpoint(params),
      },
    )
    return parseWith(
      HaulingAgreementPageSchema,
      data,
      'hauling.playerAgreements',
    )
  }

  /** What an address can do next. 30 CU. */
  async actions(
    params: MinCheckpoint & { address: string },
  ): Promise<HaulingActionPage> {
    const data = await this.get(
      `/v1/players/${encodeURIComponent(params.address)}/agreements/actions`,
      { min_checkpoint: checkpoint(params) },
    )
    return parseWith(HaulingActionPageSchema, data, 'hauling.actions')
  }

  /** Open agreements an address can accept, with claim plans. 50 CU. */
  async claimable(
    params: ClaimableAgreementsParams & { address: string },
  ): Promise<ClaimableAgreementPage> {
    const data = await this.get(
      `/v1/players/${encodeURIComponent(params.address)}/agreements/claimable`,
      {
        limit: params.limit,
        cursor: params.cursor,
        include_unknown: params.includeUnknown,
        min_checkpoint: checkpoint(params),
      },
    )
    return parseWith(ClaimableAgreementPageSchema, data, 'hauling.claimable')
  }

  /** An address's record as hauler and as lister. 30 CU. */
  async reputation(
    params: MinCheckpoint & { address: string },
  ): Promise<HaulingReputation> {
    const data = await this.get(
      `/v1/players/${encodeURIComponent(params.address)}/agreements/reputation`,
      { min_checkpoint: checkpoint(params) },
    )
    return parseWith(HaulingReputationSchema, data, 'hauling.reputation')
  }
}

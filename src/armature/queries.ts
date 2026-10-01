import { TriexClientError, TriexError } from '../errors'
import { indexerGet } from '../http'
import { parseWith } from '../schemas'
import {
  AccessibleKeyspaceListSchema,
  HubDaoVaultListSchema,
  OrgDirectoryPageSchema,
  OrgListSchema,
  OrgSchema,
  OrgSearchResponseSchema,
  ProposalSummaryListSchema,
} from './schemas'
import type {
  AccessibleKeyspace,
  HubDaoVault,
  Org,
  OrgDirectoryPage,
  OrgDirectoryParams,
  OrgSearchParams,
  OrgSearchResult,
  ProposalSummary,
} from './types'

/** Batch endpoints cap at 200 ids per call (per the published spec). */
export const MAX_BATCH_IDS = 200

/**
 * Indexer reads for the Armature surface: organizations, their unit trees,
 * proposals, keyspace access, and shared-storage vaults.
 *
 * Reached as `client.indexer.orgs` (low level) or `client.orgs` / the
 * `OrgsApi` facade (high level). Every route here is already enabled on the
 * gateway — see DESIGN-ARMATURE.md §13.1 for the inventory and CU costs.
 *
 * ERRORS — as everywhere else: `Unauthorized`, `RateLimited` (carries
 * `retryAfterMs`), `IndexerError`, `UnexpectedResponse`.
 */
export class OrgQueries {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private fetchJson<T = unknown>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    notFound?: TriexError,
  ): Promise<T> {
    return indexerGet<T>(this.baseUrl, this.apiKey, path, query, notFound)
  }

  // ─── Organizations ────────────────────────────────────────────────────────

  /**
   * A2 — one organization with its complete unit tree. The id may be the
   * top-level organization OR any unit within its tree; the TOP-LEVEL
   * organization is always what comes back, so callers holding a sub-DAO id
   * still get the whole graph. Cached upstream for 5 minutes.
   *
   * @throws `OrgNotFound` when the id resolves to no organization.
   */
  async get(orgId: string): Promise<Org> {
    const data = await this.fetchJson(
      `/v1/orgs/${encodeURIComponent(orgId)}`,
      undefined,
      TriexError.OrgNotFound,
    )
    return parseWith(OrgSchema, data, 'org')
  }

  /**
   * A3 — batch-resolve organization ids (max 200), in request order. Ids that
   * do not resolve come back with null fields and
   * `metadata.errorReason === 'unresolved'` rather than being dropped, so the
   * result is index-aligned with the request.
   *
   * @throws `ValidationFailed` when more than 200 ids are passed.
   */
  async batch(orgIds: string[]): Promise<Org[]> {
    requireBatchSize(orgIds, 'orgIds')
    if (orgIds.length === 0) return []
    const data = await this.fetchJson('/v1/orgs', { ids: orgIds.join(',') })
    return parseWith(OrgListSchema, data, 'orgs')
  }

  /**
   * A4 — the discovery directory: top-level organizations only, never their
   * internal units. Sorted by member count (largest first) unless `sort` says
   * otherwise. Page with `cursor`, or stream it via `iterateOrgDirectory`.
   */
  async directory(params?: OrgDirectoryParams): Promise<OrgDirectoryPage> {
    const data = await this.fetchJson('/v1/orgs/directory', {
      limit: params?.limit,
      cursor: params?.cursor,
      sort: params?.sort,
    })
    return parseWith(OrgDirectoryPageSchema, data, 'orgDirectory')
  }

  /**
   * A1 — every organization the address is a current governance member of,
   * each resolved to its full unit tree. One entry per distinct TOP-LEVEL
   * organization; inspect each tree's per-unit `members` (or use
   * `seatsFor()`) to find exactly where the address sits.
   */
  async forPlayer(address: string): Promise<Org[]> {
    const data = await this.fetchJson(
      `/v1/players/${encodeURIComponent(address)}/orgs`,
    )
    return parseWith(OrgListSchema, data, 'playerOrgs')
  }

  /**
   * A5 — search organization UNITS by name, organization id, or treasury id.
   * A hit can be a unit deep in a tree, so each carries `rootOrgId`/`rootName`
   * for labelling. `enrich` resolves icons/descriptions at the cost of a
   * metadata lookup per hit, so it is off by default.
   */
  async search(
    q: string,
    params?: OrgSearchParams,
  ): Promise<OrgSearchResult[]> {
    const data = await this.fetchJson('/v1/search', {
      q,
      orgs: true,
      characters: false,
      limit: params?.limit,
      enrich_orgs: params?.enrich,
    })
    return parseWith(OrgSearchResponseSchema, data, 'orgSearch')
  }

  // ─── Proposals ────────────────────────────────────────────────────────────

  /**
   * A7 — every governance proposal of an organization, newest first.
   *
   * DISCOVERY ONLY: per-proposal configuration and snapshot weights are not
   * included. To decide a vote, hydrate the live on-chain object instead
   * (DESIGN-ARMATURE.md §8) — `yesWeight`/`noWeight` here have no denominator.
   */
  async proposals(orgId: string): Promise<ProposalSummary[]> {
    const data = await this.fetchJson(
      `/v1/orgs/${encodeURIComponent(orgId)}/proposals`,
    )
    return parseWith(ProposalSummaryListSchema, data, 'orgProposals')
  }

  // ─── Keyspaces ────────────────────────────────────────────────────────────

  /**
   * A10 — every keyspace the address can reach: registered by one of their
   * organizations (`created`), granted to them directly (`player_grant`), or
   * granted to one of their organizations (`ou_grant`). Organizations are
   * resolved server-side, so only the address is needed.
   *
   * Metadata only. Decrypting an entry needs a Seal session key the wallet
   * signs — that lives in `@trinaryex/keyspace`, deliberately not here.
   */
  async accessibleKeyspaces(
    address: string,
    role?: 'grant' | 'read' | 'write',
  ): Promise<AccessibleKeyspace[]> {
    const data = await this.fetchJson(
      `/v1/players/${encodeURIComponent(address)}/accessible-keyspaces`,
      { role },
    )
    return parseWith(AccessibleKeyspaceListSchema, data, 'accessibleKeyspaces')
  }

  // ─── Shared storage ───────────────────────────────────────────────────────

  /**
   * E1 — active organization receipt vaults registered at a trade hub, each
   * with its grant/revoke-netted member set per role. Cached upstream for 30s.
   *
   * This answers "who can use which shared storage here". It does NOT carry
   * vault balances — those are a fullnode read (Phase D).
   */
  async vaultsAtHub(hubId: string): Promise<HubDaoVault[]> {
    const data = await this.fetchJson(
      `/v1/hubs/${encodeURIComponent(hubId)}/dao-vaults`,
      undefined,
      TriexError.HubNotFound,
    )
    return parseWith(HubDaoVaultListSchema, data, 'hubDaoVaults')
  }
}

/** @internal — batch endpoints reject >200 ids upstream; fail before the call. */
function requireBatchSize(ids: string[], what: string): void {
  if (ids.length > MAX_BATCH_IDS) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      `${what}: at most ${MAX_BATCH_IDS} ids per call (got ${ids.length}).`,
    )
  }
}

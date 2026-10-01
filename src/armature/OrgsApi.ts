import type { IndexerClient } from '../queries'
import { flattenOrg, resolveSeat, seatsFor, tradingNode } from './tree'
import type {
  AccessibleKeyspace,
  HubDaoVault,
  Org,
  OrgDirectoryPage,
  OrgDirectoryParams,
  OrgNode,
  OrgSearchParams,
  OrgSearchResult,
  OrgSeat,
  ProposalSummary,
} from './types'

/**
 * Organization identity & discovery — the read half of the Armature surface.
 *
 * Shared verbatim by `TriexClient.orgs` and `ReadOnlyClient.orgs`: none of it
 * signs anything, so a dashboard and a bot get the same methods. Acting AS an
 * organization is a different thing entirely and lives on the handle returned
 * by `client.org(id)` (Phase B).
 *
 * Where a method takes an address, `TriexClient` defaults it to the configured
 * player; `ReadOnlyClient` requires it explicitly, since it has no identity.
 *
 * ERRORS — every method throws `TriexClientError` with a stable `code`:
 * `Unauthorized`, `RateLimited` (carries `retryAfterMs`), `IndexerError`,
 * `UnexpectedResponse`, plus `OrgNotFound` / `HubNotFound` on unknown ids.
 */
export class OrgsApi {
  constructor(
    private readonly indexer: IndexerClient,
    /** Resolves the caller address; throws `AddressRequired` when unset. */
    private readonly requireAddress: (override?: string) => string,
  ) {}

  /**
   * A2 — one organization with its full unit tree. Any unit id in the tree
   * resolves to the TOP-LEVEL organization, so a sub-DAO id is a valid handle
   * on the whole graph.
   * @throws `OrgNotFound` when nothing resolves.
   */
  get(orgId: string): Promise<Org> {
    return this.indexer.orgs.get(orgId)
  }

  /**
   * A3 — batch-resolve organization ids (max 200), index-aligned with the
   * request. Unresolvable ids come back with null fields and
   * `metadata.errorReason === 'unresolved'` rather than being dropped.
   * @throws `ValidationFailed` when more than 200 ids are passed.
   */
  batch(orgIds: string[]): Promise<Org[]> {
    return this.indexer.orgs.batch(orgIds)
  }

  /**
   * A4 — the discovery directory: top-level organizations only, largest first
   * by default. One page; use `iterateOrgDirectory` to stream all of them.
   */
  directory(params?: OrgDirectoryParams): Promise<OrgDirectoryPage> {
    return this.indexer.orgs.directory(params)
  }

  /**
   * A1 — every organization the address governs, each as a full tree. Pair
   * with `seats()` to find where within each tree the address actually sits.
   * @throws `AddressRequired` when no address is configured or passed.
   */
  async forPlayer(address?: string): Promise<Org[]> {
    return this.indexer.orgs.forPlayer(this.requireAddress(address))
  }

  /**
   * A5 — search organization units by name, organization id, or treasury id.
   * Hits can be units deep in a tree, so each carries `rootOrgId`/`rootName`.
   */
  search(q: string, params?: OrgSearchParams): Promise<OrgSearchResult[]> {
    return this.indexer.orgs.search(q, params)
  }

  /**
   * A7 — an organization's proposals, newest first.
   *
   * DISCOVERY ONLY — no configs, no snapshot weight, so `yesWeight`/`noWeight`
   * have no denominator here. Hydrate the live object before deciding a vote.
   */
  proposals(orgId: string): Promise<ProposalSummary[]> {
    return this.indexer.orgs.proposals(orgId)
  }

  /**
   * A10 — keyspaces the address can reach, and how (`created` /
   * `player_grant` / `ou_grant`). Metadata only: decryption needs a
   * wallet-signed Seal session key and lives in `@trinaryex/keyspace`.
   * @throws `AddressRequired` when no address is configured or passed.
   */
  async accessibleKeyspaces(
    address?: string,
    role?: 'grant' | 'read' | 'write',
  ): Promise<AccessibleKeyspace[]> {
    return this.indexer.orgs.accessibleKeyspaces(
      this.requireAddress(address),
      role,
    )
  }

  /**
   * E1 — active organization receipt vaults at a trade hub, with their
   * grant/revoke-netted ACL per role. Balances are a fullnode read (Phase D).
   */
  vaultsAtHub(hubId: string): Promise<HubDaoVault[]> {
    return this.indexer.orgs.vaultsAtHub(hubId)
  }

  // ─── Tree convenience (one fetch + pure lookups) ──────────────────────────

  /**
   * The organization's control tree flattened into nodes, depth-first from the
   * root. Address units by `daoId`; find the trading account by
   * `balanceManagerId`, not by role label.
   */
  async nodes(orgId: string): Promise<OrgNode[]> {
    return flattenOrg(await this.get(orgId))
  }

  /**
   * Every unit of this organization whose board the address sits on, highest
   * authority first. Empty means the address governs nothing here.
   * @throws `AddressRequired` when no address is configured or passed.
   */
  async seats(orgId: string, address?: string): Promise<OrgSeat[]> {
    const who = this.requireAddress(address)
    return seatsFor(await this.nodes(orgId), who)
  }

  /**
   * The seat to act through: `preferredDaoId` when the address still holds it,
   * otherwise the highest-authority seat, otherwise null. Falls back rather
   * than throwing, because a stale selection is the usual cause.
   * @throws `AddressRequired` when no address is configured or passed.
   */
  async seat(
    orgId: string,
    preferredDaoId?: string | null,
    address?: string,
  ): Promise<OrgSeat | null> {
    const who = this.requireAddress(address)
    return resolveSeat(await this.nodes(orgId), who, preferredDaoId)
  }

  /**
   * The organization's trading account (`balanceManagerId`) and the unit that
   * holds it, or null when trading was never set up. Feed the id straight to
   * the order-status reads — `openOrders`, `fills`, `trades`, `sweepable` all
   * take a balance manager id and do not care who owns it.
   */
  async tradingAccount(
    orgId: string,
  ): Promise<{ balanceManagerId: string; node: OrgNode } | null> {
    const node = tradingNode(await this.nodes(orgId))
    return node?.balanceManagerId
      ? { balanceManagerId: node.balanceManagerId, node }
      : null
  }
}

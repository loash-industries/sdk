import type { ClientWithCoreApi } from '@mysten/sui/client'

import { TriexClientError, TriexError } from '../errors'
import { executeAndNormalize } from '../execute'
import type { IndexerClient } from '../queries'
import type { PackageIds, TransactionExecutor, TxResult } from '../types'
import { createTribeTx, tradingTypeInits, type TypeInitInput } from './create'
import { fetchOuState } from './governance'
import { fetchCapabilityVault } from './proposals'
import { createOuTx } from './transactions'
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
   * resolves to the TOP-LEVEL organization, so a sub-OU id is a valid handle
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
   * `tradingAccountId`, not by role label.
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
   * The organization's trading account (`tradingAccountId`) and the unit that
   * holds it, or null when trading was never set up. Feed the id straight to
   * the order-status reads — `openOrders`, `fills`, `trades`, `sweepable` all
   * take a trading account id and do not care who owns it.
   */
  async tradingAccount(
    orgId: string,
  ): Promise<{ tradingAccountId: string; node: OrgNode } | null> {
    const node = tradingNode(await this.nodes(orgId))
    return node?.tradingAccountId
      ? { tradingAccountId: node.tradingAccountId, node }
      : null
  }
}

// ─── Creating organizations (needs a signer) ─────────────────────────────────

/** Parameters for `orgs.create` — a three-tier organization in one call. */
export interface CreateOrgParams {
  name: string
  metadataUri: string
  /** Officers (the caller is always added). */
  officers?: string[]
  /** Line members (the caller is always added). */
  members?: string[]
  /** Root board; defaults to `[caller]`. */
  board?: string[]
  officerName?: string
  memberName?: string
  officerMetadataUri?: string
  memberMetadataUri?: string
  /** Receives both sub-units' `FreezeAdminCap`s; defaults to the caller. */
  freezeAdmin?: string
  /**
   * Enable every `armature_trading` type on the officer unit at creation
   * (single-vote), so the org can trade at once. Default true.
   */
  enableTrading?: boolean
  /** Quote coin the trading types are instantiated at; defaults to CRED. */
  quoteType?: string
  /** Extra `ou::ProposalTypeInit`s per tier, applied after the defaults. */
  overrides?: {
    org?: TypeInitInput[]
    officers?: TypeInitInput[]
    members?: TypeInitInput[]
  }
}

/** The result of `orgs.create`: the three unit ids, resolved from chain. */
export interface CreatedOrg {
  /** Root ("org") unit — the id every `client.org()` call takes. */
  orgId: string
  officersId: string
  membersId: string
  tx: TxResult
}

/** What creating needs beyond the read surface. */
export interface OrgsWriteDeps {
  suiClient: ClientWithCoreApi
  ids: PackageIds
  requireExecutor: () => TransactionExecutor
}

/**
 * `OrgsApi` plus organization CREATION — the shape of `TriexClient.orgs`
 * (`ReadOnlyClient.orgs` stays the read-only base).
 */
export class OrgsWriteApi extends OrgsApi {
  constructor(
    indexer: IndexerClient,
    private readonly addressOf: (override?: string) => string,
    private readonly w: OrgsWriteDeps,
  ) {
    super(indexer, addressOf)
  }

  /**
   * B1 — create an organization: root + officers + members units, controls
   * wired and the controller types enabled
   * (`armature_proposals::tribe_setup::create_tribe_configured`). The caller
   * sits on all three boards; the root's `FreezeAdminCap` goes to the caller.
   *
   * The SDK does not host metadata — pass URIs you already uploaded.
   */
  async create(params: CreateOrgParams): Promise<CreatedOrg> {
    const me = this.addressOf()
    const withMe = (xs: string[] = []) => [...new Set([me, ...xs])]
    const { ids } = this.w
    const officerOverrides = [
      ...(params.enableTrading === false || !ids.armatureTrading
        ? []
        : tradingTypeInits(
            ids.armatureTrading,
            params.quoteType ?? ids.credCoinType,
          )),
      ...(params.overrides?.officers ?? []),
    ]
    const tx = createTribeTx({
      armature: ids.armature,
      armatureProposals: ids.armatureProposals,
      tribeBoard: params.board ?? [me],
      officers: withMe(params.officers),
      members: withMe(params.members),
      tribeName: params.name,
      officerName: params.officerName ?? `${params.name} Officers`,
      memberName: params.memberName ?? `${params.name} Members`,
      tribeMetadataUri: params.metadataUri,
      officerMetadataUri: params.officerMetadataUri ?? params.metadataUri,
      memberMetadataUri: params.memberMetadataUri ?? params.metadataUri,
      officerFreezeAdmin: params.freezeAdmin ?? me,
      memberFreezeAdmin: params.freezeAdmin ?? me,
      tribeOverrides: params.overrides?.org,
      officerOverrides,
      memberOverrides: params.overrides?.members,
    })
    const res = await executeAndNormalize(this.w.requireExecutor(), tx)
    const result: TxResult = {
      digest: res.digest,
      createdObjects: res.createdObjects,
      raw: res.raw,
    }
    const ouIds = res.createdObjects
      .filter((o) => /::ou::OU$/.test(o.objectType))
      .map((o) => o.objectId)
    const tiers = await this.identifyTiers(ouIds)
    return { ...tiers, tx: result }
  }

  /**
   * A single standalone OU (`ou::create`) — default slots, no parent, no
   * children. Returns its id from the transaction's effects.
   */
  async createStandalone(params: {
    name: string
    metadataUri: string
    board?: string[]
  }): Promise<{ ouId: string | undefined; tx: TxResult }> {
    const tx = createOuTx({
      armature: this.w.ids.armature,
      board: params.board ?? [this.addressOf()],
      name: params.name,
      metadataUri: params.metadataUri,
    })
    const res = await executeAndNormalize(this.w.requireExecutor(), tx)
    return {
      ouId: res.createdObjects.find((o) => /::ou::OU$/.test(o.objectType))
        ?.objectId,
      tx: {
        digest: res.digest,
        createdObjects: res.createdObjects,
        raw: res.raw,
      },
    }
  }

  /** @internal — which created OU is the root, the officers, the members. */
  private async identifyTiers(
    ouIds: string[],
  ): Promise<{ orgId: string; officersId: string; membersId: string }> {
    if (ouIds.length !== 3) {
      throw new TriexClientError(
        TriexError.UnexpectedResponse,
        `Expected the transaction to create 3 OUs, saw ${ouIds.length} — the executor may not surface created objects.`,
      )
    }
    const states = await Promise.all(
      ouIds.map((id) => fetchOuState(this.w.suiClient, id)),
    )
    const rootIdx = states.findIndex((s) => !s.controllerCapId)
    if (rootIdx < 0) {
      throw new TriexClientError(
        TriexError.UnexpectedResponse,
        'Could not tell the root unit apart: every created OU has a controller.',
      )
    }
    // The root's vault holds the officers' SubOUControl; the officers' vault
    // holds the members'.
    const rootVault = await fetchCapabilityVault(
      this.w.suiClient,
      states[rootIdx].capabilityVaultId,
    )
    const held = new Set(rootVault.capIds.map((x) => x.toLowerCase()))
    const others = ouIds
      .map((id, i) => ({ id, s: states[i] }))
      .filter((_, i) => i !== rootIdx)
    const officers = others.find(
      (o) =>
        !!o.s.controllerCapId && held.has(o.s.controllerCapId.toLowerCase()),
    )
    const members = others.find((o) => o !== officers)
    if (!officers || !members) {
      throw new TriexClientError(
        TriexError.UnexpectedResponse,
        'Could not tell the officers unit from the members unit.',
      )
    }
    return {
      orgId: ouIds[rootIdx],
      officersId: officers.id,
      membersId: members.id,
    }
  }
}

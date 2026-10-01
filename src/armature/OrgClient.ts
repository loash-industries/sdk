import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Transaction as SuiTransaction } from '@mysten/sui/transactions'
import type { Transaction } from '@mysten/sui/transactions'

import { TriexClientError, TriexError } from '../errors'
import { executeAndNormalize } from '../execute'
import type { IndexerClient } from '../queries'
import type { PackageIds, TransactionExecutor, TxResult } from '../types'
import {
  addMembersAction,
  type ArmaturePkgs,
  compositeStepExecutor,
  enableCompositeAction,
  enableSendCoinAction,
  enableProposalTypeAction,
  enableTradingActions,
  passedProposalAction,
  type ProposalConfigPatch,
  removeMembersAction,
  setBoardAction,
  updateMetadataAction,
  updateProposalConfigAction,
} from './actions'
import type { DaoGovernance } from './governance'
import { fetchDaoGovernance } from './governance'
import {
  type BlockCode,
  canComposite,
  type CompositeEligibility,
  evaluatePaths,
  type OuCapabilities,
  type OuProposalAction,
  type PathCandidate,
  type ResolvedPlan,
} from './harness'
import {
  appendPlanActions,
  buildBatchPlanTx,
  buildCompositeSubmitTx,
  buildExecuteCompositeTx,
  buildExecutePassedTx,
  type CompositeStep,
  extractCreatedProposalId,
  resolveExecutionPlan,
} from './plan'
import type { ProposalConfigInput } from './transactions'
import { tryExpireTx, voteTx } from './transactions'
import {
  appendClaimSettled,
  cancelOrderAction,
  depositCoinToBookAction,
  depositFromDaoVaultToBookAction,
  placeLimitOrderAction,
  setupTradingAccountAction,
  sweepCoinToTreasuryAction,
  sweepMulticoinToDaoVaultAction,
  type OrderFlags,
  type TradingContext,
} from './trading'
import {
  deinitializeDaoVaultTx,
  depositReceiptTx,
  fetchDaoVaultInfo,
  fetchVaultBalance,
  grantEditOuTx,
  grantTx,
  initializeDaoVaultTx,
  resolveDaoVaultId,
  revokeTx,
  sourceWalletReceipts,
  withdrawReceiptTx,
  toStorageUnitId,
  type DaoVaultInfo,
} from './vault'
import {
  depositToTreasuryTx,
  fetchTreasuryCoinBalance,
  fetchTreasuryCoinBalances,
  fetchTreasuryItemBalance,
  sendCoinAction,
  sendCoinToDaoAction,
  type TreasuryCoinBalance,
} from './treasury'
import { computeBidQuoteDeposit, GTC_EXPIRE } from '../money'
import { getTradingAccountCurrencyBalance } from '../onchain'
import type { OrderSide } from '../types'
import { execContextFor, flattenOrg, resolveSeat, seatsFor } from './tree'
import type {
  HubDaoVault,
  Org,
  OrgNode,
  OrgSeat,
  OuExecContext,
  ProposalSummary,
  VaultPrincipal,
  VaultRole,
} from './types'

/**
 * A handle bound to one organization AND one seat within it.
 *
 * The seat matters as much as the organization: every governance write is
 * resolved against a specific board, so "act as this org" is not a complete
 * instruction until you say which unit you are acting through. The handle
 * resolves the tree once, picks the caller's highest-authority seat by default,
 * and caches the governance state for that seat and its parent — which is what
 * lets `org.members.add([...])` be one call instead of six.
 *
 * Obtain one from `client.org(orgId)`; switch seats with `org.as(daoId)`.
 */

/**
 * The outcome of a governance write.
 *
 * A governance action does not have one shape, so this does not pretend to:
 * the same call executes for an officer and defers for a member. Callers branch
 * on `status`.
 *
 * `blocked` is a RETURNED VALUE, not a thrown error — "you are not on this
 * board" is an ordinary answer to "can I do this?". Genuine failures
 * (transport, on-chain abort, schema drift) still throw `TriexClientError`.
 */
export type RunOutcome =
  | { status: 'executed'; digest: string }
  | {
      status: 'proposed'
      digest: string
      /** From the transaction's effects — never a follow-up indexer read. */
      proposalId?: string
    }
  | { status: 'blocked'; code: BlockCode; reason: string }

/** What an `OrgHandle` needs from the owning client. */
export interface OrgHandleDeps {
  suiClient: ClientWithCoreApi
  indexer: IndexerClient
  ids: PackageIds
  /** Resolves the executor, throwing `ExecutorRequired` when absent. */
  requireExecutor: () => TransactionExecutor
  /** The acting address — already resolved by the caller. */
  address: string
}

export class OrgHandle {
  /** The top-level organization, whatever unit id was used to open the handle. */
  readonly org: Org
  /** Every unit of the tree, depth-first from the root. */
  readonly nodes: OrgNode[]
  /** Every unit whose board the caller sits on, highest authority first. */
  readonly seats: OrgSeat[]
  /** The seat being acted through, or null when the caller holds none. */
  readonly seat: OrgSeat | null

  readonly governance: OrgGovernanceApi
  readonly members: OrgMembersApi
  readonly metadata: OrgMetadataApi
  readonly types: OrgTypesApi
  readonly treasury: OrgTreasuryApi
  readonly orders: OrgOrdersApi
  readonly vault: OrgVaultApi

  /** @internal — governance is read per DAO id and cached for the handle's life. */
  private readonly govCache = new Map<string, Promise<DaoGovernance>>()

  constructor(
    /** @internal */ readonly deps: OrgHandleDeps,
    org: Org,
    preferredSeatDaoId?: string | null,
  ) {
    this.org = org
    this.nodes = flattenOrg(org)
    this.seats = seatsFor(this.nodes, deps.address)
    this.seat = resolveSeat(this.nodes, deps.address, preferredSeatDaoId)

    this.governance = new OrgGovernanceApi(this)
    this.members = new OrgMembersApi(this)
    this.metadata = new OrgMetadataApi(this)
    this.types = new OrgTypesApi(this)
    this.treasury = new OrgTreasuryApi(this)
    this.orders = new OrgOrdersApi(this)
    this.vault = new OrgVaultApi(this)
  }

  /** The root organization's object id. */
  get orgId(): string {
    return this.org.orgId
  }

  /**
   * A handle acting through a different seat. Throws when the caller does not
   * hold that seat — unlike the default-seat fallback, naming a seat explicitly
   * is a claim, and silently acting through another one would be worse than
   * failing.
   */
  as(daoId: string): OrgHandle {
    const seat = this.seats.find(
      (s) => s.daoId.toLowerCase() === daoId.toLowerCase(),
    )
    if (!seat) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `You do not hold a board seat on ${daoId}. Seats held: ${
          this.seats.map((s) => s.daoId).join(', ') || '(none)'
        }`,
      )
    }
    return new OrgHandle(this.deps, this.org, daoId)
  }

  /** @internal — the acting seat, or a typed error when there is none. */
  requireSeat(): OrgSeat {
    if (!this.seat) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `${this.deps.address} holds no board seat in organization ${this.orgId}.`,
      )
    }
    return this.seat
  }

  /** @internal — the resolver's view of the acting seat. */
  requireContext(): OuExecContext {
    const seat = this.requireSeat()
    const ctx = execContextFor(this.nodes, seat.daoId)
    if (!ctx) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Unit ${seat.daoId} has no EmergencyFreeze object — it cannot execute governance actions.`,
      )
    }
    return ctx
  }

  /** @internal */
  pkgs(): ArmaturePkgs {
    return {
      armature: this.deps.ids.armature,
      armatureProposals: this.deps.ids.armatureProposals,
    }
  }

  /**
   * @internal — a DAO's governance, cached per handle.
   *
   * Cached deliberately: `resolve()` and `run()` each need the acting unit's
   * config AND its parent's, and a bot resolving twenty actions against one
   * seat should not re-read the same two objects forty times. The cache lives
   * only as long as the handle, so re-opening picks up a config change.
   */
  gov(daoId: string): Promise<DaoGovernance> {
    let cached = this.govCache.get(daoId)
    if (!cached) {
      cached = fetchDaoGovernance(this.deps.suiClient, daoId)
      this.govCache.set(daoId, cached)
    }
    return cached
  }

  /** Drop cached governance so the next resolve re-reads it. */
  refresh(): void {
    this.govCache.clear()
  }

  /**
   * @internal — the acting seat's TreasuryVault, or a typed error.
   *
   * A unit without one cannot hold or pay funds at all, which is a different
   * failure from "not allowed to" and worth saying separately.
   */
  requireTreasuryId(override?: string): string {
    const id = override ?? this.requireSeat().treasuryId
    if (!id) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Unit ${this.requireSeat().daoId} has no TreasuryVault.`,
      )
    }
    return id
  }

  /**
   * @internal — everything a trading action needs.
   *
   * The TradingAccount is found by CAPABILITY across the whole tree (whichever
   * unit holds one), while the CapabilityVault must be the ACTING seat's: the
   * TradeCap the handlers borrow lives with the board that votes.
   */
  tradingContext(): TradingContext {
    const seat = this.requireSeat()
    const bm = this.nodes.find((n) => n.tradingAccountId)?.tradingAccountId
    if (!bm) {
      throw new TriexClientError(
        TriexError.TradingAccountNotFound,
        `Organization ${this.orgId} has no trading account — run orders.ensureAccount() first.`,
      )
    }
    if (!seat.capabilityVaultId) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Unit ${seat.daoId} has no CapabilityVault, so it cannot hold a TradeCap.`,
      )
    }
    return {
      armatureTrading: this.deps.ids.armatureTrading,
      capVaultId: seat.capabilityVaultId,
      tradingAccountId: bm,
    }
  }

  /** @internal — run a prepared transaction and map it to a `TxResult`. */
  async submit(tx: Transaction): Promise<TxResult> {
    const res = await executeAndNormalize(this.deps.requireExecutor(), tx)
    return {
      digest: res.digest,
      createdObjects: res.createdObjects,
      raw: res.raw,
    }
  }
}

// ─── governance ──────────────────────────────────────────────────────────────

class OrgGovernanceApi {
  constructor(private readonly h: OrgHandle) {}

  /** The acting unit's enabled types, per-type configs, and bindings. */
  async read(daoId?: string): Promise<DaoGovernance> {
    return this.h.gov(daoId ?? this.h.requireSeat().daoId)
  }

  /** @internal — the own + control configs the resolver needs for one action. */
  private async caps(action: OuProposalAction): Promise<OuCapabilities> {
    const ctx = this.h.requireContext()
    const own = action.own ? await this.h.gov(ctx.daoId) : undefined
    const parent =
      action.control && ctx.parent
        ? await this.h.gov(ctx.parent.daoId)
        : undefined
    return {
      ownConfig: action.own
        ? (own?.configs.get(action.own.typeKey) ?? null)
        : null,
      controlConfig: action.control
        ? (parent?.configs.get(action.control.typeKey) ?? null)
        : null,
    }
  }

  /**
   * Decide how this action would be passed, WITHOUT signing anything — the
   * dry-run. Returns either a plan (with a lazy `buildTx`) or a blocked result
   * carrying the reason.
   */
  async resolve(action: OuProposalAction): Promise<ResolvedPlan> {
    return resolveExecutionPlan(
      action,
      this.h.requireContext(),
      await this.caps(action),
      this.h.deps.address,
      this.h.deps.ids.armature,
    )
  }

  /**
   * Every strategy's viability with a short explanation, viable or not — the
   * full trace behind what `resolve()` chose. Worth logging when a bot ends up
   * proposing where you expected it to execute.
   */
  async paths(action: OuProposalAction): Promise<PathCandidate[]> {
    return evaluatePaths(
      action,
      this.h.requireContext(),
      await this.caps(action),
      this.h.deps.address,
    )
  }

  /** Resolve an action and carry it out. */
  async run(action: OuProposalAction): Promise<RunOutcome> {
    const plan = await this.resolve(action)
    if (plan.blocked) {
      return { status: 'blocked', code: plan.code, reason: plan.reason }
    }
    return this.execPlanned(plan.buildTx(), plan.immediate)
  }

  /**
   * Apply several actions in ONE transaction under a single strategy.
   *
   * All actions must resolve to the same strategy — they are batched, not
   * independently routed — so this resolves the first and applies it to the
   * rest. On an immediate strategy they execute together and atomically; on a
   * slow one this creates N SEPARATE proposals in one signature, so the board
   * votes N times. Use `runComposite()` for one vote over many steps.
   */
  async runBatch(actions: OuProposalAction[]): Promise<RunOutcome> {
    if (actions.length === 0) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'runBatch needs at least one action.',
      )
    }
    const plan = await this.resolve(actions[0])
    if (plan.blocked) {
      return { status: 'blocked', code: plan.code, reason: plan.reason }
    }
    const tx = buildBatchPlanTx(
      plan.strategy,
      actions,
      this.h.requireContext(),
      this.h.deps.ids.armature,
    )
    return this.execPlanned(tx, plan.immediate)
  }

  /** Whether these actions can bundle into a single composite proposal. */
  async canComposite(
    actions: OuProposalAction[],
  ): Promise<CompositeEligibility> {
    return canComposite(actions, await this.read())
  }

  /**
   * Submit several own-DAO actions as ONE `Proposal<CompositePayload>` the
   * board votes on once.
   *
   * @throws `ValidationFailed` when the cart is not eligible — the reason names
   *   which of the four on-chain conditions failed.
   */
  async runComposite(actions: OuProposalAction[]): Promise<RunOutcome> {
    const eligibility = await this.canComposite(actions)
    if (!eligibility.eligible) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `These actions cannot be bundled into one composite proposal: ${eligibility.reason}.`,
      )
    }
    const tx = buildCompositeSubmitTx(
      actions,
      this.h.requireContext(),
      this.h.deps.ids.armature,
    )
    return this.execPlanned(tx, false)
  }

  /** Proposals of the whole organization, newest first (indexer, discovery only). */
  proposals(): Promise<ProposalSummary[]> {
    return this.h.deps.indexer.orgs.proposals(this.h.orgId)
  }

  /** @internal — the indexer summary for one proposal, or a typed error. */
  private async summary(proposalId: string): Promise<ProposalSummary> {
    const all = await this.proposals()
    const hit = all.find(
      (p) => p.proposalId.toLowerCase() === proposalId.toLowerCase(),
    )
    if (!hit) {
      throw new TriexClientError(
        TriexError.OrgNotFound,
        `Proposal ${proposalId} was not found on organization ${this.h.orgId}. ` +
          'A proposal created seconds ago may not be indexed yet — pass `payloadType` explicitly to act on it immediately.',
      )
    }
    return hit
  }

  /**
   * Vote on an open proposal.
   *
   * `payloadType` is the `P` in `proposal::vote<P>`. It is looked up from the
   * indexer when omitted, which costs a request and cannot see a
   * just-created proposal — pass it explicitly to skip both.
   */
  async vote(params: {
    proposalId: string
    approve: boolean
    payloadType?: string
  }): Promise<TxResult> {
    const payloadType =
      params.payloadType ?? (await this.summary(params.proposalId)).payloadType
    if (!payloadType) {
      throw new TriexClientError(
        TriexError.UnexpectedResponse,
        `Proposal ${params.proposalId} has no decoded payload type — pass \`payloadType\` explicitly.`,
      )
    }
    return this.h.submit(
      voteTx({
        armature: this.h.deps.ids.armature,
        proposalId: params.proposalId,
        payloadMoveType: payloadType,
        approve: params.approve,
      }),
    )
  }

  /**
   * Retire a proposal whose voting window lapsed. Permissionless — the indexer
   * reports such proposals as `pending` until someone calls this, so `pending`
   * and "still votable" are not the same thing.
   */
  async tryExpire(params: {
    proposalId: string
    payloadType?: string
  }): Promise<TxResult> {
    const payloadType =
      params.payloadType ?? (await this.summary(params.proposalId)).payloadType
    if (!payloadType) {
      throw new TriexClientError(
        TriexError.UnexpectedResponse,
        `Proposal ${params.proposalId} has no decoded payload type — pass \`payloadType\` explicitly.`,
      )
    }
    return this.h.submit(
      tryExpireTx({
        armature: this.h.deps.ids.armature,
        proposalId: params.proposalId,
        payloadMoveType: payloadType,
      }),
    )
  }

  /**
   * Execute a proposal the board already passed, dispatching to the same
   * handler the single-vote path would have used. Composites run their whole
   * frame pipeline in one transaction.
   *
   * @throws `ValidationFailed` when the proposal's type has no wired executor,
   *   or when a composite step does not — declining beats running a partial
   *   pipeline.
   */
  async execute(proposalId: string): Promise<TxResult> {
    const p = await this.summary(proposalId)
    const armature = this.h.deps.ids.armature
    const node = this.h.nodes.find(
      (n) => n.daoId.toLowerCase() === p.orgId.toLowerCase(),
    )
    const emergencyFreezeId = node?.emergencyFreezeId
    if (!node || !emergencyFreezeId) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Cannot execute ${proposalId}: unit ${p.orgId} has no EmergencyFreeze object in this tree.`,
      )
    }

    if (p.typeKey === 'Composite') {
      if (!p.frameId) {
        throw new TriexClientError(
          TriexError.UnexpectedResponse,
          `Composite proposal ${proposalId} carries no frame id.`,
        )
      }
      const steps: CompositeStep[] = []
      for (const step of p.composite ?? []) {
        const exec = compositeStepExecutor(
          this.h.pkgs(),
          step.stepTypeKey,
          step.stepType ?? undefined,
        )
        if (!exec) {
          throw new TriexClientError(
            TriexError.ValidationFailed,
            `Composite step ${step.stepIndex} (${step.stepTypeKey}) has no wired executor — refusing to run a partial pipeline.`,
          )
        }
        steps.push(exec)
      }
      return this.h.submit(
        buildExecuteCompositeTx({
          armature,
          daoId: p.orgId,
          proposalId,
          emergencyFreezeId,
          frameId: p.frameId,
          steps,
        }),
      )
    }

    const action = passedProposalAction(this.h.pkgs(), {
      typeKey: p.typeKey ?? '',
      charterId: node.charterId ?? undefined,
    })
    if (!action) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `No wired executor for proposal type '${p.typeKey}'.`,
      )
    }
    return this.h.submit(
      buildExecutePassedTx({
        action,
        armature,
        daoId: p.orgId,
        proposalId,
        emergencyFreezeId,
      }),
    )
  }

  /** @internal — execute a built transaction and shape the outcome. */
  private async execPlanned(
    tx: Transaction,
    immediate: boolean,
  ): Promise<RunOutcome> {
    const res = await executeAndNormalize(this.h.deps.requireExecutor(), tx)
    if (immediate) return { status: 'executed', digest: res.digest }
    return {
      status: 'proposed',
      digest: res.digest,
      proposalId: extractCreatedProposalId(res),
    }
  }
}

// ─── membership ──────────────────────────────────────────────────────────────

class OrgMembersApi {
  constructor(private readonly h: OrgHandle) {}

  /** Seat addresses on the acting unit's board. */
  add(addresses: string[]): Promise<RunOutcome> {
    return this.h.governance.run(addMembersAction(this.h.pkgs(), addresses))
  }

  /**
   * Remove addresses from the acting unit's board.
   *
   * Control-only on-chain, so this needs a parent unit. On a ROOT unit it
   * blocks; use `setBoard()` with the remaining members there.
   */
  remove(addresses: string[]): Promise<RunOutcome> {
    return this.h.governance.run(removeMembersAction(this.h.pkgs(), addresses))
  }

  /** Replace the acting unit's board wholesale. */
  setBoard(addresses: string[]): Promise<RunOutcome> {
    return this.h.governance.run(setBoardAction(this.h.pkgs(), addresses))
  }
}

// ─── metadata ────────────────────────────────────────────────────────────────

class OrgMetadataApi {
  constructor(private readonly h: OrgHandle) {}

  /**
   * Point the acting unit's charter at a new metadata document.
   *
   * The SDK does not host metadata — pass a URI you already uploaded
   * (DESIGN-ARMATURE.md OQ-A3).
   */
  async update(params: {
    metadataUri: string
    charterId?: string
  }): Promise<RunOutcome> {
    const charterId = params.charterId ?? this.h.requireSeat().charterId
    if (!charterId) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'This unit has no Charter object id — pass `charterId` explicitly.',
      )
    }
    return this.h.governance.run(
      updateMetadataAction(this.h.pkgs(), params.metadataUri, charterId),
    )
  }
}

// ─── proposal-type administration ────────────────────────────────────────────

class OrgTypesApi {
  constructor(private readonly h: OrgHandle) {}

  /** Enable an arbitrary proposal type on the acting unit. */
  enable(params: {
    typeKey: string
    moveType: string
    config: ProposalConfigInput
    composableAllowed?: boolean
  }): Promise<RunOutcome> {
    return this.h.governance.run(
      enableProposalTypeAction(this.h.pkgs(), {
        kind: 'enable_proposal_type',
        enabledTypeKey: params.typeKey,
        enabledMoveType: params.moveType,
        config: params.config,
        composableAllowed: params.composableAllowed,
      }),
    )
  }

  /** Change an enabled type's voting rules; omitted fields keep their value. */
  updateConfig(
    typeKey: string,
    patch: ProposalConfigPatch,
  ): Promise<RunOutcome> {
    return this.h.governance.run(
      updateProposalConfigAction(this.h.pkgs(), typeKey, patch),
    )
  }

  /** Enable the `Composite` type, so carts can bundle into one proposal. */
  enableComposite(): Promise<RunOutcome> {
    return this.h.governance.run(enableCompositeAction(this.h.pkgs()))
  }

  /** Enable treasury withdrawals of one coin (defaults to CRED). */
  enableSendCoin(coinType?: string): Promise<RunOutcome> {
    return this.h.governance.run(
      enableSendCoinAction(
        this.h.pkgs(),
        coinType ?? this.h.deps.ids.credCoinType,
      ),
    )
  }

  /**
   * Enable every `armature_trading` type not already on the acting unit, in one
   * transaction. A prerequisite for `org.orders.*` (Phase C).
   *
   * `bindToBaseType` is IRREVERSIBLE: it enables the coin-pool order types
   * bound to that one base coin, permanently, after which the unit can trade
   * only that base through governance. Organizations created by
   * `create_tribe_configured` already carry the unbound keys and trade any base
   * freely — leave it undefined for them. It exists only for units created
   * before those keys were registered.
   */
  async enableTrading(params?: {
    quoteType?: string
    bindToBaseType?: string
  }): Promise<RunOutcome> {
    const gov = await this.h.governance.read()
    const actions = enableTradingActions(this.h.pkgs(), {
      armatureTrading: this.h.deps.ids.armatureTrading,
      quoteType: params?.quoteType ?? this.h.deps.ids.credCoinType,
      alreadyEnabled: gov.enabledTypes,
      bindToBaseType: params?.bindToBaseType,
    })
    if (actions.length === 0) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Every trading proposal type is already enabled on this unit.',
      )
    }
    return this.h.governance.runBatch(actions)
  }
}

// ─── treasury ────────────────────────────────────────────────────────────────

class OrgTreasuryApi {
  constructor(private readonly h: OrgHandle) {}

  /**
   * Every coin the acting unit's treasury holds. Enumerated from the vault's
   * own `coin_types` set, so a coin fully withdrawn still reports as 0 rather
   * than disappearing.
   */
  async balances(treasuryVaultId?: string): Promise<TreasuryCoinBalance[]> {
    return fetchTreasuryCoinBalances(
      this.h.deps.suiClient,
      this.h.requireTreasuryId(treasuryVaultId),
    )
  }

  /** One coin's treasury balance (defaults to CRED), or 0n. */
  async balance(coinType?: string, treasuryVaultId?: string): Promise<bigint> {
    return fetchTreasuryCoinBalance(
      this.h.deps.suiClient,
      this.h.requireTreasuryId(treasuryVaultId),
      coinType ?? this.h.deps.ids.credCoinType,
    )
  }

  /** One item's treasury balance, or 0n. */
  async itemBalance(params: {
    collectionId: string
    assetId: bigint
    treasuryVaultId?: string
  }): Promise<bigint> {
    return fetchTreasuryItemBalance(
      this.h.deps.suiClient,
      this.h.requireTreasuryId(params.treasuryVaultId),
      params,
    )
  }

  /**
   * Fund the treasury from the caller's wallet.
   *
   * PERMISSIONLESS — no seat, no vote, no `RunOutcome`. Anyone can pay an
   * organization, so this returns a plain `TxResult`. It is also the one
   * treasury method that works when you hold no board seat at all.
   */
  async deposit(params: {
    amount: bigint
    coinType?: string
    treasuryVaultId?: string
  }): Promise<TxResult> {
    if (params.amount <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Deposit amount must be positive.',
      )
    }
    // Deliberately not `requireTreasuryId()`: depositing needs no seat, so fall
    // back to the ROOT treasury rather than demanding one.
    const treasuryVaultId =
      params.treasuryVaultId ??
      this.h.seat?.treasuryId ??
      this.h.nodes[0]?.treasuryId
    if (!treasuryVaultId) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Organization ${this.h.orgId} has no TreasuryVault to deposit into.`,
      )
    }
    return this.h.submit(
      depositToTreasuryTx({
        armature: this.h.deps.ids.armature,
        treasuryVaultId,
        coinType: params.coinType ?? this.h.deps.ids.credCoinType,
        amount: params.amount,
      }),
    )
  }

  /**
   * Pay out of the treasury to a wallet address.
   *
   * Governance-sensitive, so on a real board this resolves to a proposal rather
   * than a single vote — check `RunOutcome.status`. Requires
   * `types.enableSendCoin(coinType)` first.
   */
  async send(params: {
    recipient: string
    amount: bigint
    coinType?: string
    treasuryVaultId?: string
  }): Promise<RunOutcome> {
    return this.h.governance.run(
      sendCoinAction(this.h.pkgs(), {
        coinType: params.coinType ?? this.h.deps.ids.credCoinType,
        recipient: params.recipient,
        amount: params.amount,
        treasuryVaultId: this.h.requireTreasuryId(params.treasuryVaultId),
      }),
    )
  }

  /**
   * Move funds into ANOTHER organization's treasury.
   *
   * `recipientTreasuryId` is that organization's `TreasuryVault` object id —
   * its `treasuryId`, not its `orgId` and not a wallet. Requires
   * `SendCoinToDAO<Coin>` enabled on this unit.
   */
  async sendToOrg(params: {
    recipientTreasuryId: string
    amount: bigint
    coinType?: string
    treasuryVaultId?: string
  }): Promise<RunOutcome> {
    return this.h.governance.run(
      sendCoinToDaoAction(this.h.pkgs(), {
        coinType: params.coinType ?? this.h.deps.ids.credCoinType,
        recipientTreasuryId: params.recipientTreasuryId,
        amount: params.amount,
        treasuryVaultId: this.h.requireTreasuryId(params.treasuryVaultId),
      }),
    )
  }
}

// ─── trading as the organization ─────────────────────────────────────────────

/** An item stack `sweepAll` could not park, and why. */
export interface OrgSweepSkip {
  storageUnitId: string
  assetId: bigint
  amount: bigint
  reason: 'no-vault'
}

/** A limit order placed on behalf of the organization. */
export interface OrgLimitOrderParams extends OrderFlags {
  storageUnitId: string
  assetId: string
  side: OrderSide
  price: bigint
  quantity: bigint
  /** Epoch ms; defaults to good-til-cancelled. */
  expireAt?: bigint
  quoteType?: string
}

class OrgOrdersApi {
  constructor(private readonly h: OrgHandle) {}

  /** Give the organization a shared trading account (`TradingAccount`). */
  async ensureAccount(): Promise<RunOutcome> {
    const existing = this.h.nodes.find((n) => n.tradingAccountId)
    if (existing) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Organization ${this.h.orgId} already has a trading account on unit ${existing.daoId}.`,
      )
    }
    const seat = this.h.requireSeat()
    if (!seat.capabilityVaultId) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Unit ${seat.daoId} has no CapabilityVault to hold the trading capability.`,
      )
    }
    return this.h.governance.run(
      setupTradingAccountAction(
        { armatureTrading: this.h.deps.ids.armatureTrading },
        seat.capabilityVaultId,
      ),
    )
  }

  /** @internal — hub vault → collection → pool, the same chain personal orders use. */
  private async resolvePool(
    storageUnitId: string,
    assetId: string,
    quoteType?: string,
  ): Promise<{ poolId: string; collectionId: string }> {
    const vault = await this.h.deps.indexer.hubVault(storageUnitId)
    const poolId = await this.h.deps.indexer.resolvePool({
      collectionId: vault.collectionId,
      assetId,
      quoteType,
    })
    if (!poolId) {
      throw new TriexClientError(
        TriexError.PoolNotFound,
        `No market for item ${assetId} at hub ${storageUnitId}.`,
      )
    }
    return { poolId, collectionId: vault.collectionId }
  }

  /**
   * Place a limit order using funds ALREADY in the organization's balance
   * manager. To fund it from the treasury or from shared storage in the same
   * transaction, use {@link buyFromTreasury} / {@link sellFromDaoVault}.
   */
  async limit(params: OrgLimitOrderParams): Promise<RunOutcome> {
    requirePositive(params)
    const quoteType = params.quoteType ?? this.h.deps.ids.credCoinType
    const { poolId } = await this.resolvePool(
      params.storageUnitId,
      params.assetId,
      params.quoteType,
    )
    return this.h.governance.run(
      placeLimitOrderAction(this.h.tradingContext(), {
        quoteType,
        poolId,
        price: params.price,
        quantity: params.quantity,
        isBid: params.side === 'buy',
        expireTimestamp: params.expireAt ?? GTC_EXPIRE,
        orderType: params.orderType,
        selfMatchingOption: params.selfMatchingOption,
      }),
    )
  }

  /** Cancel one of the organization's resting orders. */
  async cancel(params: {
    storageUnitId: string
    assetId: string
    orderId: bigint
    quoteType?: string
  }): Promise<RunOutcome> {
    const { poolId } = await this.resolvePool(
      params.storageUnitId,
      params.assetId,
      params.quoteType,
    )
    return this.h.governance.run(
      cancelOrderAction(this.h.tradingContext(), {
        quoteType: params.quoteType ?? this.h.deps.ids.credCoinType,
        poolId,
        orderId: params.orderId,
      }),
    )
  }

  /**
   * Fund a bid from the treasury and place it, ATOMICALLY.
   *
   * `depositAmount` defaults to the full cost of the order including fees, not
   * to a shortfall — the trading account's current balance is not read, so pass
   * the deficit yourself when it already holds some quote. Over-depositing is
   * safe (the funds stay in the trading account, usable by the next order);
   * under-depositing aborts the whole transaction, deposit included.
   */
  async buyFromTreasury(
    params: OrgLimitOrderParams & {
      depositAmount?: bigint
      treasuryVaultId?: string
    },
  ): Promise<RunOutcome> {
    requirePositive(params)
    const quoteType = params.quoteType ?? this.h.deps.ids.credCoinType
    const { poolId } = await this.resolvePool(
      params.storageUnitId,
      params.assetId,
      params.quoteType,
    )
    let depositAmount = params.depositAmount
    if (depositAmount === undefined) {
      const meta = await this.h.deps.indexer.poolMetadata(poolId)
      depositAmount = computeBidQuoteDeposit(
        params.price,
        params.quantity,
        meta.feeRateScaled,
      )
    }
    const ctx = this.h.tradingContext()
    return this.runAtomic([
      depositCoinToBookAction(ctx, {
        quoteType,
        amount: depositAmount,
        treasuryVaultId: this.h.requireTreasuryId(params.treasuryVaultId),
      }),
      placeLimitOrderAction(ctx, {
        quoteType,
        poolId,
        price: params.price,
        quantity: params.quantity,
        isBid: true,
        expireTimestamp: params.expireAt ?? GTC_EXPIRE,
        orderType: params.orderType,
        selfMatchingOption: params.selfMatchingOption,
      }),
    ])
  }

  /**
   * Unpark items from shared storage and sell them, ATOMICALLY.
   *
   * `vaultQuantity` is how much to pull from the vault, which is not always the
   * order quantity — the trading account may already hold part of the stack.
   * It defaults to the full quantity.
   *
   * The vault is resolved from the storage unit and this organization; pass
   * `daoVaultId` to skip the lookup.
   */
  async sellFromDaoVault(
    params: OrgLimitOrderParams & {
      daoVaultId?: string
      vaultQuantity?: bigint
      registrantOrgId?: string
    },
  ): Promise<RunOutcome> {
    requirePositive(params)
    const quoteType = params.quoteType ?? this.h.deps.ids.credCoinType
    const { poolId } = await this.resolvePool(
      params.storageUnitId,
      params.assetId,
      params.quoteType,
    )
    const daoVaultId = await requireVaultId(this.h, params)
    const ctx = this.h.tradingContext()
    return this.runAtomic([
      depositFromDaoVaultToBookAction(ctx, {
        daoVaultId,
        assetId: BigInt(params.assetId),
        amount: params.vaultQuantity ?? params.quantity,
      }),
      placeLimitOrderAction(ctx, {
        quoteType,
        poolId,
        price: params.price,
        quantity: params.quantity,
        isBid: false,
        expireTimestamp: params.expireAt ?? GTC_EXPIRE,
        orderType: params.orderType,
        selfMatchingOption: params.selfMatchingOption,
      }),
    ])
  }

  /**
   * Sweep quote coin out of the trading account and back into the treasury.
   *
   * `claimFromPool` first claims that pool's settled balances into the balance
   * manager, in the same transaction — a resting maker order that filled leaves
   * its proceeds IN the pool, so sweeping without claiming quietly moves less
   * than the caller expects.
   */
  async sweepCoin(params: {
    amount: bigint
    quoteType?: string
    treasuryVaultId?: string
    claimFromPool?: string
  }): Promise<RunOutcome> {
    const quoteType = params.quoteType ?? this.h.deps.ids.credCoinType
    const ctx = this.h.tradingContext()
    const action = sweepCoinToTreasuryAction(ctx, {
      quoteType,
      amount: params.amount,
      treasuryVaultId: this.h.requireTreasuryId(params.treasuryVaultId),
    })
    return this.runAtomic([action], (tx) => {
      if (params.claimFromPool) {
        appendClaimSettled(tx, {
          triex: this.h.deps.ids.triex,
          quoteType,
          poolId: params.claimFromPool,
          tradingAccountId: ctx.tradingAccountId,
        })
      }
    })
  }

  /**
   * Park items from the trading account into shared storage.
   *
   * As with {@link sweepCoin}, `claimFromPool` claims settled balances first so
   * `amount` may include them.
   */
  async sweepItems(params: {
    storageUnitId: string
    assetId: bigint
    amount: bigint
    daoVaultId?: string
    collectionId?: string
    registrantOrgId?: string
    claimFromPool?: string
    quoteType?: string
  }): Promise<RunOutcome> {
    const daoVaultId = await requireVaultId(this.h, params)
    const collectionId =
      params.collectionId ??
      (await this.h.deps.indexer.hubVault(params.storageUnitId)).collectionId
    const ctx = this.h.tradingContext()
    const action = sweepMulticoinToDaoVaultAction(ctx, {
      daoVaultId,
      collectionId,
      assetId: params.assetId,
      amount: params.amount,
    })
    return this.runAtomic([action], (tx) => {
      if (params.claimFromPool) {
        appendClaimSettled(tx, {
          triex: this.h.deps.ids.triex,
          quoteType: params.quoteType ?? this.h.deps.ids.credCoinType,
          poolId: params.claimFromPool,
          tradingAccountId: ctx.tradingAccountId,
        })
      }
    })
  }

  /**
   * Park everything the organization is idly holding, in ONE signature: claim
   * each pool's settled proceeds into the trading account, move every item
   * stack into its shared storage, and send the aggregate quote coin to the
   * treasury.
   *
   * Item stacks whose vault does not resolve are REPORTED, not silently
   * dropped — `skipped` names them. A sweep that quietly moved nine of ten
   * stacks and reported success would be worse than one that moved none.
   *
   * The manifest comes from the indexer and lags chain head by seconds, so a
   * very recent fill may not be included; run it again rather than widening the
   * amounts by hand.
   */
  async sweepAll(params?: {
    quoteType?: string
    treasuryVaultId?: string
    /** Skip the CRED leg (e.g. to park items only). */
    includeCurrency?: boolean
  }): Promise<RunOutcome & { skipped: OrgSweepSkip[] }> {
    const quoteType = params?.quoteType ?? this.h.deps.ids.credCoinType
    const ctx = this.h.tradingContext()
    const manifest = await this.h.deps.indexer.sweepable(ctx.tradingAccountId)

    const claimPools = manifest.pools
      .filter(
        (p) =>
          p.settled.base > 0n || p.settled.quote > 0n || p.settled.cred > 0n,
      )
      .map((p) => ({
        poolId: p.poolId,
        quoteType: p.quoteAssetId ?? quoteType,
      }))

    const skipped: OrgSweepSkip[] = []
    const actions: OuProposalAction[] = []

    for (const item of manifest.items) {
      const daoVaultId = await this.h.vault.resolve({
        storageUnitId: item.storageUnitId,
      })
      if (!daoVaultId) {
        skipped.push({
          storageUnitId: item.storageUnitId,
          assetId: BigInt(item.assetId),
          amount: item.amount,
          reason: 'no-vault',
        })
        continue
      }
      actions.push(
        sweepMulticoinToDaoVaultAction(ctx, {
          daoVaultId,
          collectionId: item.collectionId,
          assetId: BigInt(item.assetId),
          amount: item.amount,
        }),
      )
    }

    // The manifest carries no top-level currency figure, so the CRED leg is the
    // trading account's LIVE holding plus whatever the claims above are about to
    // add — the claims run first in this same PTB, so a pre-claim read alone
    // would leave the just-claimed proceeds behind.
    const liveCred = await getTradingAccountCurrencyBalance(
      this.h.deps.suiClient,
      this.h.deps.ids,
      ctx.tradingAccountId,
    )
    const claimedCred = manifest.pools.reduce(
      (sum, p) => sum + p.settled.cred + p.settled.quote,
      0n,
    )
    const credAmount = liveCred + claimedCred
    if (params?.includeCurrency !== false && credAmount > 0n) {
      actions.push(
        sweepCoinToTreasuryAction(ctx, {
          quoteType,
          amount: credAmount,
          treasuryVaultId: this.h.requireTreasuryId(params?.treasuryVaultId),
        }),
      )
    }

    if (actions.length === 0) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        skipped.length > 0
          ? `Nothing could be swept: ${skipped.length} item stack(s) have no shared storage registered by this organization.`
          : 'Nothing to sweep — the trading account is idle.',
      )
    }

    const outcome = await this.runAtomic(actions, (tx) => {
      for (const pool of claimPools) {
        appendClaimSettled(tx, {
          triex: this.h.deps.ids.triex,
          quoteType: pool.quoteType,
          poolId: pool.poolId,
          tradingAccountId: ctx.tradingAccountId,
        })
      }
    })
    return { ...outcome, skipped }
  }

  /**
   * @internal — run several trading actions in ONE transaction.
   *
   * Trading actions are `single-vote-only`, so a resolved plan is always
   * immediate; if it is not, the resolver blocks and that blocked result is
   * what the caller sees. This never silently degrades a two-step funded order
   * into two independent proposals, which is the failure the policy exists to
   * prevent.
   */
  private async runAtomic(
    actions: OuProposalAction[],
    prelude?: (tx: Transaction) => void,
  ): Promise<RunOutcome> {
    const plan = await this.h.governance.resolve(actions[0])
    if (plan.blocked) {
      return { status: 'blocked', code: plan.code, reason: plan.reason }
    }
    // Build in order: the prelude's commands (e.g. claim settled) must land
    // BEFORE the governance ones that consume what they produce.
    const tx = new SuiTransaction()
    prelude?.(tx)
    appendPlanActions(
      tx,
      plan.strategy,
      actions,
      this.h.requireContext(),
      this.h.deps.ids.armature,
    )
    const res = await executeAndNormalize(this.h.deps.requireExecutor(), tx)
    return { status: 'executed', digest: res.digest }
  }
}

/** @internal */
function requirePositive(p: { price: bigint; quantity: bigint }): void {
  if (p.price <= 0n || p.quantity <= 0n) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      'Limit orders need a positive price and quantity.',
    )
  }
}

/**
 * @internal — resolve a vault or fail with a message naming both key halves.
 *
 * Deliberately a free function, not a method on `OrgVaultApi`: the parity gate
 * reads the declared surface, and a `@internal` doc tag on a public method is
 * invisible to it.
 */
async function requireVaultId(
  h: OrgHandle,
  params: {
    storageUnitId: string
    registrantOrgId?: string
    daoVaultId?: string
  },
): Promise<string> {
  if (params.daoVaultId) return params.daoVaultId
  const id = await h.vault.resolve(params)
  if (!id) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      `No shared storage registered by organization ${h.orgId} at storage unit ${params.storageUnitId}. ` +
        'Vaults are keyed by (storage unit, organization) — another org may have one here, but it is not yours.',
    )
  }
  return id
}

// ─── shared storage ──────────────────────────────────────────────────────────

class OrgVaultApi {
  constructor(private readonly h: OrgHandle) {}

  /** Active vaults registered at a hub, with their ACLs (indexer, 30s cache). */
  atHub(hubId: string): Promise<HubDaoVault[]> {
    return this.h.deps.indexer.orgs.vaultsAtHub(hubId)
  }

  /**
   * The vault THIS organization registered at a storage unit, or null.
   *
   * Defaults the registrant to the acting seat, then walks outward to the other
   * units of the tree — an organization commonly registers its vault on the
   * officers unit while an admin is acting from the root, and failing there
   * would be an answer about the seat rather than about the organization. Pass
   * `registrantOrgId` to pin it.
   */
  async resolve(params: {
    storageUnitId: string
    registrantOrgId?: string
  }): Promise<string | null> {
    const candidates = params.registrantOrgId
      ? [params.registrantOrgId]
      : [
          ...(this.h.seat ? [this.h.seat.daoId] : []),
          ...this.h.nodes.map((n) => n.daoId),
        ]
    const seen = new Set<string>()
    for (const registrantOrgId of candidates) {
      if (seen.has(registrantOrgId)) continue
      seen.add(registrantOrgId)
      const id = await resolveDaoVaultId(
        this.h.deps.suiClient,
        this.h.deps.ids,
        {
          storageUnitId: params.storageUnitId,
          registrantOrgId,
        },
      )
      if (id) return id
    }
    return null
  }

  /** A vault's live identity, ACL, and non-empty asset count. */
  info(vaultId: string): Promise<DaoVaultInfo | null> {
    return fetchDaoVaultInfo(this.h.deps.suiClient, vaultId)
  }

  /** One asset's balance in a vault, or 0n. */
  balance(vaultId: string, assetId: bigint): Promise<bigint> {
    return fetchVaultBalance(this.h.deps.suiClient, vaultId, assetId)
  }

  /**
   * Register shared storage for the acting unit at a storage unit.
   *
   * Defaults mirror the app's tiering: deposit and withdraw go to the acting
   * unit, and EDIT goes to its PARENT — a unit that governs its own access
   * control can quietly widen it, so the tier above holds the key. On a root
   * unit (no parent) edit falls back to itself, which is the only option.
   *
   * At least one editor must be an `ou`; an all-`player` edit set is rejected
   * on-chain because a vault whose only editors were bare keys could be bricked
   * beyond recovery.
   */
  async init(params: {
    storageUnitId: string
    vaultConfigId?: string
    depositPrincipals?: VaultPrincipal[]
    withdrawPrincipals?: VaultPrincipal[]
    editPrincipals?: VaultPrincipal[]
  }): Promise<TxResult> {
    const seat = this.h.requireSeat()
    const ctx = this.h.requireContext()
    const editorDaoId = ctx.parent?.daoId ?? seat.daoId

    let vaultConfigId = params.vaultConfigId
    if (!vaultConfigId) {
      const hub = await this.h.deps.indexer.hubVault(params.storageUnitId)
      vaultConfigId = hub.vaultConfigId
    }

    const tx = new SuiTransaction()
    initializeDaoVaultTx(tx, {
      armatureVault: this.h.deps.ids.armatureVault,
      registryId: this.h.deps.ids.ouReceiptVaultRegistry,
      storageUnitId: params.storageUnitId,
      registrantOrgId: seat.daoId,
      vaultConfigId,
      depositPrincipals: params.depositPrincipals ?? [
        { kind: 'ou', value: seat.daoId },
      ],
      withdrawPrincipals: params.withdrawPrincipals ?? [
        { kind: 'ou', value: seat.daoId },
      ],
      editPrincipals: params.editPrincipals ?? [
        { kind: 'ou', value: editorDaoId },
      ],
    })
    return this.h.submit(tx)
  }

  /**
   * Move items from the caller's WALLET receipts into shared storage.
   *
   * Not governance — the vault's `deposit` role is checked directly against the
   * caller, so this returns a plain `TxResult`. To move items out of the
   * organization's BALANCE MANAGER instead, use `orders.sweepItems()`.
   */
  async deposit(params: {
    storageUnitId: string
    items: { assetId: bigint; amount: bigint }[]
    registrantOrgId?: string
    daoVaultId?: string
  }): Promise<TxResult> {
    const seat = this.h.requireSeat()
    const vaultId = await requireVaultId(this.h, params)
    const info = await this.info(vaultId)
    if (!info) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Vault ${vaultId} could not be read.`,
      )
    }

    const tx = new SuiTransaction()
    for (const item of params.items) {
      const balance = await sourceWalletReceipts(
        this.h.deps.suiClient,
        tx,
        this.h.deps.ids,
        {
          owner: this.h.deps.address,
          assetId: item.assetId,
          amount: item.amount,
          collectionId: info.collectionId,
        },
      )
      depositReceiptTx(tx, {
        armatureVault: this.h.deps.ids.armatureVault,
        vaultId,
        daoId: seat.daoId,
        balance,
      })
    }
    return this.h.submit(tx)
  }

  /**
   * Take items out of shared storage.
   *
   * `to: 'wallet'` (the default) transfers the receipt objects to the caller.
   * `to: 'hangar'` redeems them into the storage unit's inventory instead,
   * which needs a character — the same redeem the personal `withdrawItems`
   * does.
   */
  async withdraw(params: {
    storageUnitId: string
    items: { assetId: bigint; amount: bigint }[]
    to?: 'wallet' | 'hangar'
    characterId?: string
    registrantOrgId?: string
    daoVaultId?: string
  }): Promise<TxResult> {
    const seat = this.h.requireSeat()
    const vaultId = await requireVaultId(this.h, params)
    const destination = params.to ?? 'wallet'

    let hangar:
      | {
          characterId: string
          vaultConfigId: string
          collectionId: string
          isOwner: boolean
        }
      | undefined
    if (destination === 'hangar') {
      const characterId = params.characterId
      if (!characterId) {
        throw new TriexClientError(
          TriexError.CharacterNotFound,
          'Redeeming into the hangar needs a character — pass `characterId`.',
        )
      }
      const hub = await this.h.deps.indexer.hubVault(params.storageUnitId)
      hangar = {
        characterId,
        vaultConfigId: hub.vaultConfigId,
        collectionId: hub.collectionId,
        isOwner: false,
      }
    }

    const tx = new SuiTransaction()
    for (const item of params.items) {
      const balance = withdrawReceiptTx(tx, {
        armatureVault: this.h.deps.ids.armatureVault,
        vaultId,
        daoId: seat.daoId,
        assetId: item.assetId,
        amount: item.amount,
      })
      if (hangar) {
        tx.moveCall({
          target: `${this.h.deps.ids.warehouseReceipts}::receipt::redeem_receipt`,
          arguments: [
            balance,
            tx.object(toStorageUnitId(params.storageUnitId)),
            tx.object(hangar.characterId),
            tx.object(hangar.vaultConfigId),
            tx.object(hangar.collectionId),
            tx.pure.bool(hangar.isOwner),
          ],
        })
      } else {
        tx.transferObjects([balance], this.h.deps.address)
      }
    }
    return this.h.submit(tx)
  }

  /**
   * Grant access to a vault. Requires the caller to satisfy the `edit` role
   * through `editorDaoId` (defaults to the acting seat).
   *
   * An `ou` granted the `edit` role goes through `grant_edit_ou`, which demands
   * a live DAO witness — that is the only path the chain allows, precisely so a
   * mistyped org id cannot become an unsatisfiable editor.
   */
  async grant(params: {
    vaultId: string
    grants: { role: VaultRole; principal: VaultPrincipal }[]
    editorDaoId?: string
  }): Promise<TxResult> {
    const editorDaoId = params.editorDaoId ?? this.h.requireSeat().daoId
    const armatureVault = this.h.deps.ids.armatureVault
    const tx = new SuiTransaction()

    const editOus = params.grants.filter(
      (g) => g.role === 'edit' && g.principal.kind === 'ou',
    )
    const rest = params.grants.filter(
      (g) => !(g.role === 'edit' && g.principal.kind === 'ou'),
    )
    for (const g of editOus) {
      grantEditOuTx(tx, {
        armatureVault,
        vaultId: params.vaultId,
        editorDaoId,
        targetDaoId: g.principal.value,
      })
    }
    if (rest.length > 0) {
      grantTx(tx, {
        armatureVault,
        vaultId: params.vaultId,
        editorDaoId,
        grants: rest,
      })
    }
    if (params.grants.length === 0) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'grant needs at least one (role, principal) pair.',
      )
    }
    return this.h.submit(tx)
  }

  /**
   * Revoke access. A batch that removes nothing aborts on-chain rather than
   * succeeding quietly — usually a kind mismatch, since `player(A)` and
   * `machine(A)` are distinct principals for the same address.
   */
  async revoke(params: {
    vaultId: string
    revocations: { role: VaultRole; principal: VaultPrincipal }[]
    editorDaoId?: string
  }): Promise<TxResult> {
    if (params.revocations.length === 0) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'revoke needs at least one (role, principal) pair.',
      )
    }
    const tx = new SuiTransaction()
    revokeTx(tx, {
      armatureVault: this.h.deps.ids.armatureVault,
      vaultId: params.vaultId,
      editorDaoId: params.editorDaoId ?? this.h.requireSeat().daoId,
      revocations: params.revocations,
    })
    return this.h.submit(tx)
  }

  /** Retire an EMPTY vault and free its registry slot. */
  async deinit(params: {
    vaultId: string
    editorDaoId?: string
  }): Promise<TxResult> {
    const tx = new SuiTransaction()
    deinitializeDaoVaultTx(tx, {
      armatureVault: this.h.deps.ids.armatureVault,
      registryId: this.h.deps.ids.ouReceiptVaultRegistry,
      vaultId: params.vaultId,
      editorDaoId: params.editorDaoId ?? this.h.requireSeat().daoId,
    })
    return this.h.submit(tx)
  }
}

import type { Transaction } from '@mysten/sui/transactions'

import { CLOCK_ID } from '../config'
import type { OuProposalAction } from './harness'
import type { CompositeStep } from './plan'
import {
  newConfig,
  withComposableAllowed,
  type ProposalConfigInput,
} from './transactions'

/**
 * The governance action catalog (DESIGN-ARMATURE.md §13.2).
 *
 * Each factory produces an `OuProposalAction` the resolver can carry by ANY
 * strategy — single-vote-execute, control, or a deferred proposal. Callers
 * build one of these and hand it to `org.governance.run()`; nothing here
 * decides how it will be passed.
 *
 * An action carries up to two adapters. `own` submits on the unit itself;
 * `control` is the `Control*` form a parent uses through its `SubDAOControl`
 * cap. Which ones exist is a fact about what is wired on-chain, not a
 * preference — sub-DAOs are deny-by-default for board changes, so member ops
 * usually travel the control path.
 */

/** The two Armature package ids every action needs. */
export interface ArmaturePkgs {
  armature: string
  armatureProposals: string
}

// ─── Config presets ─────────────────────────────────────────────────────────

/**
 * Operational types an officer should be able to act on alone: quorum 1 means
 * a single vote always clears, so trading stays one transaction. 1h expiry.
 */
export const TRADING_TYPE_CONFIG: ProposalConfigInput = {
  quorum: 1,
  approvalThreshold: 5000,
  proposeThreshold: 0,
  expiryMs: 3_600_000,
  executionDelayMs: 0,
  cooldownMs: 0,
}

/**
 * Governance-sensitive types (treasury withdrawal, and anything that changes
 * who can do what): a real board vote. 7d expiry.
 *
 * Quorum and approval are BOTH 5000 on purpose. A token quorum would let one
 * member pass a proposal by voting alone, which makes the approval threshold
 * decorative — the pair has to move together to mean anything.
 */
export const GOVERNANCE_TYPE_CONFIG: ProposalConfigInput = {
  quorum: 5000,
  approvalThreshold: 5000,
  proposeThreshold: 0,
  expiryMs: 604_800_000,
  executionDelayMs: 0,
  cooldownMs: 0,
}

/**
 * The `Composite` type's own config. The 80% approval threshold guarantees the
 * on-chain `SELF_UPDATE_APPROVAL_FLOOR` is met at submission regardless of the
 * step configs: a composite's effective config is the component-wise max of
 * this base and every step it contains, and any composite carrying an
 * `UpdateProposalConfig` step needs ≥80%.
 */
export const COMPOSITE_TYPE_CONFIG: ProposalConfigInput = {
  quorum: 5000,
  approvalThreshold: 8000,
  proposeThreshold: 0,
  expiryMs: 604_800_000,
  executionDelayMs: 0,
  cooldownMs: 0,
}

// ─── Per-coin type keys ─────────────────────────────────────────────────────

/**
 * The proposal type key for withdrawing one coin from the treasury.
 *
 * Per-coin by necessity, not by taste: a DAO binds exactly ONE Move type per
 * `type_key` (`execute_enable_proposal_type<SendCoin<T>>`), so a shared
 * `SendCoin` key could only ever name a single coin. A per-coin key lets every
 * coin be enabled independently.
 */
export function sendCoinTypeKey(coinType: string): string {
  return `SendCoin<${coinType}>`
}

/** As {@link sendCoinTypeKey}, for a cross-organization treasury send. */
export function sendCoinToDaoTypeKey(coinType: string): string {
  return `SendCoinToDAO<${coinType}>`
}

/**
 * Every `armature_trading` proposal type, as `{ typeKey, moveType }` pairs.
 *
 * `baseType` additionally yields the COIN-POOL order types. Passing it binds
 * those keys to that one base coin, permanently — see `enableTradingActions`.
 */
export function tradingTypeEntries(
  tradingPkg: string,
  quoteType: string,
  baseType?: string,
): { typeKey: string; moveType: string }[] {
  const coinEntries = baseType
    ? [
        {
          typeKey: `${tradingPkg}::place_limit_order_coin::PlaceLimitOrderCoin`,
          moveType: `${tradingPkg}::place_limit_order_coin::PlaceLimitOrderCoin<${baseType}, ${quoteType}>`,
        },
        {
          typeKey: `${tradingPkg}::cancel_order_coin::CancelOrderCoin`,
          moveType: `${tradingPkg}::cancel_order_coin::CancelOrderCoin<${baseType}, ${quoteType}>`,
        },
      ]
    : []
  return [
    ...coinEntries,
    // Generic types, bound to the quote coin (CRED).
    {
      typeKey: `${tradingPkg}::place_limit_order::PlaceLimitOrder`,
      moveType: `${tradingPkg}::place_limit_order::PlaceLimitOrder<${quoteType}>`,
    },
    {
      typeKey: `${tradingPkg}::cancel_order::CancelOrder`,
      moveType: `${tradingPkg}::cancel_order::CancelOrder<${quoteType}>`,
    },
    {
      typeKey: `${tradingPkg}::deposit_coin_to_book::DepositCoinToBook`,
      moveType: `${tradingPkg}::deposit_coin_to_book::DepositCoinToBook<${quoteType}>`,
    },
    {
      typeKey: `${tradingPkg}::sweep_coin_to_treasury::SweepCoinToTreasury`,
      moveType: `${tradingPkg}::sweep_coin_to_treasury::SweepCoinToTreasury<${quoteType}>`,
    },
    // Non-generic types.
    {
      typeKey: `${tradingPkg}::setup_trading_account::SetupTradingAccount`,
      moveType: `${tradingPkg}::setup_trading_account::SetupTradingAccount`,
    },
    {
      typeKey: `${tradingPkg}::deposit_multicoin_to_book::DepositMulticoinToBook`,
      moveType: `${tradingPkg}::deposit_multicoin_to_book::DepositMulticoinToBook`,
    },
    {
      typeKey: `${tradingPkg}::deposit_from_dao_vault_to_book::DepositFromDaoVaultToBook`,
      moveType: `${tradingPkg}::deposit_from_dao_vault_to_book::DepositFromDaoVaultToBook`,
    },
    {
      typeKey: `${tradingPkg}::sweep_multicoin_to_treasury::SweepMulticoinToTreasury`,
      moveType: `${tradingPkg}::sweep_multicoin_to_treasury::SweepMulticoinToTreasury`,
    },
    {
      typeKey: `${tradingPkg}::sweep_multicoin_to_dao_vault::SweepMulticoinToDaoVault`,
      moveType: `${tradingPkg}::sweep_multicoin_to_dao_vault::SweepMulticoinToDaoVault`,
    },
  ]
}

// ─── Enable a proposal type ─────────────────────────────────────────────────

/**
 * Enable a proposal type on a unit.
 *
 * The proposal submitted is always `EnableProposalType`; its payload names the
 * target key + config, and the single-vote path binds the concrete Move type
 * via `execute_enable_proposal_type<NewType>`. That indirection is why one
 * factory covers trading, treasury, and composite alike.
 */
export function enableProposalTypeAction(
  pkgs: ArmaturePkgs,
  opts: {
    kind: string
    enabledTypeKey: string
    enabledMoveType: string
    config: ProposalConfigInput
    composableAllowed?: boolean
    fallbackPolicy?: OuProposalAction['fallbackPolicy']
  },
): OuProposalAction {
  const { armature, armatureProposals } = pkgs
  return {
    kind: opts.kind,
    own: {
      typeKey: 'EnableProposalType',
      payloadMoveType: `${armatureProposals}::enable_proposal_type::EnableProposalType`,
      buildPayload: (tx) => {
        let config = newConfig(tx, armature, opts.config)
        if (opts.composableAllowed) {
          config = withComposableAllowed(tx, armature, config, true)
        }
        return tx.moveCall({
          target: `${armatureProposals}::enable_proposal_type::new`,
          arguments: [tx.pure.string(opts.enabledTypeKey), config],
        })
      },
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::admin_ops::execute_enable_proposal_type`,
          typeArguments: [opts.enabledMoveType],
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    fallbackPolicy: opts.fallbackPolicy ?? 'fall-back-to-proposal',
  }
}

/** Enable treasury withdrawals of one coin — registers `SendCoin<Coin>`. */
export function enableSendCoinAction(
  pkgs: ArmaturePkgs,
  coinType: string,
): OuProposalAction {
  return enableProposalTypeAction(pkgs, {
    kind: 'enable_treasury_withdraw',
    enabledTypeKey: sendCoinTypeKey(coinType),
    enabledMoveType: `${pkgs.armatureProposals}::send_coin::SendCoin<${coinType}>`,
    config: GOVERNANCE_TYPE_CONFIG,
  })
}

/** Enable cross-organization treasury sends of one coin. */
export function enableSendCoinToDaoAction(
  pkgs: ArmaturePkgs,
  coinType: string,
): OuProposalAction {
  return enableProposalTypeAction(pkgs, {
    kind: 'enable_treasury_send_to_dao',
    enabledTypeKey: sendCoinToDaoTypeKey(coinType),
    enabledMoveType: `${pkgs.armatureProposals}::send_coin_to_dao::SendCoinToDAO<${coinType}>`,
    config: GOVERNANCE_TYPE_CONFIG,
  })
}

/** Enable the `Composite` type, so carts can bundle into one proposal. */
export function enableCompositeAction(pkgs: ArmaturePkgs): OuProposalAction {
  return enableProposalTypeAction(pkgs, {
    kind: 'enable_composite',
    enabledTypeKey: 'Composite',
    enabledMoveType: `${pkgs.armature}::composite::CompositePayload`,
    config: COMPOSITE_TYPE_CONFIG,
  })
}

/**
 * Enable the `armature_trading` proposal types not already on the unit — one
 * action per type, meant for `runBatch()`.
 *
 * `baseType` is IRREVERSIBLE. Passing it enables the coin-pool order types
 * bound to that one base coin, and the binding cannot be changed on-chain: the
 * unit can then trade only that base through governance. Organizations created
 * by `create_tribe_configured` already have the unbound keys registered and
 * trade any base freely, so leave it undefined for them. It exists for units
 * created before those keys were registered.
 */
export function enableTradingActions(
  pkgs: ArmaturePkgs,
  opts: {
    armatureTrading: string
    quoteType: string
    alreadyEnabled?: Set<string>
    /** IRREVERSIBLE — binds the coin-order keys to this one base coin. */
    bindToBaseType?: string
  },
): OuProposalAction[] {
  const already = opts.alreadyEnabled ?? new Set<string>()
  return tradingTypeEntries(
    opts.armatureTrading,
    opts.quoteType,
    opts.bindToBaseType,
  )
    .filter((e) => !already.has(e.typeKey))
    .map((e) =>
      enableProposalTypeAction(pkgs, {
        kind: 'enable_trading',
        enabledTypeKey: e.typeKey,
        enabledMoveType: e.moveType,
        config: TRADING_TYPE_CONFIG,
      }),
    )
}

// ─── Change the rules of an enabled type ────────────────────────────────────

/** Fields of a `ProposalConfig` to change; omitted fields are left alone. */
export interface ProposalConfigPatch {
  quorum?: number
  approvalThreshold?: number
  proposeThreshold?: number
  expiryMs?: number
  executionDelayMs?: number
  cooldownMs?: number
  /**
   * Whether the type may be a step inside a `Composite`. Bootstrapping
   * composites means making `UpdateProposalConfig` itself composable first.
   */
  composableAllowed?: boolean
}

/**
 * Change the voting rules of an already-enabled type on a unit. Every field is
 * an `Option` on-chain, so anything omitted keeps its current value.
 *
 * Own-only: a config change is always applied on the DAO that owns the type, so
 * the caller must be on that board. There is no `Control*` form.
 */
export function updateProposalConfigAction(
  pkgs: ArmaturePkgs,
  targetTypeKey: string,
  patch: ProposalConfigPatch = {},
): OuProposalAction {
  const { armatureProposals } = pkgs
  return {
    kind: 'update_proposal_config',
    own: {
      typeKey: 'UpdateProposalConfig',
      payloadMoveType: `${armatureProposals}::update_proposal_config::UpdateProposalConfig`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armatureProposals}::update_proposal_config::new`,
          arguments: [
            tx.pure.string(targetTypeKey),
            tx.pure.option('u16', patch.quorum ?? null),
            tx.pure.option('u16', patch.approvalThreshold ?? null),
            tx.pure.option('u64', patch.proposeThreshold ?? null),
            tx.pure.option('u64', patch.expiryMs ?? null),
            tx.pure.option('u64', patch.executionDelayMs ?? null),
            tx.pure.option('u64', patch.cooldownMs ?? null),
            tx.pure.option('bool', patch.composableAllowed ?? null),
          ],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::admin_ops::execute_update_proposal_config`,
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

// ─── Membership ─────────────────────────────────────────────────────────────

/**
 * Add members to a unit. Carries both paths:
 *  - own `BatchAddMembers`, which sub-DAOs deny by default, so usually skipped;
 *  - control `ControllerBatchAddMembers`, where the parent seats them on this
 *    child through its `SubDAOControl` cap.
 *
 * The resolver picks: a root board adds directly (rare), officers and members
 * are seated by the tier above — one transaction when that board's single vote
 * clears, otherwise a proposal.
 */
export function addMembersAction(
  pkgs: ArmaturePkgs,
  addresses: string[],
): OuProposalAction {
  const { armatureProposals } = pkgs
  return {
    kind: 'add_members',
    own: {
      typeKey: 'BatchAddMembers',
      payloadMoveType: `${armatureProposals}::batch_add_members::BatchAddMembers`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armatureProposals}::batch_add_members::new`,
          arguments: [tx.pure.vector('address', addresses)],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::member_ops::execute_batch_add_members`,
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    control: {
      typeKey: 'ControllerBatchAddMembers',
      payloadMoveType: `${armatureProposals}::controller_batch_add_members::ControllerBatchAddMembers`,
      buildPayload: (tx, controlCapId) =>
        tx.moveCall({
          target: `${armatureProposals}::controller_batch_add_members::new`,
          arguments: [
            tx.pure.address(controlCapId),
            tx.pure.vector('address', addresses),
          ],
        }),
      buildExecute: (tx, ticket, capVaultId, childDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::subdao_ops::execute_controller_batch_add_members`,
          arguments: [
            tx.object(capVaultId),
            tx.object(childDaoId),
            ticket,
            tx.object(CLOCK_ID),
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Remove members from a sub-DAO. CONTROL-ONLY — the parent removes them via its
 * `SubDAOControl` cap, because no own-DAO batch-remove path is enabled on
 * sub-DAOs. On a root unit (no parent) this action has no viable path and the
 * resolver blocks it; use {@link setBoardAction} there.
 */
export function removeMembersAction(
  pkgs: ArmaturePkgs,
  addresses: string[],
): OuProposalAction {
  const { armatureProposals } = pkgs
  return {
    kind: 'remove_members',
    control: {
      typeKey: 'ControllerBatchRemoveMembers',
      payloadMoveType: `${armatureProposals}::controller_batch_remove_members::ControllerBatchRemoveMembers`,
      buildPayload: (tx, controlCapId) =>
        tx.moveCall({
          target: `${armatureProposals}::controller_batch_remove_members::new`,
          arguments: [
            tx.pure.address(controlCapId),
            tx.pure.vector('address', addresses),
          ],
        }),
      buildExecute: (tx, ticket, capVaultId, childDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::subdao_ops::execute_controller_batch_remove_members`,
          arguments: [
            tx.object(capVaultId),
            tx.object(childDaoId),
            ticket,
            tx.object(CLOCK_ID),
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Replace a unit's board wholesale. Own-only — a DAO governs its own board
 * directly via `SetBoard`. This is the removal path for a ROOT unit, which has
 * no parent to act through.
 */
export function setBoardAction(
  pkgs: ArmaturePkgs,
  newBoard: string[],
): OuProposalAction {
  const { armatureProposals } = pkgs
  return {
    kind: 'set_board',
    own: {
      typeKey: 'SetBoard',
      payloadMoveType: `${armatureProposals}::set_board::SetBoard`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armatureProposals}::set_board::new`,
          arguments: [tx.pure.vector('address', newBoard)],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::board_ops::execute_set_board`,
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

// ─── Metadata ───────────────────────────────────────────────────────────────

/**
 * Update a unit's charter metadata. Own-only, and note the `type_key` is
 * `CharterUpdate` while the payload type is `UpdateMetadata` — they genuinely
 * differ on-chain.
 *
 * `charterId` is the Charter object the execute step mutates; the execute call
 * targets the Charter, NOT the DAO, which is why this adapter ignores the
 * `ownDaoId` its signature receives.
 */
export function updateMetadataAction(
  pkgs: ArmaturePkgs,
  metadataUri: string,
  charterId: string,
): OuProposalAction {
  const { armatureProposals } = pkgs
  return {
    kind: 'update_org_metadata',
    own: {
      typeKey: 'CharterUpdate',
      payloadMoveType: `${armatureProposals}::update_metadata::UpdateMetadata`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armatureProposals}::update_metadata::new`,
          arguments: [tx.pure.string(metadataUri)],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${armatureProposals}::admin_ops::execute_update_metadata`,
          arguments: [tx.object(charterId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

// ─── Executing what a board already passed ──────────────────────────────────

/**
 * Reconstruct the action needed to EXECUTE a passed proposal from its
 * `type_key` and decoded payload, so the same `buildExecute` that would have
 * run on the single-vote path finishes a governance-passed one.
 *
 * Returns null for types with no own-adapter mapping — the caller should then
 * decline rather than guess at a handler.
 */
export function passedProposalAction(
  pkgs: ArmaturePkgs,
  args: {
    typeKey: string
    payload?: Record<string, unknown>
    charterId?: string
  },
): OuProposalAction | null {
  const { typeKey, payload = {}, charterId } = args

  if (typeKey === 'EnableProposalType') {
    const target = payload.type_key
    if (typeof target !== 'string') return null
    const toDao = /^SendCoinToDAO<(.+)>$/.exec(target)?.[1]
    if (toDao) return enableSendCoinToDaoAction(pkgs, toDao)
    const coin = /^SendCoin<(.+)>$/.exec(target)?.[1]
    return coin ? enableSendCoinAction(pkgs, coin) : null
  }
  if (typeKey === 'UpdateProposalConfig') {
    const target = payload.type_key
    // The payload already carries the values; the adapter is reused only for
    // its `buildExecute`, so the patch here is irrelevant.
    return updateProposalConfigAction(
      pkgs,
      typeof target === 'string' ? target : '',
    )
  }
  if (typeKey === 'SetBoard') return setBoardAction(pkgs, [])
  if (typeKey === 'BatchAddMembers') return addMembersAction(pkgs, [])
  if (typeKey === 'CharterUpdate') {
    return charterId ? updateMetadataAction(pkgs, '', charterId) : null
  }
  return null
}

/**
 * Resolve one composite step's executor from its `type_key`: the payload type
 * `P` for `advance_step<P>` and the `execute_*` that consumes the ticket.
 *
 * `stepMoveType` is the on-chain-recorded `TypeName` for the step. Prefer it as
 * `P` — it is exactly what `add_step` recorded, so it satisfies
 * `advance_step`'s type assertion even for generic types — falling back to the
 * adapter's own `payloadMoveType`, which matches for non-generic ones.
 *
 * Returns null for step types with no mapping, so the caller declines to build
 * the transaction rather than running a partial pipeline.
 */
export function compositeStepExecutor(
  pkgs: ArmaturePkgs,
  typeKey: string,
  stepMoveType?: string,
): CompositeStep | null {
  const action = passedProposalAction(pkgs, { typeKey })
  const own = action?.own
  if (!own) return null
  return {
    payloadMoveType: stepMoveType || own.payloadMoveType,
    buildExecute: own.buildExecute,
  }
}

/** @internal — re-exported for the handle; keeps `Transaction` in one import. */
export type { Transaction }

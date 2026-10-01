import type { Transaction } from '@mysten/sui/transactions'

import { normalizeMoveType, PERMISSIONS } from './governance'
import type { OuProposalAction } from './harness'
import {
  newConfig,
  typeNameOf,
  typeNameVec,
  type ProposalConfigInput,
} from './transactions'

/**
 * The governance action catalog (DESIGN-ARMATURE.md §13.2) — framework types.
 *
 * Each factory produces an `OuProposalAction` the resolver can carry by ANY
 * strategy — single-vote-execute, control, or a deferred proposal. Callers
 * build one of these and hand it to `org.governance.run()`; nothing here
 * decides how it will be passed.
 *
 * An action carries up to two adapters. `own` submits on the unit itself;
 * `control` is the `Controller*` form a parent uses through its `SubOUControl`
 * cap. Which ones exist is a fact about what is wired on-chain, not a
 * preference.
 *
 * Cycle 7 moved every type that changes who may do what — board, type
 * registry, metadata, freeze governance, lifecycle — INTO the framework
 * (`armature::<type>` + `armature::<handler>_ops`). Asset-moving types stay in
 * `armature_proposals` (see `treasury.ts`, `currency.ts`, `lifecycle.ts`).
 */

type TxArg = ReturnType<Transaction['moveCall']>

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
 * Governance-sensitive types that hold NO high-impact permission bit: a real
 * board vote. 7d expiry.
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
 * Treasury-spending types (`SendCoin<T>`, `SendCoinToOU<T>`,
 * `SendSmallPayment<T>`): they hold `TREASURY_WITHDRAW`, an 80%-floor bit
 * (`ou::permission_floor`), so their approval threshold must be ≥ 8000 or the
 * enable aborts. Quorum stays at half the board.
 */
export const TREASURY_TYPE_CONFIG: ProposalConfigInput = {
  quorum: 5000,
  approvalThreshold: 8000,
  proposeThreshold: 0,
  expiryMs: 604_800_000,
  executionDelayMs: 0,
  cooldownMs: 0,
  permissions: PERMISSIONS.TREASURY_WITHDRAW,
}

/**
 * The whole-board rule cycle 7 imposes on `EnableProposalType`,
 * `UpdateProposalConfig` and `EnableBypassType` configs: `quorum ×
 * approval_threshold ≥ 80%` of the board. This is the framework default —
 * 80% quorum, 100% threshold (a single NO blocks).
 */
export const WHOLE_BOARD_TYPE_CONFIG: ProposalConfigInput = {
  quorum: 8000,
  approvalThreshold: 10_000,
  proposeThreshold: 0,
  expiryMs: 604_800_000,
  executionDelayMs: 0,
  cooldownMs: 0,
}

/**
 * The `Composite` slot's config. Since cycle 7 `Composite` is a DEFAULT slot
 * on every OU (50% / 50%); this preset is for `types.updateConfig('Composite',
 * …)`. Its 80% threshold makes any composite carrying an `EnableProposalType`
 * or `UpdateProposalConfig` step clear the submission floor regardless of the
 * step configs (the effective config is the component-wise max).
 */
export const COMPOSITE_TYPE_CONFIG: ProposalConfigInput = {
  quorum: 5000,
  approvalThreshold: 8000,
  proposeThreshold: 0,
  expiryMs: 604_800_000,
  executionDelayMs: 0,
  cooldownMs: 0,
}

/** The framework's `SubOUControl` Move type — the controller types' borrow scope. */
export function subOuControlType(armature: string): string {
  return `${armature}::capability_vault::SubOUControl`
}

// ─── Display keys ───────────────────────────────────────────────────────────

/**
 * The display key for withdrawing one coin from the treasury.
 *
 * Per-coin by necessity: each `SendCoin<T>` instantiation is its own slot, and
 * display keys must be unique per OU, so the key carries the coin type.
 */
export function sendCoinTypeKey(coinType: string): string {
  return `SendCoin<${coinType}>`
}

/** As {@link sendCoinTypeKey}, for a cross-organization send (`SendCoinToOU<T>`). */
export function sendCoinToOuTypeKey(coinType: string): string {
  return `SendCoinToOU<${coinType}>`
}

/** `Name<coinType>` — the display-key convention for every per-coin generic type. */
export function genericTypeKey(name: string, typeArg: string): string {
  return `${name}<${typeArg}>`
}

/**
 * The display keys the framework seeds on every OU (cycle 7), mapped to their
 * `armature::<module>::<Struct>`. Note `UpdateMetadata`'s key is
 * `CharterUpdate`; sub-OUs omit the two bypass meta-types.
 */
export const DEFAULT_SLOT_TYPES: Record<string, string> = {
  SetBoard: 'set_board::SetBoard',
  AddMember: 'add_member::AddMember',
  RemoveMember: 'remove_member::RemoveMember',
  BatchAddMembers: 'batch_add_members::BatchAddMembers',
  BatchRemoveMembers: 'batch_remove_members::BatchRemoveMembers',
  CharterUpdate: 'update_metadata::UpdateMetadata',
  EnableProposalType: 'enable_proposal_type::EnableProposalType',
  EnableBypassType: 'enable_bypass_type::EnableBypassType',
  DisableBypassType: 'disable_bypass_type::DisableBypassType',
  DisableProposalType: 'disable_proposal_type::DisableProposalType',
  UpdateProposalConfig: 'update_proposal_config::UpdateProposalConfig',
  TransferFreezeAdmin: 'transfer_freeze_admin::TransferFreezeAdmin',
  UnfreezeProposalType: 'unfreeze_proposal_type::UnfreezeProposalType',
  Composite: 'composite_payload::CompositePayload',
}

// ─── Trading types (armature_trading) ───────────────────────────────────────

/** One `armature_trading` proposal type to enable. */
export interface TradingTypeEntry {
  /** Display key: the generics-free path, or the full type for coin-pool variants. */
  typeKey: string
  /** The Move type the slot is keyed by (generic ones instantiated). */
  moveType: string
  /** `armature::permissions` bits the handler needs (`trading_permissions`). */
  permissions: number
}

/**
 * Every `armature_trading` proposal type, as display key + Move type + bits
 * (mirrors `armature_trading::trading_permissions`).
 *
 * TODO(merge): data-identical to `trading.tradingProposalTypes` from the
 * cycle-7 vault/trading port — delegate to it once both land.
 *
 * Generic payloads are instantiated at `quoteType` (CRED). Each instantiation
 * is its OWN slot in cycle 7, so `baseTypes` adds the coin-pool order types
 * (`PlaceLimitOrderCoin<B, Q>` / `CancelOrderCoin<B, Q>`, display key = the
 * full type) once per base coin — no longer the irreversible single-base
 * binding of cycle 6. `DepositCoinToBook` and `CreateMulticoinPool` withdraw
 * from the treasury, so they carry `TREASURY_WITHDRAW` (80% approval).
 */
export function tradingTypeEntries(
  tradingPkg: string,
  quoteType: string,
  baseTypes: string[] = [],
): TradingTypeEntry[] {
  const generic = (mod: string, struct: string, permissions = 0) => ({
    typeKey: `${tradingPkg}::${mod}::${struct}`,
    moveType: `${tradingPkg}::${mod}::${struct}<${quoteType}>`,
    permissions,
  })
  const plain = (mod: string, struct: string) => ({
    typeKey: `${tradingPkg}::${mod}::${struct}`,
    moveType: `${tradingPkg}::${mod}::${struct}`,
    permissions: 0,
  })
  const coin = (mod: string, struct: string, base: string) => {
    const moveType = `${tradingPkg}::${mod}::${struct}<${base}, ${quoteType}>`
    return { typeKey: moveType, moveType, permissions: 0 }
  }
  return [
    plain('setup_trading_account', 'SetupTradingAccount'),
    generic(
      'deposit_coin_to_book',
      'DepositCoinToBook',
      PERMISSIONS.TREASURY_WITHDRAW,
    ),
    plain('deposit_from_ou_vault_to_book', 'DepositFromOuVaultToBook'),
    generic('place_limit_order', 'PlaceLimitOrder'),
    generic('place_market_order', 'PlaceMarketOrder'),
    generic('cancel_order', 'CancelOrder'),
    ...baseTypes.flatMap((b) => [
      coin('place_limit_order_coin', 'PlaceLimitOrderCoin', b),
      coin('cancel_order_coin', 'CancelOrderCoin', b),
    ]),
    generic(
      'create_multicoin_pool',
      'CreateMulticoinPool',
      PERMISSIONS.TREASURY_WITHDRAW,
    ),
    generic('sweep_coin_to_treasury', 'SweepCoinToTreasury'),
    plain('sweep_multicoin_to_ou_vault', 'SweepMulticoinToOuVault'),
  ]
}

// ─── Enable / disable / reconfigure proposal types ──────────────────────────

/**
 * Enable a proposal type on a unit.
 *
 * The proposal submitted is always `EnableProposalType`. Cycle 7 pins the
 * approved Move type IN the payload (`type_name`, via `ou::type_name_of<T>`),
 * and `execute_enable_proposal_type<NewType>` aborts (`ETypeMismatch`) unless
 * the executor passes the same type — the executor can no longer pick it.
 *
 * Its own config must satisfy `quorum × approval ≥ 80%` of the board, so on a
 * real board this resolves to a proposal; a config holding permission bits
 * GRANTS them and can never ride in a composite.
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
  const { armature } = pkgs
  const config: ProposalConfigInput = {
    ...opts.config,
    composableAllowed: opts.composableAllowed ?? opts.config.composableAllowed,
  }
  return {
    kind: opts.kind,
    own: {
      typeKey: 'EnableProposalType',
      payloadMoveType: `${armature}::enable_proposal_type::EnableProposalType`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::enable_proposal_type::new`,
          arguments: [
            tx.pure.string(opts.enabledTypeKey),
            typeNameOf(tx, armature, opts.enabledMoveType),
            newConfig(tx, armature, config),
          ],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armature}::admin_ops::execute_enable_proposal_type`,
          typeArguments: [opts.enabledMoveType],
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    fallbackPolicy: opts.fallbackPolicy ?? 'fall-back-to-proposal',
    grantsPermissions:
      !!config.permissions || (config.borrowScope?.length ?? 0) > 0,
  }
}

/**
 * Disable (remove the slot of) a type by its display key. The six governance
 * meta-types are undisableable (`EUndisableableType`); a slot's cooldown state
 * goes with it.
 */
export function disableProposalTypeAction(
  pkgs: ArmaturePkgs,
  typeKey: string,
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'disable_proposal_type',
    own: {
      typeKey: 'DisableProposalType',
      payloadMoveType: `${armature}::disable_proposal_type::DisableProposalType`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::disable_proposal_type::new`,
          arguments: [tx.pure.string(typeKey)],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armature}::admin_ops::execute_disable_proposal_type`,
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
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
    config: TREASURY_TYPE_CONFIG,
  })
}

/** Enable cross-organization treasury sends of one coin (`SendCoinToOU<Coin>`). */
export function enableSendCoinToOuAction(
  pkgs: ArmaturePkgs,
  coinType: string,
): OuProposalAction {
  return enableProposalTypeAction(pkgs, {
    kind: 'enable_treasury_send_to_ou',
    enabledTypeKey: sendCoinToOuTypeKey(coinType),
    enabledMoveType: `${pkgs.armatureProposals}::send_coin_to_ou::SendCoinToOU<${coinType}>`,
    config: TREASURY_TYPE_CONFIG,
  })
}

/**
 * Enable the `Composite` type. Since cycle 7 `Composite` is a DEFAULT slot on
 * every OU, so this only applies to a unit that disabled it.
 */
export function enableCompositeAction(pkgs: ArmaturePkgs): OuProposalAction {
  return enableProposalTypeAction(pkgs, {
    kind: 'enable_composite',
    enabledTypeKey: 'Composite',
    enabledMoveType: `${pkgs.armature}::composite_payload::CompositePayload`,
    config: COMPOSITE_TYPE_CONFIG,
  })
}

/**
 * Enable the `armature_trading` proposal types not already on the unit — one
 * action per type, meant for `runBatch()`.
 *
 * The trading types take the single-vote config (an officer trades in one
 * tx); a type whose handler needs a permission bit (`DepositCoinToBook` →
 * treasury withdraw) gets it, with the 80% approval floor that bit requires —
 * a single officer's YES is still 100% approval. `alreadyEnabled` may hold
 * display keys OR Move types.
 */
export function enableTradingActions(
  pkgs: ArmaturePkgs,
  opts: {
    armatureTrading: string
    quoteType: string
    alreadyEnabled?: Set<string>
    /** Base coins to add the coin-pool order types for (one slot per base). */
    baseTypes?: string[]
  },
): OuProposalAction[] {
  const already = opts.alreadyEnabled ?? new Set<string>()
  return tradingTypeEntries(
    opts.armatureTrading,
    opts.quoteType,
    opts.baseTypes,
  )
    .filter(
      (e) =>
        !already.has(e.typeKey) &&
        !already.has(e.moveType) &&
        !already.has(normalizeMoveType(e.moveType)),
    )
    .map((e) =>
      enableProposalTypeAction(pkgs, {
        kind: 'enable_trading',
        enabledTypeKey: e.typeKey,
        enabledMoveType: e.moveType,
        config: e.permissions
          ? {
              ...TRADING_TYPE_CONFIG,
              approvalThreshold: 8000,
              permissions: e.permissions,
            }
          : TRADING_TYPE_CONFIG,
      }),
    )
}

/** Fields of a `ProposalConfig` to change; omitted fields are left alone. */
export interface ProposalConfigPatch {
  quorum?: number
  approvalThreshold?: number
  proposeThreshold?: number
  expiryMs?: number
  executionDelayMs?: number
  cooldownMs?: number
  /**
   * Whether the type may be a step inside a `Composite`. A type with a
   * cooldown cannot also be composable (`EComposableCooldownConflict`).
   */
  composableAllowed?: boolean
  /**
   * Cycle 7 — REPLACE the type's permission bits. A change is a grant: only a
   * standalone `UpdateProposalConfig` may make it (never a composite step),
   * and framework types' bits are fixed (`EFixedPermissions`).
   */
  permissions?: number
  /** Cycle 7 — REPLACE the type's borrow scope (capability Move types). Also a grant. */
  borrowScope?: string[]
}

/**
 * Change the voting rules of an already-enabled type, named by display key.
 * Every field is an `Option` on-chain, so anything omitted keeps its current
 * value. `UpdateProposalConfig` itself sits under the 80%-of-the-whole-board
 * rule, so this is a governance vote on any multi-member board.
 */
export function updateProposalConfigAction(
  pkgs: ArmaturePkgs,
  targetTypeKey: string,
  patch: ProposalConfigPatch = {},
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'update_proposal_config',
    own: {
      typeKey: 'UpdateProposalConfig',
      payloadMoveType: `${armature}::update_proposal_config::UpdateProposalConfig`,
      buildPayload: (tx) => {
        let payload: TxArg = tx.moveCall({
          target: `${armature}::update_proposal_config::new`,
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
        })
        if (patch.permissions !== undefined) {
          payload = tx.moveCall({
            target: `${armature}::update_proposal_config::with_permissions`,
            arguments: [payload, tx.pure.u64(patch.permissions)],
          })
        }
        if (patch.borrowScope !== undefined) {
          payload = tx.moveCall({
            target: `${armature}::update_proposal_config::with_borrow_scope`,
            arguments: [payload, typeNameVec(tx, armature, patch.borrowScope)],
          })
        }
        return payload
      },
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armature}::admin_ops::execute_update_proposal_config`,
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
    grantsPermissions:
      patch.permissions !== undefined || patch.borrowScope !== undefined,
  }
}

// ─── Bypass execution (EnableBypassType / DisableBypassType) ────────────────

/**
 * Opt the unit into BYPASS execution for one type: enables the type AND mints
 * an `ExternalExecutionCap<NewType>` into the unit's capability vault, so the
 * type's own package can mint tickets without a vote (e.g.
 * `MintAllowance<T>` via `currency_ops::mint_allowance_bypass`).
 *
 * Guard rails the chain enforces: an 80% YES floor on the WHOLE board at
 * execution (so a single vote never suffices on a board of 2+), the config
 * may not hold `TYPE_ADMIN | MIGRATE | VAULT_EXTRACT | FREEZE`, and sub-OUs
 * cannot enable it at all. Requires the unit's capability vault.
 */
export function enableBypassTypeAction(
  pkgs: ArmaturePkgs,
  opts: {
    typeKey: string
    moveType: string
    config: ProposalConfigInput
    capabilityVaultId: string
  },
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'enable_bypass_type',
    own: {
      typeKey: 'EnableBypassType',
      payloadMoveType: `${armature}::enable_bypass_type::EnableBypassType`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::enable_bypass_type::new`,
          arguments: [
            tx.pure.string(opts.typeKey),
            typeNameOf(tx, armature, opts.moveType),
            newConfig(tx, armature, opts.config),
          ],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armature}::external_execution::execute_enable_bypass_type`,
          typeArguments: [opts.moveType],
          arguments: [
            tx.object(ownDaoId),
            tx.object(opts.capabilityVaultId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
    grantsPermissions: true,
  }
}

/**
 * Opt OUT of bypass execution: extracts and destroys the type's
 * `ExternalExecutionCap` and removes its slot, atomically. `capId` is the cap
 * in the unit's vault (see `org.capabilities.list()`); `moveType` must be the
 * slot's type.
 */
export function disableBypassTypeAction(
  pkgs: ArmaturePkgs,
  opts: {
    typeKey: string
    moveType: string
    capId: string
    capabilityVaultId: string
  },
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'disable_bypass_type',
    own: {
      typeKey: 'DisableBypassType',
      payloadMoveType: `${armature}::disable_bypass_type::DisableBypassType`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::disable_bypass_type::new`,
          arguments: [tx.pure.string(opts.typeKey), tx.pure.id(opts.capId)],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armature}::external_execution::execute_disable_bypass_type`,
          typeArguments: [opts.moveType],
          arguments: [
            tx.object(ownDaoId),
            tx.object(opts.capabilityVaultId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

// ─── Membership ─────────────────────────────────────────────────────────────

/**
 * Add members to a unit. Carries both paths:
 *  - own `BatchAddMembers` (a default slot on every OU since cycle 7);
 *  - control `ControllerBatchAddMembers`, where the parent seats them on this
 *    child through its `SubOUControl` cap (enabled single-vote on the tribe
 *    and officer units by `tribe_setup`).
 *
 * The resolver picks: a single vote on whichever board clears its quorum
 * executes; otherwise the board most likely to pass it gets a proposal.
 * At most 100 addresses per call (`EBatchTooLarge`); already-seated addresses
 * are skipped, not refused.
 */
export function addMembersAction(
  pkgs: ArmaturePkgs,
  addresses: string[],
): OuProposalAction {
  const { armature, armatureProposals } = pkgs
  return {
    kind: 'add_members',
    own: {
      typeKey: 'BatchAddMembers',
      payloadMoveType: `${armature}::batch_add_members::BatchAddMembers`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::batch_add_members::new`,
          arguments: [tx.pure.vector('address', addresses)],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armature}::member_ops::execute_batch_add_members`,
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    control: {
      typeKey: 'ControllerBatchAddMembers',
      payloadMoveType: `${armatureProposals}::controller_batch_add_members::ControllerBatchAddMembers`,
      requiredPermissions: PERMISSIONS.VAULT_BORROW,
      requiredBorrowScope: [subOuControlType(armature)],
      buildPayload: (tx, controlCapId) =>
        tx.moveCall({
          target: `${armatureProposals}::controller_batch_add_members::new`,
          arguments: [
            tx.pure.id(controlCapId),
            tx.pure.vector('address', addresses),
          ],
        }),
      buildExecute: (tx, ticket, capVaultId, childDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::subou_ops::execute_controller_batch_add_members`,
          arguments: [tx.object(capVaultId), tx.object(childDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Remove members from a unit. Cycle 7 makes `BatchRemoveMembers` a default
 * slot on EVERY OU, so a root unit can remove its own members directly now;
 * a child can still be acted on by its parent via `ControllerBatchRemoveMembers`.
 * Removal rotates the unit's Seal encryption epoch.
 */
export function removeMembersAction(
  pkgs: ArmaturePkgs,
  addresses: string[],
): OuProposalAction {
  const { armature, armatureProposals } = pkgs
  return {
    kind: 'remove_members',
    own: {
      typeKey: 'BatchRemoveMembers',
      payloadMoveType: `${armature}::batch_remove_members::BatchRemoveMembers`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::batch_remove_members::new`,
          arguments: [tx.pure.vector('address', addresses)],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armature}::member_ops::execute_batch_remove_members`,
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    control: {
      typeKey: 'ControllerBatchRemoveMembers',
      payloadMoveType: `${armatureProposals}::controller_batch_remove_members::ControllerBatchRemoveMembers`,
      requiredPermissions: PERMISSIONS.VAULT_BORROW,
      requiredBorrowScope: [subOuControlType(armature)],
      buildPayload: (tx, controlCapId) =>
        tx.moveCall({
          target: `${armatureProposals}::controller_batch_remove_members::new`,
          arguments: [
            tx.pure.id(controlCapId),
            tx.pure.vector('address', addresses),
          ],
        }),
      buildExecute: (tx, ticket, capVaultId, childDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::subou_ops::execute_controller_batch_remove_members`,
          arguments: [tx.object(capVaultId), tx.object(childDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/** Add ONE member (`AddMember`). Aborts if already seated, unlike the batch. */
export function addMemberAction(
  pkgs: ArmaturePkgs,
  address: string,
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'add_member',
    own: {
      typeKey: 'AddMember',
      payloadMoveType: `${armature}::add_member::AddMember`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::add_member::new`,
          arguments: [tx.pure.address(address)],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armature}::member_ops::execute_add_member`,
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/** Remove ONE member (`RemoveMember`). Rotates the encryption epoch. */
export function removeMemberAction(
  pkgs: ArmaturePkgs,
  address: string,
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'remove_member',
    own: {
      typeKey: 'RemoveMember',
      payloadMoveType: `${armature}::remove_member::RemoveMember`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::remove_member::new`,
          arguments: [tx.pure.address(address)],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armature}::member_ops::execute_remove_member`,
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Change a unit's board as ONE diff. Cycle 7 `SetBoard` is `{ to_add,
 * to_remove }` — the roster is a `Table` and cannot be enumerated on-chain, so
 * "replace the board" is no longer expressible. Both lists empty aborts
 * (`ENoBoardChange`); any removal rotates the encryption epoch.
 */
export function setBoardAction(
  pkgs: ArmaturePkgs,
  change: { add?: string[]; remove?: string[] },
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'set_board',
    own: {
      typeKey: 'SetBoard',
      payloadMoveType: `${armature}::set_board::SetBoard`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::set_board::new`,
          arguments: [
            tx.pure.vector('address', change.add ?? []),
            tx.pure.vector('address', change.remove ?? []),
          ],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armature}::board_ops::execute_set_board`,
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

// ─── Metadata ───────────────────────────────────────────────────────────────

/**
 * Update a unit's charter metadata URI. Own-only. The slot's display key is
 * `CharterUpdate` while the payload type is `UpdateMetadata` — they genuinely
 * differ on-chain, which no longer matters because the slot is keyed by type.
 *
 * `charterId` is the Charter object the execute step mutates; the execute call
 * targets the Charter, NOT the OU, which is why this adapter ignores the
 * `ownDaoId` its signature receives.
 */
export function updateMetadataAction(
  pkgs: ArmaturePkgs,
  metadataUri: string,
  charterId: string,
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'update_org_metadata',
    own: {
      typeKey: 'CharterUpdate',
      payloadMoveType: `${armature}::update_metadata::UpdateMetadata`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::update_metadata::new`,
          arguments: [tx.pure.string(metadataUri)],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${armature}::admin_ops::execute_update_metadata`,
          arguments: [tx.object(charterId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/** @internal — re-exported for the handle; keeps `Transaction` in one import. */
export type { Transaction }

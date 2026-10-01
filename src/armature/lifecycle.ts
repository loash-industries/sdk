import type { Transaction } from '@mysten/sui/transactions'

import type { ArmaturePkgs } from './actions'
import { subOuControlType } from './actions'
import { PERMISSIONS } from './governance'
import type { OuProposalAction } from './harness'
import {
  initBoard,
  newConfig,
  typeNameVec,
  type ProposalConfigInput,
} from './transactions'

/**
 * Organizational-unit lifecycle and parent→child control (cycle 7).
 *
 * Two families live here:
 *
 * - **Lifecycle** (framework types, `armature::lifecycle_ops`): `CreateSubOU`,
 *   `SpawnOU`, `SpinOutSubOU`, `TransferAssets`. They change the authority
 *   graph, so they hold fixed high-impact bits and need 80% approval.
 * - **Control** (`armature_proposals::subou_ops`): a parent acting on a CHILD
 *   through the `SubOUControl` in the parent's capability vault —
 *   pause/unpause the child, move a capability into or out of its vault.
 *   These are modelled as CONTROL adapters: the resolver is handed the child's
 *   context and the parent's board votes, exactly like member changes.
 */

type TxArg = ReturnType<Transaction['moveCall']>

// ─── Parent → child control ─────────────────────────────────────────────────

/**
 * Pause a child unit's execution (`PauseSubOUExecution`): every own-execution
 * on the child aborts until unpaused. `tribe_setup` enables it single-vote on
 * the tribe and officer units — an emergency brake one member can pull.
 */
export function pauseSubOuAction(pkgs: ArmaturePkgs): OuProposalAction {
  return pauseLike(pkgs, 'pause')
}

/**
 * Resume a paused child (`UnpauseSubOUExecution`). `tribe_setup` gives it a
 * 50% quorum so one member cannot reverse an emergency pause.
 */
export function unpauseSubOuAction(pkgs: ArmaturePkgs): OuProposalAction {
  return pauseLike(pkgs, 'unpause')
}

function pauseLike(
  pkgs: ArmaturePkgs,
  which: 'pause' | 'unpause',
): OuProposalAction {
  const { armature, armatureProposals } = pkgs
  const struct =
    which === 'pause' ? 'PauseSubOUExecution' : 'UnpauseSubOUExecution'
  return {
    kind: `${which}_subou`,
    control: {
      typeKey: struct,
      payloadMoveType: `${armatureProposals}::pause_execution::${struct}`,
      requiredPermissions: PERMISSIONS.VAULT_BORROW,
      requiredBorrowScope: [subOuControlType(armature)],
      buildPayload: (tx, controlCapId) =>
        tx.moveCall({
          target: `${armatureProposals}::pause_execution::new_${which}`,
          arguments: [tx.pure.id(controlCapId)],
        }),
      buildExecute: (tx, ticket, capVaultId, childDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::subou_ops::execute_${which}_subou_execution`,
          arguments: [tx.object(capVaultId), tx.object(childDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Move a capability from the parent's vault INTO the child's vault
 * (`TransferCapToSubOU`). `capType` is the cap's Move type (the handler is
 * generic over it). The child must be controlled by this parent.
 */
export function transferCapToSubOuAction(
  pkgs: ArmaturePkgs,
  params: {
    subOuId: string
    subOuCapabilityVaultId: string
    capId: string
    capType: string
  },
): OuProposalAction {
  const { armatureProposals } = pkgs
  return {
    kind: 'transfer_cap_to_subou',
    control: {
      typeKey: 'TransferCapToSubOU',
      payloadMoveType: `${armatureProposals}::transfer_cap_to_subou::TransferCapToSubOU`,
      requiredPermissions: PERMISSIONS.VAULT_EXTRACT,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armatureProposals}::transfer_cap_to_subou::new`,
          arguments: [tx.pure.id(params.capId), tx.pure.id(params.subOuId)],
        }),
      buildExecute: (tx, ticket, capVaultId, childDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::subou_ops::execute_transfer_cap`,
          typeArguments: [params.capType],
          arguments: [
            tx.object(capVaultId),
            tx.object(params.subOuCapabilityVaultId),
            tx.object(childDaoId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Pull a capability OUT of the child's vault back into the parent's
 * (`ReclaimCapFromSubOU`), on the parent's `SubOUControl` authority.
 */
export function reclaimCapFromSubOuAction(
  pkgs: ArmaturePkgs,
  params: {
    subOuId: string
    subOuCapabilityVaultId: string
    capId: string
    capType: string
  },
): OuProposalAction {
  const { armature, armatureProposals } = pkgs
  return {
    kind: 'reclaim_cap_from_subou',
    control: {
      typeKey: 'ReclaimCapFromSubOU',
      payloadMoveType: `${armatureProposals}::reclaim_cap_from_subou::ReclaimCapFromSubOU`,
      requiredPermissions: PERMISSIONS.VAULT_BORROW | PERMISSIONS.VAULT_STORE,
      requiredBorrowScope: [subOuControlType(armature)],
      buildPayload: (tx, controlCapId) =>
        tx.moveCall({
          target: `${armatureProposals}::reclaim_cap_from_subou::new`,
          arguments: [
            tx.pure.id(params.subOuId),
            tx.pure.id(params.capId),
            tx.pure.id(controlCapId),
          ],
        }),
      buildExecute: (tx, ticket, capVaultId, childDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::subou_ops::execute_reclaim_cap`,
          typeArguments: [params.capType],
          arguments: [
            tx.object(capVaultId),
            tx.object(params.subOuCapabilityVaultId),
            tx.object(childDaoId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/** Configs a spun-out unit gets for its newly-enabled hierarchy types. */
export interface SpinOutConfigs {
  spawnOu: ProposalConfigInput
  spinOutSubOu: ProposalConfigInput
  createSubOu: ProposalConfigInput
}

/** 80% / 80% — the floor the three hierarchy types' fixed bits require. */
export const HIERARCHY_TYPE_CONFIG: ProposalConfigInput = {
  quorum: 8000,
  approvalThreshold: 8000,
  proposeThreshold: 0,
  expiryMs: 604_800_000,
  executionDelayMs: 0,
  cooldownMs: 0,
}

/**
 * Release a child from its parent (`SpinOutSubOU`): clears the child's
 * controller, enables `SpawnOU` / `SpinOutSubOU` / `CreateSubOU` on it with
 * the given configs, moves the child's `FreezeAdminCap` out of the parent's
 * vault into the child's, and destroys the `SubOUControl`. Irreversible.
 *
 * The parent's vault must HOLD the child's `FreezeAdminCap` — true for units
 * made by `CreateSubOU`, NOT for tribe units, whose caps were sent to
 * addresses at creation. Submitted on the parent (its own type), modelled as a
 * control adapter so the resolver is handed the child.
 */
export function spinOutSubOuAction(
  pkgs: ArmaturePkgs,
  params: {
    subOuId: string
    subOuCapabilityVaultId: string
    freezeAdminCapId: string
    configs?: Partial<SpinOutConfigs>
  },
): OuProposalAction {
  const { armature } = pkgs
  const c = params.configs ?? {}
  return {
    kind: 'spin_out_subou',
    control: {
      typeKey: 'SpinOutSubOU',
      payloadMoveType: `${armature}::spin_out_subou::SpinOutSubOU`,
      buildPayload: (tx, controlCapId) =>
        tx.moveCall({
          target: `${armature}::spin_out_subou::new`,
          arguments: [
            tx.pure.id(params.subOuId),
            tx.pure.id(controlCapId),
            tx.pure.id(params.freezeAdminCapId),
            newConfig(tx, armature, c.spawnOu ?? HIERARCHY_TYPE_CONFIG),
            newConfig(tx, armature, c.spinOutSubOu ?? HIERARCHY_TYPE_CONFIG),
            newConfig(tx, armature, c.createSubOu ?? HIERARCHY_TYPE_CONFIG),
          ],
        }),
      buildExecute: (tx, ticket, capVaultId, childDaoId) => {
        tx.moveCall({
          target: `${armature}::lifecycle_ops::execute_spin_out_subou`,
          arguments: [
            tx.object(capVaultId),
            tx.object(params.subOuCapabilityVaultId),
            tx.object(childDaoId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

// ─── Lifecycle (own unit) ───────────────────────────────────────────────────

/**
 * Create a child unit under this one (`CreateSubOU`): a new OU with the given
 * board, its `SubOUControl` minted into this unit's vault, and its
 * `FreezeAdminCap` stored there too (so it can later be spun out). Root units
 * only — the type is blocked on controlled sub-OUs, and it is not a default
 * slot, so enable it first.
 */
export function createSubOuAction(
  pkgs: ArmaturePkgs,
  params: {
    name: string
    board: string[]
    metadataUri: string
    capabilityVaultId: string
  },
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'create_subou',
    own: {
      typeKey: 'CreateSubOU',
      payloadMoveType: `${armature}::create_subou::CreateSubOU`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::create_subou::new`,
          arguments: [
            tx.pure.string(params.name),
            tx.pure.vector('address', params.board),
            tx.pure.string(params.metadataUri),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${armature}::lifecycle_ops::execute_create_subou`,
          arguments: [tx.object(params.capabilityVaultId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Spawn a successor OU and put THIS one into `Migrating` (`SpawnOU`) —
 * IRREVERSIBLE. Afterwards only `TransferAssets` runs here, and once the
 * treasury and vault are empty anyone can `ou::destroy` it.
 */
export function spawnOuAction(
  pkgs: ArmaturePkgs,
  params: { board: string[]; name: string; metadataUri: string },
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'spawn_ou',
    own: {
      typeKey: 'SpawnOU',
      payloadMoveType: `${armature}::spawn_ou::SpawnOU`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::spawn_ou::new`,
          arguments: [
            initBoard(tx, armature, params.board),
            tx.pure.string(params.name),
            tx.pure.string(params.metadataUri),
          ],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armature}::lifecycle_ops::execute_spawn_ou`,
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Move listed coins (full balances) and capabilities to another OU
 * (`TransferAssets`) — the one type that still runs while migrating. The
 * execution is a hot potato: `begin_transfer_assets` → `transfer_coin<T>` per
 * coin → `transfer_cap<T>` per cap → `finish_transfer_assets`, which aborts
 * unless EVERY listed asset moved. At most 50 assets.
 */
export function transferAssetsAction(
  pkgs: ArmaturePkgs,
  params: {
    targetOuId: string
    targetTreasuryId: string
    targetCapabilityVaultId: string
    coinTypes: string[]
    caps: { id: string; type: string }[]
    treasuryVaultId: string
    capabilityVaultId: string
  },
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'transfer_assets',
    own: {
      typeKey: 'TransferAssets',
      payloadMoveType: `${armature}::transfer_assets::TransferAssets`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::transfer_assets::new`,
          arguments: [
            tx.pure.id(params.targetOuId),
            tx.pure.id(params.targetTreasuryId),
            tx.pure.id(params.targetCapabilityVaultId),
            typeNameVec(tx, armature, params.coinTypes),
            tx.pure.vector(
              'address',
              params.caps.map((c) => c.id),
            ),
          ],
        }),
      buildExecute: (tx, ticket) =>
        appendTransferAssets(tx, armature, ticket, params),
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/** @internal — the TransferAssets hot-potato sequence for one ticket. */
export function appendTransferAssets(
  tx: Transaction,
  armature: string,
  ticket: TxArg,
  params: {
    targetTreasuryId: string
    targetCapabilityVaultId: string
    coinTypes: string[]
    caps: { id: string; type: string }[]
    treasuryVaultId: string
    capabilityVaultId: string
  },
): void {
  const transfer = tx.moveCall({
    target: `${armature}::lifecycle_ops::begin_transfer_assets`,
    arguments: [
      tx.object(params.treasuryVaultId),
      tx.object(params.capabilityVaultId),
      ticket,
    ],
  })
  for (const coinType of params.coinTypes) {
    tx.moveCall({
      target: `${armature}::lifecycle_ops::transfer_coin`,
      typeArguments: [coinType],
      arguments: [
        transfer,
        tx.object(params.treasuryVaultId),
        tx.object(params.targetTreasuryId),
      ],
    })
  }
  for (const cap of params.caps) {
    tx.moveCall({
      target: `${armature}::lifecycle_ops::transfer_cap`,
      typeArguments: [cap.type],
      arguments: [
        transfer,
        tx.object(params.capabilityVaultId),
        tx.object(params.targetCapabilityVaultId),
        tx.pure.id(cap.id),
      ],
    })
  }
  tx.moveCall({
    target: `${armature}::lifecycle_ops::finish_transfer_assets`,
    arguments: [transfer],
  })
}

// ─── Freeze governance (own unit) ───────────────────────────────────────────

/**
 * Hand the unit's `FreezeAdminCap` to `newAdmin` (`TransferFreezeAdmin`),
 * unfreezing every frozen type on the way. The cap is passed BY VALUE, so the
 * executor must currently own it (`freezeAdminCapId`). Freeze-exempt and
 * undisableable.
 */
export function transferFreezeAdminAction(
  pkgs: ArmaturePkgs,
  params: {
    newAdmin: string
    freezeAdminCapId: string
    emergencyFreezeId: string
  },
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'transfer_freeze_admin',
    own: {
      typeKey: 'TransferFreezeAdmin',
      payloadMoveType: `${armature}::transfer_freeze_admin::TransferFreezeAdmin`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::transfer_freeze_admin::new`,
          arguments: [tx.pure.address(params.newAdmin)],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${armature}::freeze_ops::execute_transfer_freeze_admin`,
          arguments: [
            tx.object(params.emergencyFreezeId),
            tx.object(params.freezeAdminCapId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/** Lift a freeze on one Move type by board vote (`UnfreezeProposalType`), no cap needed. */
export function unfreezeProposalTypeAction(
  pkgs: ArmaturePkgs,
  params: { moveType: string; emergencyFreezeId: string },
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'unfreeze_proposal_type',
    own: {
      typeKey: 'UnfreezeProposalType',
      payloadMoveType: `${armature}::unfreeze_proposal_type::UnfreezeProposalType`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::unfreeze_proposal_type::new`,
          typeArguments: [params.moveType],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${armature}::freeze_ops::execute_unfreeze_proposal_type`,
          arguments: [tx.object(params.emergencyFreezeId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/** Change how long a freeze lasts (`UpdateFreezeConfig`). Not a default slot. */
export function updateFreezeConfigAction(
  pkgs: ArmaturePkgs,
  params: { maxFreezeDurationMs: number; emergencyFreezeId: string },
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'update_freeze_config',
    own: {
      typeKey: 'UpdateFreezeConfig',
      payloadMoveType: `${armature}::update_freeze_config::UpdateFreezeConfig`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armature}::update_freeze_config::new`,
          arguments: [tx.pure.u64(params.maxFreezeDurationMs)],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${armature}::freeze_ops::execute_update_freeze_config`,
          arguments: [tx.object(params.emergencyFreezeId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Add/remove Move types on the freeze-EXEMPT set (`UpdateFreezeExemptTypes`) —
 * the types that keep executing while everything else is frozen. Not a
 * default slot.
 */
export function updateFreezeExemptTypesAction(
  pkgs: ArmaturePkgs,
  params: { add?: string[]; remove?: string[]; emergencyFreezeId: string },
): OuProposalAction {
  const { armature } = pkgs
  return {
    kind: 'update_freeze_exempt_types',
    own: {
      typeKey: 'UpdateFreezeExemptTypes',
      payloadMoveType: `${armature}::update_freeze_exempt_types::UpdateFreezeExemptTypes`,
      buildPayload: (tx) => {
        const payload = tx.moveCall({
          target: `${armature}::update_freeze_exempt_types::new`,
          arguments: [],
        })
        for (const t of params.add ?? []) {
          tx.moveCall({
            target: `${armature}::update_freeze_exempt_types::add_type`,
            typeArguments: [t],
            arguments: [payload],
          })
        }
        for (const t of params.remove ?? []) {
          tx.moveCall({
            target: `${armature}::update_freeze_exempt_types::remove_type`,
            typeArguments: [t],
            arguments: [payload],
          })
        }
        return payload
      },
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${armature}::freeze_ops::execute_update_freeze_exempt_types`,
          arguments: [tx.object(params.emergencyFreezeId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

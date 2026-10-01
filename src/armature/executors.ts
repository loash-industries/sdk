import type { Transaction } from '@mysten/sui/transactions'

import { CLOCK_ID } from '../config'
import type { ArmaturePkgs } from './actions'
import { DEFAULT_SLOT_TYPES } from './actions'
import { normalizeMoveType } from './governance'
import type { OuProposalAction } from './harness'
import { appendTransferAssets } from './lifecycle'
import type { CompositeStep } from './plan'
import { readTypeName } from './proposals'
import type { OrgNode } from './types'
import { appendUpgradeExecution, type UpgradeBuild } from './upgrade'

/**
 * Executing what a board already passed (B5) — dispatch by PAYLOAD TYPE.
 *
 * Cycle 7 keys everything by Move type, and a live proposal carries its
 * payload type (`Proposal<P>`) and decoded payload, so the handler is chosen
 * from `P` — not from a display key a unit is free to rename. The same
 * dispatcher drives composite steps (`advance_step<P>` records `P`).
 *
 * Some handlers take objects that are named only IN the payload (a cross-OU
 * send's target treasury, a controller step's child unit, a disable-bypass
 * cap's type) or that the EXECUTOR must own and hand over by value (the
 * `FreezeAdminCap`, a `TreasuryCap` being adopted, the compiled package of an
 * upgrade). The context carries those; anything missing comes back as a
 * `missing` reason instead of a half-built transaction.
 */

type TxArg = ReturnType<Transaction['moveCall']>

/** Everything a passed proposal's handler might need. */
export interface PassedExecutionContext {
  pkgs: ArmaturePkgs
  /** The unit the proposal belongs to. */
  unit: {
    daoId: string
    charterId?: string | null
    treasuryId?: string | null
    capabilityVaultId?: string | null
    emergencyFreezeId?: string | null
  }
  /** The tree — resolves a control id or a sub-OU id to its unit. */
  nodes?: readonly OrgNode[]
  /** Decoded payload (live proposal JSON or a composite frame step). */
  payload?: Record<string, unknown>
  /** Display key → the slot's Move type (`DisableBypassType` needs it). */
  typeForDisplayKey?: (displayKey: string) => string | undefined
  /** Cap id → its Move type (`TransferAssets`, cap transfers between units). */
  capTypeOf?: (capId: string) => string | undefined
  /** The unit's `FreezeAdminCap`, owned by the executor (`TransferFreezeAdmin`). */
  freezeAdminCapId?: string
  /** The `TreasuryCap<T>` being handed over, owned by the executor (`AdoptCurrency`). */
  treasuryCapId?: string
  /** The compiled package (`ProposeUpgrade`). */
  upgrade?: UpgradeBuild
}

/** A resolved handler, or why none could be built. */
export type PassedExecutor =
  | { execute: (tx: Transaction, ticket: TxArg, ownDaoId: string) => void }
  | { missing: string }

/** Split `0xPKG::mod::Struct<A, B>` into its head and top-level type args. */
export function splitMoveType(type: string): {
  pkg: string
  path: string
  args: string[]
} {
  const t = normalizeMoveType(type)
  const open = t.indexOf('<')
  const head = open < 0 ? t : t.slice(0, open)
  const [pkg, ...rest] = head.split('::')
  const args: string[] = []
  if (open >= 0) {
    let depth = 0
    let cur = ''
    for (const ch of t.slice(open + 1, -1)) {
      if (ch === '<') depth++
      if (ch === '>') depth--
      if (ch === ',' && depth === 0) {
        args.push(cur)
        cur = ''
      } else cur += ch
    }
    if (cur) args.push(cur)
  }
  return { pkg, path: rest.join('::'), args }
}

const pkgOf = (id: string): string =>
  normalizeMoveType(`${id}::m::T`).split('::')[0]

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

/**
 * The handler for a passed proposal of payload type `payloadMoveType`.
 * Returns `{ missing }` for an unknown type, or when an object the handler
 * needs is absent from the context.
 */
export function executorForPayload(
  payloadMoveType: string,
  c: PassedExecutionContext,
): PassedExecutor {
  const { armature, armatureProposals } = c.pkgs
  const { pkg, path, args } = splitMoveType(payloadMoveType)
  const T = args[0]
  const p = c.payload ?? {}
  const u = c.unit
  const missing = (what: string): PassedExecutor => ({
    missing: `${path} needs ${what}`,
  })
  const call =
    (
      target: string,
      objs: (ownDaoId: string) => string[],
      typeArgs?: string[],
    ) =>
    (tx: Transaction, ticket: TxArg, ownDaoId: string) => {
      const ids = objs(ownDaoId)
      tx.moveCall({
        target,
        typeArguments: typeArgs,
        arguments: [...ids.map((id) => tx.object(id)), ticket],
      })
    }
  const nodeByControl = (controlId: string | undefined) =>
    controlId
      ? c.nodes?.find(
          (n) =>
            n.subdaoControlCapId?.toLowerCase() === controlId.toLowerCase(),
        )
      : undefined
  const nodeById = (id: string | undefined) =>
    id
      ? c.nodes?.find((n) => n.daoId.toLowerCase() === id.toLowerCase())
      : undefined

  if (pkg === pkgOf(armature)) {
    const fw = (mod: string, fn: string) => `${armature}::${mod}::${fn}`
    switch (path) {
      case 'set_board::SetBoard':
        return {
          execute: call(fw('board_ops', 'execute_set_board'), (o) => [o]),
        }
      case 'add_member::AddMember':
        return {
          execute: call(fw('member_ops', 'execute_add_member'), (o) => [o]),
        }
      case 'remove_member::RemoveMember':
        return {
          execute: call(fw('member_ops', 'execute_remove_member'), (o) => [o]),
        }
      case 'batch_add_members::BatchAddMembers':
        return {
          execute: call(fw('member_ops', 'execute_batch_add_members'), (o) => [
            o,
          ]),
        }
      case 'batch_remove_members::BatchRemoveMembers':
        return {
          execute: call(
            fw('member_ops', 'execute_batch_remove_members'),
            (o) => [o],
          ),
        }
      case 'update_metadata::UpdateMetadata': {
        const charter = u.charterId
        if (!charter) return missing("the unit's Charter id")
        return {
          execute: call(fw('admin_ops', 'execute_update_metadata'), () => [
            charter,
          ]),
        }
      }
      case 'enable_proposal_type::EnableProposalType': {
        const newType = readTypeName(p.type_name)
        if (!newType) return missing('the payload (its pinned type_name)')
        return {
          execute: call(
            fw('admin_ops', 'execute_enable_proposal_type'),
            (o) => [o],
            [newType],
          ),
        }
      }
      case 'disable_proposal_type::DisableProposalType':
        return {
          execute: call(
            fw('admin_ops', 'execute_disable_proposal_type'),
            (o) => [o],
          ),
        }
      case 'update_proposal_config::UpdateProposalConfig':
        return {
          execute: call(
            fw('admin_ops', 'execute_update_proposal_config'),
            (o) => [o],
          ),
        }
      case 'enable_bypass_type::EnableBypassType': {
        const newType = readTypeName(p.type_name)
        const vault = u.capabilityVaultId
        if (!newType) return missing('the payload (its pinned type_name)')
        if (!vault) return missing("the unit's CapabilityVault")
        return {
          execute: call(
            fw('external_execution', 'execute_enable_bypass_type'),
            (o) => [o, vault],
            [newType],
          ),
        }
      }
      case 'disable_bypass_type::DisableBypassType': {
        const key = str(p.type_key)
        const newType = key ? c.typeForDisplayKey?.(key) : undefined
        const vault = u.capabilityVaultId
        if (!newType)
          return missing("the bypass slot's Move type (governance read)")
        if (!vault) return missing("the unit's CapabilityVault")
        return {
          execute: call(
            fw('external_execution', 'execute_disable_bypass_type'),
            (o) => [o, vault],
            [newType],
          ),
        }
      }
      case 'transfer_freeze_admin::TransferFreezeAdmin': {
        const freeze = u.emergencyFreezeId
        const cap = c.freezeAdminCapId
        if (!freeze) return missing("the unit's EmergencyFreeze")
        if (!cap)
          return missing(
            '`freezeAdminCapId` — the executor must own the FreezeAdminCap',
          )
        return {
          execute: call(
            fw('freeze_ops', 'execute_transfer_freeze_admin'),
            () => [freeze, cap],
          ),
        }
      }
      case 'unfreeze_proposal_type::UnfreezeProposalType':
      case 'update_freeze_config::UpdateFreezeConfig':
      case 'update_freeze_exempt_types::UpdateFreezeExemptTypes': {
        const freeze = u.emergencyFreezeId
        if (!freeze) return missing("the unit's EmergencyFreeze")
        const fn = {
          'unfreeze_proposal_type::UnfreezeProposalType':
            'execute_unfreeze_proposal_type',
          'update_freeze_config::UpdateFreezeConfig':
            'execute_update_freeze_config',
          'update_freeze_exempt_types::UpdateFreezeExemptTypes':
            'execute_update_freeze_exempt_types',
        }[path]!
        return { execute: call(fw('freeze_ops', fn), () => [freeze]) }
      }
      case 'spawn_ou::SpawnOU':
        return {
          execute: call(fw('lifecycle_ops', 'execute_spawn_ou'), (o) => [o]),
        }
      case 'create_subou::CreateSubOU': {
        const vault = u.capabilityVaultId
        if (!vault) return missing("the unit's CapabilityVault")
        return {
          execute: call(fw('lifecycle_ops', 'execute_create_subou'), () => [
            vault,
          ]),
        }
      }
      case 'spin_out_subou::SpinOutSubOU': {
        const vault = u.capabilityVaultId
        const child = nodeById(str(p.subou_id))
        if (!vault) return missing("the unit's CapabilityVault")
        if (!child?.capabilityVaultId) {
          return missing('the sub-OU (payload subou_id) in this tree')
        }
        return {
          execute: call(fw('lifecycle_ops', 'execute_spin_out_subou'), () => [
            vault,
            child.capabilityVaultId!,
            child.daoId,
          ]),
        }
      }
      case 'transfer_assets::TransferAssets': {
        const treasury = u.treasuryId
        const vault = u.capabilityVaultId
        const coinTypes = (Array.isArray(p.coin_types) ? p.coin_types : [])
          .map(readTypeName)
          .filter((t): t is string => !!t)
        const capIds = (Array.isArray(p.cap_ids) ? p.cap_ids : []).filter(
          (x): x is string => typeof x === 'string',
        )
        const caps = capIds.map((id) => ({ id, type: c.capTypeOf?.(id) }))
        const targetTreasury = str(p.target_treasury_id)
        const targetVault = str(p.target_vault_id)
        if (!treasury || !vault) return missing("the unit's treasury and vault")
        if (!targetTreasury || !targetVault)
          return missing('the payload targets')
        if (caps.some((x) => !x.type)) {
          return missing('the Move type of every listed cap (capability read)')
        }
        return {
          execute: (tx, ticket) =>
            appendTransferAssets(tx, armature, ticket, {
              targetTreasuryId: targetTreasury,
              targetCapabilityVaultId: targetVault,
              coinTypes,
              caps: caps as { id: string; type: string }[],
              treasuryVaultId: treasury,
              capabilityVaultId: vault,
            }),
        }
      }
    }
  }

  if (pkg === pkgOf(armatureProposals)) {
    const ap = (mod: string, fn: string) =>
      `${armatureProposals}::${mod}::${fn}`
    const treasury = u.treasuryId
    const vault = u.capabilityVaultId
    switch (path) {
      case 'send_coin::SendCoin':
        if (!treasury) return missing("the unit's TreasuryVault")
        return {
          execute: call(
            ap('treasury_ops', 'execute_send_coin'),
            () => [treasury],
            [T],
          ),
        }
      case 'send_coin_to_ou::SendCoinToOU': {
        const target = str(p.recipient_treasury)
        if (!treasury) return missing("the unit's TreasuryVault")
        if (!target) return missing('the payload (recipient_treasury)')
        return {
          execute: call(
            ap('treasury_ops', 'execute_send_coin_to_ou'),
            () => [treasury, target],
            [T],
          ),
        }
      }
      case 'send_small_payment::SendSmallPayment':
        if (!treasury) return missing("the unit's TreasuryVault")
        return {
          execute: (tx, ticket, ownDaoId) => {
            tx.moveCall({
              target: ap('treasury_ops', 'execute_send_small_payment'),
              typeArguments: [T],
              arguments: [
                tx.object(ownDaoId),
                tx.object(treasury),
                ticket,
                tx.object(CLOCK_ID),
              ],
            })
          },
        }
      case 'adopt_currency::AdoptCurrency': {
        const cap = c.treasuryCapId
        if (!vault) return missing("the unit's CapabilityVault")
        if (!cap)
          return missing(
            '`treasuryCapId` — the executor must own the TreasuryCap',
          )
        return {
          execute: call(
            ap('currency_ops', 'execute_adopt_currency'),
            () => [vault, cap],
            [T],
          ),
        }
      }
      case 'mint_coin::MintCoin':
      case 'mint_allowance::MintAllowance':
      case 'burn_coin::BurnCoin': {
        if (!vault || !treasury) return missing("the unit's vault and treasury")
        const fn = {
          'mint_coin::MintCoin': 'execute_mint_coin',
          'mint_allowance::MintAllowance': 'execute_mint_allowance',
          'burn_coin::BurnCoin': 'execute_burn_coin',
        }[path]!
        return {
          execute: call(ap('currency_ops', fn), () => [vault, treasury], [T]),
        }
      }
      case 'return_currency_cap::ReturnCurrencyCap':
        if (!vault) return missing("the unit's CapabilityVault")
        return {
          execute: call(
            ap('currency_ops', 'execute_return_currency_cap'),
            () => [vault],
            [T],
          ),
        }
      case 'configure_mint_allowance::ConfigureMintAllowance':
        return {
          execute: call(
            ap('configure_mint_allowance', 'execute_configure_mint_allowance'),
            (o) => [o],
            [T],
          ),
        }
      case 'controller_batch_add_members::ControllerBatchAddMembers':
      case 'controller_batch_remove_members::ControllerBatchRemoveMembers':
      case 'pause_execution::PauseSubOUExecution':
      case 'pause_execution::UnpauseSubOUExecution': {
        const child = nodeByControl(str(p.control_id))
        if (!vault) return missing("the unit's CapabilityVault")
        if (!child) return missing('the child unit its control_id points at')
        const fn = {
          'controller_batch_add_members::ControllerBatchAddMembers':
            'execute_controller_batch_add_members',
          'controller_batch_remove_members::ControllerBatchRemoveMembers':
            'execute_controller_batch_remove_members',
          'pause_execution::PauseSubOUExecution':
            'execute_pause_subou_execution',
          'pause_execution::UnpauseSubOUExecution':
            'execute_unpause_subou_execution',
        }[path]!
        return {
          execute: call(ap('subou_ops', fn), () => [vault, child.daoId]),
        }
      }
      case 'transfer_cap_to_subou::TransferCapToSubOU': {
        const child = nodeById(str(p.target_subou))
        const capId = str(p.cap_id)
        const capType = capId ? c.capTypeOf?.(capId) : undefined
        if (!vault) return missing("the unit's CapabilityVault")
        if (!child?.capabilityVaultId)
          return missing('the target sub-OU in this tree')
        if (!capType) return missing("the cap's Move type (capability read)")
        return {
          execute: call(
            ap('subou_ops', 'execute_transfer_cap'),
            () => [vault, child.capabilityVaultId!, child.daoId],
            [capType],
          ),
        }
      }
      case 'reclaim_cap_from_subou::ReclaimCapFromSubOU': {
        const child = nodeById(str(p.subou_id))
        const capId = str(p.cap_id)
        const capType = capId ? c.capTypeOf?.(capId) : undefined
        if (!vault) return missing("the unit's CapabilityVault")
        if (!child?.capabilityVaultId) return missing('the sub-OU in this tree')
        if (!capType)
          return missing("the cap's Move type (capability read of the sub-OU)")
        return {
          execute: call(
            ap('subou_ops', 'execute_reclaim_cap'),
            () => [vault, child.capabilityVaultId!, child.daoId],
            [capType],
          ),
        }
      }
      case 'propose_upgrade::ProposeUpgrade': {
        const pkgId = str(p.package_id)
        if (!vault) return missing("the unit's CapabilityVault")
        if (!pkgId) return missing('the payload (package_id)')
        if (!c.upgrade) return missing('`upgrade` — the compiled package')
        const build = c.upgrade
        return {
          execute: (tx, ticket) =>
            appendUpgradeExecution(tx, {
              armatureProposals,
              capabilityVaultId: vault,
              packageId: pkgId,
              ticket,
              build,
            }),
        }
      }
    }
  }

  return {
    missing: `no wired executor for ${normalizeMoveType(payloadMoveType)} — trading proposals execute through org.orders, third-party types through their own package`,
  }
}

/**
 * The payload Move type of a DEFAULT slot, by display key — for callers that
 * only have the indexer's `type_key`. Null for anything else.
 */
export function defaultSlotType(
  pkgs: ArmaturePkgs,
  displayKey: string,
): string | null {
  const path = DEFAULT_SLOT_TYPES[displayKey]
  return path ? `${pkgs.armature}::${path}` : null
}

/**
 * Reconstruct an execute-only action for a passed proposal, so
 * `buildExecutePassedTx` can reuse the same `buildExecute` a single-vote run
 * would have used. `payloadType` is preferred; without it the default-slot
 * display keys (`SetBoard`, `CharterUpdate`, …) and `SendCoin<T>` /
 * `SendCoinToOU<T>` keys are mapped.
 *
 * Returns null when no handler can be built — the caller should then decline
 * rather than guess.
 */
export function passedProposalAction(
  pkgs: ArmaturePkgs,
  args: {
    typeKey: string
    payloadType?: string
    payload?: Record<string, unknown>
    charterId?: string
  } & Partial<Omit<PassedExecutionContext, 'pkgs' | 'payload'>>,
): OuProposalAction | null {
  const type =
    args.payloadType ??
    defaultSlotType(pkgs, args.typeKey) ??
    perCoinType(pkgs, args.typeKey)
  if (!type) return null
  const exec = executorForPayload(type, {
    pkgs,
    unit: args.unit ?? { daoId: '', charterId: args.charterId ?? null },
    nodes: args.nodes,
    payload: args.payload,
    typeForDisplayKey: args.typeForDisplayKey,
    capTypeOf: args.capTypeOf,
    freezeAdminCapId: args.freezeAdminCapId,
    treasuryCapId: args.treasuryCapId,
    upgrade: args.upgrade,
  })
  if ('missing' in exec) return null
  return {
    kind: `execute_${args.typeKey}`,
    own: {
      typeKey: args.typeKey,
      payloadMoveType: type,
      buildPayload: () => {
        throw new Error('passedProposalAction is execute-only')
      },
      buildExecute: exec.execute,
    },
  }
}

function perCoinType(pkgs: ArmaturePkgs, key: string): string | null {
  const m = /^(SendCoin|SendCoinToOU|SendSmallPayment)<(.+)>$/.exec(key)
  if (!m) return null
  const mod = {
    SendCoin: 'send_coin',
    SendCoinToOU: 'send_coin_to_ou',
    SendSmallPayment: 'send_small_payment',
  }[m[1]]!
  return `${pkgs.armatureProposals}::${mod}::${m[1]}<${m[2]}>`
}

/**
 * Resolve one composite step's executor: the payload type `P` for
 * `advance_step<P>` (the recorded `TypeName` — prefer it, it is exactly what
 * `add_step` recorded) and the handler that consumes the ticket.
 *
 * Returns null for step types with no mapping, so the caller declines to build
 * the transaction rather than running a partial pipeline.
 */
export function compositeStepExecutor(
  pkgs: ArmaturePkgs,
  typeKey: string,
  stepMoveType?: string,
  ctx?: Partial<Omit<PassedExecutionContext, 'pkgs'>>,
): CompositeStep | null {
  const type =
    stepMoveType || defaultSlotType(pkgs, typeKey) || perCoinType(pkgs, typeKey)
  if (!type) return null
  const exec = executorForPayload(type, {
    pkgs,
    ...ctx,
    unit: ctx?.unit ?? { daoId: '' },
  })
  if ('missing' in exec) return null
  return { payloadMoveType: type, buildExecute: exec.execute }
}

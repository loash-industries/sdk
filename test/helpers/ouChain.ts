import { bcs } from '@mysten/sui/bcs'

import {
  EmergencyFreezeBcs,
  normalizeMoveType,
  OuBcs,
  type ProposalConfig,
  TypeSlotFieldBcs,
} from '../../src/armature/governance'

/**
 * A fake fullnode for cycle-7 OUs: the OU root (BCS), its `TypeSlot` dynamic
 * fields (BCS), its `EmergencyFreeze` (BCS) and its roster table — the four
 * things `fetchDaoGovernance` / `fetchIsBoardMember` read. Shared by every
 * Armature suite that drives the resolver through a handle.
 */

export interface SlotSpec {
  /** The payload Move type the slot is keyed by. */
  moveType: string
  /** Display key; defaults to the Move type. */
  displayKey?: string
  config?: Partial<ProposalConfig>
  lastExecutedMs?: number | null
}

export interface UnitSpec {
  slots: SlotSpec[]
  /** Board members (roster table entries, all open tenures). */
  members?: string[]
  executionPaused?: boolean
  controllerPaused?: boolean
  migrating?: string
  controllerCapId?: string | null
  /** Override the head-current board size (defaults to `members.length`). */
  memberCount?: number
  /** Canonical-or-not Move type → freeze expiry (ms). */
  frozen?: Record<string, number>
  entries?: string[]
  encryptEpoch?: number
  treasuryId?: string
  capabilityVaultId?: string
  charterId?: string
  emergencyFreezeId?: string
}

const pad = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

export const baseConfig = (
  over: Partial<ProposalConfig> = {},
): ProposalConfig => ({
  quorum: 1,
  approvalThreshold: 5000,
  proposeThreshold: 0,
  expiryMs: 3_600_000,
  executionDelayMs: 0,
  cooldownMs: 0,
  composableAllowed: false,
  permissions: 0,
  borrowScope: [],
  ...over,
})

const strip = (t: string) => normalizeMoveType(t).replace(/0x/g, '')

/** BCS of one `Field<TypeSlot, ProposalType>`. */
export function slotContent(spec: SlotSpec): Uint8Array {
  const c = baseConfig(spec.config)
  return TypeSlotFieldBcs.serialize({
    id: pad(7),
    name: { name: { name: strip(spec.moveType) } },
    value: {
      display_key: spec.displayKey ?? spec.moveType,
      config: {
        quorum: c.quorum,
        approval_threshold: c.approvalThreshold,
        propose_threshold: BigInt(c.proposeThreshold),
        expiry_ms: BigInt(c.expiryMs),
        execution_delay_ms: BigInt(c.executionDelayMs),
        cooldown_ms: BigInt(c.cooldownMs),
        composable_allowed: c.composableAllowed,
        permissions: BigInt(c.permissions ?? 0),
        borrow_scope: (c.borrowScope ?? []).map((t) => ({ name: strip(t) })),
      },
      last_executed_ms:
        spec.lastExecutedMs == null ? null : BigInt(spec.lastExecutedMs),
    },
  }).toBytes()
}

/** BCS of an OU root. */
export function ouContent(
  ouId: string,
  u: UnitSpec,
  tableId: string,
): Uint8Array {
  return OuBcs.serialize({
    id: ouId,
    status: u.migrating
      ? { Migrating: { successor_ou_id: u.migrating } }
      : { Active: true },
    governance: {
      members: { id: tableId, size: BigInt(u.members?.length ?? 0) },
      member_count: BigInt(u.memberCount ?? u.members?.length ?? 0),
      roster_version: 1n,
    },
    treasury_id: u.treasuryId ?? pad(0xa1),
    capability_vault_id: u.capabilityVaultId ?? pad(0xa2),
    charter_id: u.charterId ?? pad(0xa3),
    emergency_freeze_id: u.emergencyFreezeId ?? `${ouId.slice(0, -4)}f12e`,
    execution_paused: !!u.executionPaused,
    controller_cap_id: u.controllerCapId ?? null,
    controller_paused: !!u.controllerPaused,
    encrypt_epoch: BigInt(u.encryptEpoch ?? 0),
    entries: u.entries ?? [],
  }).toBytes()
}

/** BCS of an `EmergencyFreeze`. */
export function freezeContent(ouId: string, u: UnitSpec): Uint8Array {
  return EmergencyFreezeBcs.serialize({
    id: pad(0xf),
    ou_id: ouId,
    frozen_types: {
      contents: Object.entries(u.frozen ?? {}).map(([t, exp]) => ({
        key: { name: strip(t) },
        value: BigInt(exp),
      })),
    },
    max_freeze_duration_ms: 604_800_000n,
    freeze_exempt_types: { contents: [] },
  }).toBytes()
}

const MemberBcs = bcs.struct('Member', {
  tenures: bcs.vector(
    bcs.struct('Tenure', { joined: bcs.u64(), left: bcs.option(bcs.u64()) }),
  ),
})

const norm = (a: string) => a.toLowerCase().replace(/^0x0*/, '')

/**
 * A `{ core }` stand-in serving `units` (keyed by OU id) plus any `extra`
 * objects (`objectId → { json?, content?, type? }`).
 */
export function mockOuChain(
  units: Record<string, UnitSpec>,
  extra: Record<
    string,
    { json?: Record<string, unknown>; content?: Uint8Array; type?: string }
  > = {},
) {
  const byOu = new Map<string, UnitSpec>()
  const tables = new Map<string, UnitSpec>()
  const freezes = new Map<string, string>()
  const fields = new Map<string, Uint8Array>()
  let n = 0
  for (const [ouId, u] of Object.entries(units)) {
    byOu.set(norm(ouId), u)
    tables.set(norm(`${ouId.slice(0, -4)}7ab1`), u)
    freezes.set(norm(u.emergencyFreezeId ?? `${ouId.slice(0, -4)}f12e`), ouId)
    u.slots.forEach((s) => fields.set(`field-${ouId}-${n++}`, slotContent(s)))
  }
  const tableOf = (ouId: string) => `${ouId.slice(0, -4)}7ab1`

  const getObject = async ({ objectId }: { objectId: string }) => {
    const u = byOu.get(norm(objectId))
    if (u) {
      return {
        object: {
          objectId,
          type: '0x1::ou::OU',
          content: ouContent(objectId, u, tableOf(objectId)),
          json: {},
        },
      }
    }
    const fz = freezes.get(norm(objectId))
    if (fz) {
      return {
        object: {
          objectId,
          type: '0x1::emergency::EmergencyFreeze',
          content: freezeContent(fz, byOu.get(norm(fz))!),
        },
      }
    }
    const e = extra[objectId]
    if (e) {
      return {
        object: {
          objectId,
          type: e.type ?? '',
          content: e.content,
          json: e.json ?? null,
        },
      }
    }
    throw new Error(`object ${objectId} not found`)
  }

  const listDynamicFields = async ({ parentId }: { parentId: string }) => ({
    hasNextPage: false,
    cursor: null,
    dynamicFields: [...fields.keys()]
      .filter((k) => k.startsWith(`field-${parentId}-`))
      .map((fieldId) => ({
        fieldId,
        type: 'DynamicField',
        name: { type: '0x1::ou::TypeSlot', bcs: new Uint8Array() },
        valueType: '0x1::ou::ProposalType',
        $kind: 'DynamicField' as const,
      })),
  })

  const getObjects = async ({ objectIds }: { objectIds: string[] }) => ({
    objects: objectIds.map((id) => ({ objectId: id, content: fields.get(id) })),
  })

  const getDynamicField = async ({
    parentId,
    name,
  }: {
    parentId: string
    name: { type: string; bcs: Uint8Array }
  }) => {
    const u = tables.get(norm(parentId))
    if (!u) throw new Error('no field')
    const addr = bcs.Address.parse(name.bcs)
    if (!(u.members ?? []).some((m) => norm(m) === norm(addr))) {
      throw new Error('not a member')
    }
    return {
      dynamicField: {
        value: {
          type: 'Member',
          bcs: MemberBcs.serialize({
            tenures: [{ joined: 0n, left: null }],
          }).toBytes(),
        },
      },
    }
  }

  return { core: { getObject, listDynamicFields, getObjects, getDynamicField } }
}

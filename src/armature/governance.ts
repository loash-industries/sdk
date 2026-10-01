import { bcs } from '@mysten/sui/bcs'
import type { ClientWithCoreApi } from '@mysten/sui/client'

/**
 * An organizational unit's governance state, read from the live objects.
 *
 * The indexer does not serve any of this, and it has to be head-current: a
 * config change and an action can land in the same session, and the resolver's
 * answer is only ever as correct as the config it read
 * (DESIGN-ARMATURE.md §8).
 *
 * Cycle 7 moved the proposal-type registry OFF the OU root: every enabled type
 * is one dynamic field keyed `ou::TypeSlot { name: TypeName }` holding
 * `ou::ProposalType { display_key, config, last_executed_ms }`. The slot is
 * keyed by the payload's MOVE TYPE (`with_defining_ids`), and the display key
 * is only a human label — so lookups here go by Move type first
 * ({@link slotForType}) and fall back to the label.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** One proposal type's voting rules, in basis points / milliseconds. */
export interface ProposalConfig {
  /** Share of TOTAL board weight that must vote, in bps (10000 = 100%). */
  quorum: number
  /** Share of CAST weight that must approve, in bps. */
  approvalThreshold: number
  /**
   * Minimum voting weight a proposer needs. Board weight is 1 per member, so
   * anything above 1 means nobody can submit this type.
   */
  proposeThreshold: number
  /**
   * How long voting stays open, AND how long a passed proposal stays
   * executable once its delay has elapsed. Enormous values mean "never
   * expires" and can exceed 2^53 — compare, do not do arithmetic.
   */
  expiryMs: number
  /** Non-zero forbids atomic execute — `submit_vote_execute` asserts this. */
  executionDelayMs: number
  /** Minimum time between executions of this type; enforced at execution. */
  cooldownMs: number
  /**
   * Whether this type may appear as a step inside a `Composite` proposal.
   * `add_step` rejects types without it, so `canComposite()` consults it before
   * a cart is bundled.
   */
  composableAllowed: boolean
  /**
   * Cycle 7 — `armature::permissions` bits the type's requests carry. A handler
   * whose mutator needs a bit the slot lacks aborts with
   * `proposal::EPermissionDenied`. See {@link PERMISSIONS}. Absent means 0.
   */
  permissions?: number
  /**
   * Cycle 7 — capability types (0x-prefixed Move types) a `VAULT_BORROW`
   * request of this type may borrow or loan. Absent means empty.
   */
  borrowScope?: string[]
}

/** One enabled proposal type: an `ou::TypeSlot` dynamic field. */
export interface TypeSlot {
  /** Canonical 0x-prefixed Move type the slot is keyed by. */
  typeName: string
  /** Human label (`SetBoard`, `CharterUpdate`, `SendCoin<…>`). Unique per OU. */
  displayKey: string
  config: ProposalConfig
  /** Last execution (epoch ms) — feeds the cooldown check. Null if never. */
  lastExecutedMs: number | null
}

/** The OU root object's lifecycle and pause flags. */
export interface OuState {
  status: 'active' | 'migrating'
  /** Set while migrating (SpawnOU executed). */
  successorOuId: string | null
  /** No proposal of this OU can execute while true (PAUSE-gated). */
  executionPaused: boolean
  /** A parent's `PauseSubOUExecution` — blocks the unit's own executions. */
  controllerPaused: boolean
  /** The parent's registered `SubOUControl` id; null for a top-level OU. */
  controllerCapId: string | null
  /** Head-current board size — the total snapshot weight a vote is measured against. */
  memberCount: number
  /** Advances once per membership change. */
  rosterVersion: number
  /** Table id of the roster — `fetchIsBoardMember` reads it. */
  membersTableId: string
  treasuryId: string
  capabilityVaultId: string
  charterId: string
  emergencyFreezeId: string
  /** Seal encryption epoch; rotates whenever a member is removed. */
  encryptEpoch: number
  /** Published `EncryptedEntry` ids (max 32). */
  entries: string[]
}

/** The unit's `EmergencyFreeze` — which types are frozen and until when. */
export interface FreezeState {
  /** Canonical Move type → freeze expiry (epoch ms). */
  frozenTypes: Map<string, number>
  /** Types that can never be frozen. */
  exemptTypes: string[]
  maxFreezeDurationMs: number
}

/** Which proposal types a unit has enabled, and the rules for each. */
export interface DaoGovernance {
  /** Display keys of every enabled type. */
  enabledTypes: Set<string>
  /** Display key → config. Mirrors `enabledTypes`. */
  configs: Map<string, ProposalConfig>
  /**
   * Display key → the fully-qualified Move type the slot is keyed by. Every
   * cycle-7 slot has one — the type IS the slot.
   */
  typeBindings: Map<string, string>
  /** Cycle 7 — every slot, keyed by Move type. Prefer {@link slotForType}. */
  slots?: TypeSlot[]
  /** Cycle 7 — the OU root's flags. Absent when not read. */
  state?: OuState
  /** Cycle 7 — the unit's freeze object. Absent when not read. */
  freeze?: FreezeState
}

// ─── Permission bits (armature::permissions) ────────────────────────────────

/**
 * `armature::permissions` bits, mirrored. A type's slot holds the bits its
 * handler needs; framework types have FIXED bits the chain applies itself.
 */
export const PERMISSIONS = {
  BOARD_ADD: 1 << 0,
  BOARD_REMOVE: 1 << 1,
  BOARD_SET: 1 << 2,
  TYPE_ADMIN: 1 << 3,
  PAUSE: 1 << 4,
  MIGRATE: 1 << 5,
  METADATA: 1 << 6,
  TREASURY_WITHDRAW: 1 << 7,
  VAULT_STORE: 1 << 8,
  VAULT_BORROW: 1 << 9,
  VAULT_EXTRACT: 1 << 10,
  FREEZE: 1 << 11,
} as const

/**
 * Bits that raise a config's approval floor to 80% (`ou::permission_floor`).
 * A config holding any of them with `approvalThreshold < 8000` aborts.
 */
export const HIGH_IMPACT_PERMISSIONS =
  PERMISSIONS.TYPE_ADMIN |
  PERMISSIONS.MIGRATE |
  PERMISSIONS.TREASURY_WITHDRAW |
  PERMISSIONS.VAULT_BORROW |
  PERMISSIONS.VAULT_EXTRACT

/** Bits a bypass-enabled type may never hold (`external_execution::bypass_forbidden_bits`). */
export const BYPASS_FORBIDDEN_PERMISSIONS =
  PERMISSIONS.TYPE_ADMIN |
  PERMISSIONS.MIGRATE |
  PERMISSIONS.VAULT_EXTRACT |
  PERMISSIONS.FREEZE

/** Minimum approval threshold the chain accepts for a config holding `bits`. */
export function permissionFloor(bits: number): number {
  return (bits & HIGH_IMPACT_PERMISSIONS) !== 0 ? 8000 : 0
}

/** Whether `mask` holds every bit of `bits`. */
export function hasPermissions(mask: number, bits: number): boolean {
  return (mask & bits) === bits
}

// ─── Move type names ────────────────────────────────────────────────────────

/**
 * Canonical form of a Move type string: every address zero-padded to 64
 * lowercase hex WITH a `0x` prefix, whitespace removed. On-chain `TypeName`s
 * (`with_defining_ids`) omit the prefix and pad; SDK callers usually write
 * `0x2::sui::SUI`. Both normalise to the same string, so they compare equal.
 */
export function normalizeMoveType(type: string): string {
  return type
    .replace(/\s+/g, '')
    .replace(
      /(^|[<,])(?:0x)?([0-9a-fA-F]{1,64})::/g,
      (_m, lead: string, addr: string) =>
        `${lead}0x${addr.toLowerCase().padStart(64, '0')}::`,
    )
}

/** Remap package ids inside a Move type (e.g. current → original/defining). */
export function remapPackages(
  type: string,
  aliases: ReadonlyMap<string, string> | undefined,
): string {
  const norm = normalizeMoveType(type)
  if (!aliases || aliases.size === 0) return norm
  return norm.replace(/0x[0-9a-f]{64}/g, (addr) => aliases.get(addr) ?? addr)
}

/**
 * The enabled slot for a payload Move type, or undefined.
 *
 * Matches by Move type — which is what the chain matches by — after mapping
 * `aliases` (normalised `current → defining` package ids, for upgraded
 * packages), and falls back to `displayKey` for a governance read that carries
 * no slots.
 */
export function slotForType(
  gov: DaoGovernance | undefined,
  moveType: string,
  opts?: { displayKey?: string; aliases?: ReadonlyMap<string, string> },
): TypeSlot | undefined {
  if (!gov) return undefined
  const want = remapPackages(moveType, opts?.aliases)
  const byType = gov.slots?.find(
    (s) => remapPackages(s.typeName, opts?.aliases) === want,
  )
  if (byType) return byType
  const key = opts?.displayKey
  if (!key) return undefined
  const config = gov.configs.get(key)
  if (!config) return undefined
  return {
    typeName: gov.typeBindings.get(key) ?? normalizeMoveType(moveType),
    displayKey: key,
    config,
    lastExecutedMs:
      gov.slots?.find((s) => s.displayKey === key)?.lastExecutedMs ?? null,
  }
}

/** Build normalised `current → original` package aliases from id pairs. */
export function packageAliases(
  pairs: [current: string | undefined, original: string | undefined][],
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [current, original] of pairs) {
    if (!current || !original) continue
    const c = normalizeMoveType(`${current}::m::T`).split('::')[0]
    const o = normalizeMoveType(`${original}::m::T`).split('::')[0]
    if (c !== o) out.set(c, o)
  }
  return out
}

// ─── BCS layouts (cycle 7) ──────────────────────────────────────────────────

const TypeNameBcs = bcs.struct('TypeName', { name: bcs.string() })

/** `armature::proposal::ProposalConfig`. */
export const ProposalConfigBcs = bcs.struct('ProposalConfig', {
  quorum: bcs.u16(),
  approval_threshold: bcs.u16(),
  propose_threshold: bcs.u64(),
  expiry_ms: bcs.u64(),
  execution_delay_ms: bcs.u64(),
  cooldown_ms: bcs.u64(),
  composable_allowed: bcs.bool(),
  permissions: bcs.u64(),
  borrow_scope: bcs.vector(TypeNameBcs),
})

/** `sui::dynamic_field::Field<ou::TypeSlot, ou::ProposalType>`. */
export const TypeSlotFieldBcs = bcs.struct('Field<TypeSlot,ProposalType>', {
  id: bcs.Address,
  name: bcs.struct('TypeSlot', { name: TypeNameBcs }),
  value: bcs.struct('ProposalType', {
    display_key: bcs.string(),
    config: ProposalConfigBcs,
    last_executed_ms: bcs.option(bcs.u64()),
  }),
})

/** `armature::ou::OU` — the root object. */
export const OuBcs = bcs.struct('OU', {
  id: bcs.Address,
  status: bcs.enum('OUStatus', {
    Active: null,
    Migrating: bcs.struct('Migrating', { successor_ou_id: bcs.Address }),
  }),
  governance: bcs.struct('GovernanceConfig', {
    members: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }),
    member_count: bcs.u64(),
    roster_version: bcs.u64(),
  }),
  treasury_id: bcs.Address,
  capability_vault_id: bcs.Address,
  charter_id: bcs.Address,
  emergency_freeze_id: bcs.Address,
  execution_paused: bcs.bool(),
  controller_cap_id: bcs.option(bcs.Address),
  controller_paused: bcs.bool(),
  encrypt_epoch: bcs.u64(),
  entries: bcs.vector(bcs.Address),
})

/** `armature::emergency::EmergencyFreeze`. */
export const EmergencyFreezeBcs = bcs.struct('EmergencyFreeze', {
  id: bcs.Address,
  ou_id: bcs.Address,
  frozen_types: bcs.struct('VecMap', {
    contents: bcs.vector(
      bcs.struct('Entry', { key: TypeNameBcs, value: bcs.u64() }),
    ),
  }),
  max_freeze_duration_ms: bcs.u64(),
  freeze_exempt_types: bcs.struct('VecSet', {
    contents: bcs.vector(TypeNameBcs),
  }),
})

/** `armature::governance::Member` — one roster entry's tenure history. */
const MemberBcs = bcs.struct('Member', {
  tenures: bcs.vector(
    bcs.struct('Tenure', { joined: bcs.u64(), left: bcs.option(bcs.u64()) }),
  ),
})

// ─── Parsing ────────────────────────────────────────────────────────────────

const num = (v: string | number | bigint): number => Number(v)

/** A decoded `ProposalConfig` (BCS form) → the SDK shape. */
export function configFromBcs(
  c: ReturnType<typeof ProposalConfigBcs.parse>,
): ProposalConfig {
  return {
    quorum: c.quorum,
    approvalThreshold: c.approval_threshold,
    proposeThreshold: num(c.propose_threshold),
    expiryMs: num(c.expiry_ms),
    executionDelayMs: num(c.execution_delay_ms),
    cooldownMs: num(c.cooldown_ms),
    composableAllowed: c.composable_allowed,
    permissions: num(c.permissions),
    borrowScope: c.borrow_scope.map((t) => normalizeMoveType(t.name)),
  }
}

/** Decode one `TypeSlot` dynamic-field object's BCS content. */
export function parseTypeSlot(content: Uint8Array): TypeSlot {
  const f = TypeSlotFieldBcs.parse(content)
  return {
    typeName: normalizeMoveType(f.name.name.name),
    displayKey: f.value.display_key,
    config: configFromBcs(f.value.config),
    lastExecutedMs:
      f.value.last_executed_ms == null ? null : num(f.value.last_executed_ms),
  }
}

/** Decode the OU root's BCS content. */
export function parseOuState(content: Uint8Array): OuState {
  const o = OuBcs.parse(content)
  const migrating = o.status.$kind === 'Migrating'
  return {
    status: migrating ? 'migrating' : 'active',
    successorOuId: migrating
      ? (o.status as { Migrating: { successor_ou_id: string } }).Migrating
          .successor_ou_id
      : null,
    executionPaused: o.execution_paused,
    controllerPaused: o.controller_paused,
    controllerCapId: o.controller_cap_id ?? null,
    memberCount: num(o.governance.member_count),
    rosterVersion: num(o.governance.roster_version),
    membersTableId: o.governance.members.id,
    treasuryId: o.treasury_id,
    capabilityVaultId: o.capability_vault_id,
    charterId: o.charter_id,
    emergencyFreezeId: o.emergency_freeze_id,
    encryptEpoch: num(o.encrypt_epoch),
    entries: o.entries,
  }
}

/** Decode an `EmergencyFreeze` object's BCS content. */
export function parseFreezeState(content: Uint8Array): FreezeState {
  const f = EmergencyFreezeBcs.parse(content)
  return {
    frozenTypes: new Map(
      f.frozen_types.contents.map((e) => [
        normalizeMoveType(e.key.name),
        num(e.value),
      ]),
    ),
    exemptTypes: f.freeze_exempt_types.contents.map((t) =>
      normalizeMoveType(t.name),
    ),
    maxFreezeDurationMs: num(f.max_freeze_duration_ms),
  }
}

/** Assemble slots into the display-key maps older callers index by. */
export function governanceFromSlots(
  slots: TypeSlot[],
  extra: { state?: OuState; freeze?: FreezeState } = {},
): DaoGovernance {
  const enabledTypes = new Set<string>()
  const configs = new Map<string, ProposalConfig>()
  const typeBindings = new Map<string, string>()
  for (const s of slots) {
    enabledTypes.add(s.displayKey)
    configs.set(s.displayKey, s.config)
    typeBindings.set(s.displayKey, s.typeName)
  }
  return { enabledTypes, configs, typeBindings, slots, ...extra }
}

// ─── The single-vote predicate ──────────────────────────────────────────────

/**
 * Can ONE board member's vote pass and execute a proposal of this config in a
 * single transaction (`board_voting::submit_vote_execute`)?
 *
 * Board voting is weight-1 per member, so with N members a lone vote is 1/N of
 * total weight. It meets quorum iff `1 × 10000 ≥ N × quorum`. The approval
 * threshold is always satisfied — one 100%-yes vote clears any threshold ≤ 100%
 * — so quorum is the only vote gate, plus the config must permit atomic
 * execution (`executionDelayMs === 0`, asserted on-chain) and let a single
 * member propose at all (`proposeThreshold ≤ 1`).
 *
 * This is why the answer turns on per-type CONFIG, not on role: a five-member
 * board at 5000bps cannot single-vote anything, while the same board at 1bps
 * can single-vote everything.
 */
export function singleVoteExecutable(
  boardSize: number,
  config: ProposalConfig,
): boolean {
  if (boardSize <= 0) return false
  if (config.executionDelayMs !== 0) return false
  if (config.proposeThreshold > 1) return false
  return boardSize * config.quorum <= 10_000
}

/** When the type may next execute, or null when its cooldown is not running. */
export function cooldownEndsAt(slot: {
  config: ProposalConfig
  lastExecutedMs: number | null
}): number | null {
  if (slot.config.cooldownMs <= 0 || slot.lastExecutedMs == null) return null
  return slot.lastExecutedMs + slot.config.cooldownMs
}

// ─── Network reads ──────────────────────────────────────────────────────────

/** Max object ids per `getObjects` call. */
const GET_OBJECTS_BATCH = 50

/** True when a dynamic field's key type is `<pkg>::ou::TypeSlot`. */
const isTypeSlotKey = (type: string): boolean =>
  type.split('<')[0].endsWith('::ou::TypeSlot')

async function readContent(
  suiClient: ClientWithCoreApi,
  objectId: string,
): Promise<Uint8Array> {
  const { object } = await suiClient.core.getObject({
    objectId,
    include: { content: true },
  })
  return object.content
}

/** Every proposal-type slot of an OU (lists its dynamic fields). */
export async function fetchTypeSlots(
  suiClient: ClientWithCoreApi,
  ouId: string,
): Promise<TypeSlot[]> {
  const fieldIds: string[] = []
  let cursor: string | null = null
  do {
    const page = await suiClient.core.listDynamicFields({
      parentId: ouId,
      cursor,
    })
    for (const df of page.dynamicFields) {
      if (isTypeSlotKey(df.name.type)) fieldIds.push(df.fieldId)
    }
    cursor = page.hasNextPage ? page.cursor : null
  } while (cursor !== null)

  const slots: TypeSlot[] = []
  for (let i = 0; i < fieldIds.length; i += GET_OBJECTS_BATCH) {
    const { objects } = await suiClient.core.getObjects({
      objectIds: fieldIds.slice(i, i + GET_OBJECTS_BATCH),
      include: { content: true },
    })
    for (const o of objects) {
      if (o instanceof Error || !o.content) continue
      slots.push(parseTypeSlot(o.content))
    }
  }
  return slots
}

/** The OU root's flags. */
export async function fetchOuState(
  suiClient: ClientWithCoreApi,
  ouId: string,
): Promise<OuState> {
  return parseOuState(await readContent(suiClient, ouId))
}

/** A unit's `EmergencyFreeze`. */
export async function fetchFreezeState(
  suiClient: ClientWithCoreApi,
  emergencyFreezeId: string,
): Promise<FreezeState> {
  return parseFreezeState(await readContent(suiClient, emergencyFreezeId))
}

/**
 * Read a unit's whole governance surface: the OU root (flags, board size), its
 * proposal-type slots, and its `EmergencyFreeze`. Three round trips at most,
 * the slots batched.
 */
export async function fetchDaoGovernance(
  suiClient: ClientWithCoreApi,
  daoId: string,
): Promise<DaoGovernance> {
  const [state, slots] = await Promise.all([
    fetchOuState(suiClient, daoId),
    fetchTypeSlots(suiClient, daoId),
  ])
  const freeze = await fetchFreezeState(
    suiClient,
    state.emergencyFreezeId,
  ).catch(() => undefined)
  return governanceFromSlots(slots, { state, freeze })
}

/**
 * One proposal type's config by display key, or null when the type is not
 * enabled. Prefer `slotForType(gov, moveType)` — the chain keys by type.
 */
export async function fetchProposalConfig(
  suiClient: ClientWithCoreApi,
  daoId: string,
  typeKey: string,
): Promise<ProposalConfig | null> {
  const slots = await fetchTypeSlots(suiClient, daoId)
  return slots.find((s) => s.displayKey === typeKey)?.config ?? null
}

/**
 * Head-current board membership: the roster `Table` entry for `address`, open
 * iff its last tenure has not ended. Use it where indexer lag matters — a
 * member added seconds ago.
 */
export async function fetchIsBoardMember(
  suiClient: ClientWithCoreApi,
  membersTableId: string,
  address: string,
): Promise<boolean> {
  const field = await suiClient.core
    .getDynamicField({
      parentId: membersTableId,
      name: { type: 'address', bcs: bcs.Address.serialize(address).toBytes() },
    })
    .catch(() => null)
  if (!field) return false
  try {
    const m = MemberBcs.parse(field.dynamicField.value.bcs)
    const last = m.tenures[m.tenures.length - 1]
    return !!last && last.left == null
  } catch {
    return false
  }
}

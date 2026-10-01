import { bcs } from '@mysten/sui/bcs'
import type { ClientWithCoreApi } from '@mysten/sui/client'

import type { ProposalConfig } from './governance'
import { normalizeMoveType } from './governance'

/**
 * Live on-chain reads the indexer cannot serve (DESIGN-ARMATURE.md §8): one
 * proposal's full state (A8), an OU's capability vault, its encrypted entries,
 * and a composite frame's step payloads.
 *
 * Cycle 7 DELETES a proposal when it executes or is cleaned up, so a live
 * `Proposal<P>` exists only while it is Active or Passed. "Not found" is
 * therefore an ordinary answer — executed or expired — and the indexer
 * (`ProposalCreated` / `ProposalExecuted` / `ProposalExpired` events) is the
 * only record after that.
 */

// ─── JSON helpers (transport-tolerant) ──────────────────────────────────────
//
// `Proposal<P>` cannot be BCS-decoded without knowing P's layout (the payload
// sits mid-struct), so this one read goes through JSON. gRPC proto-JSON
// exposes fields directly, JSON-RPC nests them under `.fields`; `asRecord`
// unwraps either.

/** @internal — unwrap a JSON-RPC `.fields` layer. */
export function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields)) {
    return o.fields as Record<string, unknown>
  }
  return o
}

function readNum(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return fallback
}

/** An `Option<T>` in any of the shapes transports render it. */
function readOption(v: unknown): unknown {
  if (v === null || v === undefined) return null
  const r = asRecord(v)
  if (r) {
    if (Array.isArray(r.vec)) return r.vec.length ? r.vec[0] : null
    if ('Some' in r) return r.Some
    if ('None' in r) return null
  }
  return v
}

/** A Move enum variant name from any rendering. */
function readVariant(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  if (!r) return undefined
  for (const k of ['@variant', 'variant', '$kind']) {
    if (typeof r[k] === 'string') return r[k] as string
  }
  const keys = Object.keys(r).filter((k) => k !== 'fields')
  return keys.length === 1 ? keys[0] : undefined
}

/** @internal — a `TypeName` JSON rendering → canonical Move type. */
export function readTypeName(v: unknown): string | undefined {
  const raw = typeof v === 'string' ? v : asRecord(v)?.name
  return typeof raw === 'string' && raw.includes('::')
    ? normalizeMoveType(raw)
    : undefined
}

/** A `ProposalConfig` from its JSON rendering. */
export function parseProposalConfigJson(v: unknown): ProposalConfig | null {
  const c = asRecord(v)
  if (!c) return null
  const scope = Array.isArray(c.borrow_scope) ? c.borrow_scope : []
  return {
    quorum: readNum(c.quorum),
    approvalThreshold: readNum(c.approval_threshold),
    proposeThreshold: readNum(c.propose_threshold),
    expiryMs: readNum(c.expiry_ms),
    executionDelayMs: readNum(c.execution_delay_ms),
    cooldownMs: readNum(c.cooldown_ms),
    composableAllowed: c.composable_allowed === true,
    permissions: readNum(c.permissions),
    borrowScope: scope
      .map(readTypeName)
      .filter((t): t is string => t !== undefined),
  }
}

/** The `P` of an object type `…::proposal::Proposal<P>`. */
export function payloadTypeOf(objectType: string): string | undefined {
  const open = objectType.indexOf('<')
  if (open < 0 || !objectType.endsWith('>')) return undefined
  return normalizeMoveType(objectType.slice(open + 1, -1))
}

// ─── Proposals ──────────────────────────────────────────────────────────────

/** A live `Proposal<P>` — everything a vote decision needs. */
export interface LiveProposal {
  proposalId: string
  /** The unit the proposal belongs to (votes and execution go there). */
  ouId: string
  /** The payload Move type `P` (0x-canonical). */
  payloadType: string
  /** The slot's display key at submission. */
  typeKey: string
  proposer: string
  metadataIpfs: string | null
  /** Decoded payload fields (transport JSON; `.fields` unwrapped at the top). */
  payload: Record<string, unknown>
  /** Roster version at creation; voters are the members at this version. */
  snapshotVersion: number
  /** Board size at creation — the quorum denominator. */
  totalSnapshotWeight: number
  /** Voter → approve. */
  votesCast: Record<string, boolean>
  yesWeight: number
  noWeight: number
  /** The type's config snapshotted at submission. */
  config: ProposalConfig
  createdAtMs: number
  passedAtMs: number | null
  /** Forward-only: Active → Passed. Executed / expired proposals no longer exist. */
  status: 'active' | 'passed'
  /** When voting closes (`created + expiry`). */
  votingDeadlineMs: number
  /** When a passed proposal becomes executable (`passed + delay`), else null. */
  executableFromMs: number | null
  /** When a passed proposal's execution window closes, else null. */
  executionDeadlineMs: number | null
}

/** Decode a proposal object's JSON (+ its object type) into a `LiveProposal`. */
export function parseLiveProposal(
  proposalId: string,
  objectType: string,
  json: Record<string, unknown>,
): LiveProposal {
  const j = asRecord(json) ?? {}
  const config = parseProposalConfigJson(j.config) ?? {
    quorum: 0,
    approvalThreshold: 0,
    proposeThreshold: 0,
    expiryMs: 0,
    executionDelayMs: 0,
    cooldownMs: 0,
    composableAllowed: false,
  }
  const votes: Record<string, boolean> = {}
  const vm = asRecord(j.votes_cast)?.contents
  if (Array.isArray(vm)) {
    for (const e of vm) {
      const r = asRecord(e)
      if (r && typeof r.key === 'string') votes[r.key] = r.value === true
    }
  }
  const createdAtMs = readNum(j.created_at_ms)
  const passedRaw = readOption(j.passed_at_ms)
  const passedAtMs = passedRaw == null ? null : readNum(passedRaw)
  const variant = readVariant(j.status)
  const status: LiveProposal['status'] =
    variant === 'Passed' || passedAtMs != null ? 'passed' : 'active'
  const meta = readOption(j.metadata_ipfs)
  return {
    proposalId,
    ouId: String(j.ou_id ?? ''),
    payloadType: payloadTypeOf(objectType) ?? '',
    typeKey: String(j.type_key ?? ''),
    proposer: String(j.proposer ?? ''),
    metadataIpfs: typeof meta === 'string' ? meta : null,
    payload: asRecord(j.payload) ?? {},
    snapshotVersion: readNum(j.snapshot_version),
    totalSnapshotWeight: readNum(j.total_snapshot_weight),
    votesCast: votes,
    yesWeight: readNum(j.yes_weight),
    noWeight: readNum(j.no_weight),
    config,
    createdAtMs,
    passedAtMs,
    status,
    votingDeadlineMs: createdAtMs + config.expiryMs,
    executableFromMs:
      passedAtMs == null ? null : passedAtMs + config.executionDelayMs,
    executionDeadlineMs:
      passedAtMs == null
        ? null
        : passedAtMs + config.executionDelayMs + config.expiryMs,
  }
}

/**
 * The live proposal, or null when it no longer exists on-chain (cycle 7:
 * executed or expired-and-deleted — the indexer has the outcome).
 */
export async function fetchProposal(
  suiClient: ClientWithCoreApi,
  proposalId: string,
): Promise<LiveProposal | null> {
  let object: { type: string; json: Record<string, unknown> | null }
  try {
    ;({ object } = await suiClient.core.getObject({
      objectId: proposalId,
      include: { json: true },
    }))
  } catch {
    return null
  }
  if (
    !object ||
    !object.json ||
    !object.type.includes('::proposal::Proposal<')
  ) {
    return null
  }
  return parseLiveProposal(proposalId, object.type, object.json)
}

/** Whether `delete_expired_proposal` would succeed at `nowMs`. */
export function isDeletable(p: LiveProposal, nowMs = Date.now()): boolean {
  if (p.status === 'active') return nowMs >= p.votingDeadlineMs
  return p.executionDeadlineMs != null && nowMs >= p.executionDeadlineMs
}

/** Whether `ticket_from_vote` would pass its timing checks at `nowMs`. */
export function isExecutable(p: LiveProposal, nowMs = Date.now()): boolean {
  return (
    p.status === 'passed' &&
    p.executableFromMs != null &&
    p.executionDeadlineMs != null &&
    nowMs >= p.executableFromMs &&
    nowMs < p.executionDeadlineMs
  )
}

// ─── Capability vault ───────────────────────────────────────────────────────

const CapabilityVaultBcs = bcs.struct('CapabilityVault', {
  id: bcs.Address,
  ou_id: bcs.Address,
  cap_types: bcs.struct('VecSet', { contents: bcs.vector(bcs.string()) }),
  cap_ids: bcs.struct('VecSet', { contents: bcs.vector(bcs.Address) }),
  ids_by_type: bcs.struct('VecMap', {
    contents: bcs.vector(
      bcs.struct('Entry', {
        key: bcs.string(),
        value: bcs.vector(bcs.Address),
      }),
    ),
  }),
})

/** What an OU's `CapabilityVault` holds. */
export interface CapabilityVaultContents {
  vaultId: string
  ouId: string
  /** Every stored capability id. */
  capIds: string[]
  /** Canonical cap Move type → ids (`SubOUControl`, `TreasuryCap<T>`, `ExternalExecutionCap<P>`, …). */
  byType: Map<string, string[]>
}

/** Decode a `CapabilityVault`'s BCS content. */
export function parseCapabilityVault(
  content: Uint8Array,
): CapabilityVaultContents {
  const v = CapabilityVaultBcs.parse(content)
  return {
    vaultId: v.id,
    ouId: v.ou_id,
    capIds: v.cap_ids.contents,
    byType: new Map(
      v.ids_by_type.contents.map((e) => [normalizeMoveType(e.key), e.value]),
    ),
  }
}

/** Read an OU's capability vault. */
export async function fetchCapabilityVault(
  suiClient: ClientWithCoreApi,
  vaultId: string,
): Promise<CapabilityVaultContents> {
  const { object } = await suiClient.core.getObject({
    objectId: vaultId,
    include: { content: true },
  })
  return parseCapabilityVault(object.content)
}

/** The Move type a capability id is registered under, if the vault holds it. */
export function capTypeOf(
  vault: CapabilityVaultContents,
  capId: string,
): string | undefined {
  const want = capId.toLowerCase()
  for (const [type, ids] of vault.byType) {
    if (ids.some((id) => id.toLowerCase() === want)) return type
  }
  return undefined
}

// ─── Encrypted entries ──────────────────────────────────────────────────────

const EncryptedEntryBcs = bcs.struct('EncryptedEntry', {
  id: bcs.Address,
  ou_id: bcs.Address,
  location: bcs.string(),
  description: bcs.string(),
  created_by: bcs.Address,
  encrypt_epoch: bcs.u64(),
})

/** One `EncryptedEntry` — a pointer to a Seal-encrypted blob for the board. */
export interface EncryptedEntry {
  entryId: string
  ouId: string
  /** Where the ciphertext lives (e.g. a Walrus blob id). */
  location: string
  description: string
  createdBy: string
  /** The epoch the blob was encrypted under. */
  encryptEpoch: number
  /** True when the OU's epoch has moved on — re-encrypt and `update`. */
  stale: boolean
}

/** Read entries by id (the OU root lists them: `OuState.entries`). */
export async function fetchEncryptedEntries(
  suiClient: ClientWithCoreApi,
  entryIds: string[],
  currentEpoch: number,
): Promise<EncryptedEntry[]> {
  if (entryIds.length === 0) return []
  const out: EncryptedEntry[] = []
  for (let i = 0; i < entryIds.length; i += 50) {
    const { objects } = await suiClient.core.getObjects({
      objectIds: entryIds.slice(i, i + 50),
      include: { content: true },
    })
    for (const o of objects) {
      if (o instanceof Error || !o.content) continue
      const e = EncryptedEntryBcs.parse(o.content)
      const epoch = Number(e.encrypt_epoch)
      out.push({
        entryId: e.id,
        ouId: e.ou_id,
        location: e.location,
        description: e.description,
        createdBy: e.created_by,
        encryptEpoch: epoch,
        stale: epoch !== currentEpoch,
      })
    }
  }
  return out
}

// ─── Composite frames ───────────────────────────────────────────────────────

/**
 * One composite step's payload JSON, read from the frame's `StepKey { index }`
 * dynamic field, or undefined when it has already been extracted. Needed only
 * for step types whose handler takes objects named IN the payload (a
 * cross-OU send's target treasury, a controller step's child unit).
 */
export async function fetchFrameStepPayload(
  suiClient: ClientWithCoreApi,
  frameId: string,
  index: number,
): Promise<Record<string, unknown> | undefined> {
  let fieldId: string | undefined
  let cursor: string | null = null
  do {
    const page = await suiClient.core.listDynamicFields({
      parentId: frameId,
      cursor,
    })
    for (const df of page.dynamicFields) {
      if (!df.name.type.endsWith('::composite::StepKey')) continue
      const idx = Number(bcs.u64().parse(df.name.bcs))
      if (idx === index) fieldId = df.fieldId
    }
    cursor = page.hasNextPage && !fieldId ? page.cursor : null
  } while (cursor !== null)
  if (!fieldId) return undefined
  const { object } = await suiClient.core.getObject({
    objectId: fieldId,
    include: { json: true },
  })
  return asRecord(asRecord(object.json)?.value)
}

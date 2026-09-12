import type { ClientWithCoreApi } from '@mysten/sui/client'

/**
 * A DAO's governance state, read from the live object.
 *
 * The indexer does not serve any of this, and it has to be head-current: a
 * config change and an action can land in the same session, and the resolver's
 * answer is only ever as correct as the config it read
 * (DESIGN-ARMATURE.md §8).
 */

/** One proposal type's voting rules, in basis points / milliseconds. */
export interface ProposalConfig {
  /** Share of TOTAL board weight that must vote, in bps (10000 = 100%). */
  quorum: number
  /** Share of CAST weight that must approve, in bps. */
  approvalThreshold: number
  proposeThreshold: number
  expiryMs: number
  /** Non-zero forbids atomic execute — `submit_vote_execute` asserts this. */
  executionDelayMs: number
  cooldownMs: number
  /**
   * Whether this type may appear as a step inside a `Composite` proposal.
   * `add_step` rejects types without it, so `canComposite()` consults it before
   * a cart is bundled.
   */
  composableAllowed: boolean
}

/** Which proposal types a DAO has enabled, and the rules for each. */
export interface DaoGovernance {
  enabledTypes: Set<string>
  /** `type_key` → config. Mirrors `enabledTypes`; enable/disable touch both. */
  configs: Map<string, ProposalConfig>
  /**
   * `type_key` → the fully-qualified Move type bound to it.
   *
   * On-chain a `type_key` is a bare ascii name (`SetBoard`) while the type
   * argument is qualified (`0xPKG::set_board::SetBoard`); this map is what
   * connects them. Not every enabled type has a binding — framework types with
   * no payload struct have none — so lookups may legitimately miss.
   */
  typeBindings: Map<string, string>
}

// ─── Parsing ────────────────────────────────────────────────────────────────
//
// Move structs cross the wire in two shapes: gRPC proto-JSON exposes fields
// directly (`{ contents: [...] }`), JSON-RPC nests them under `.fields`. Every
// parser here goes through `asRecord`, which unwraps the `.fields` layer when
// present, so both transports parse identically.

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields)) {
    return o.fields as Record<string, unknown>
  }
  return o
}

/** u16 fields arrive as numbers; u64 fields (delay/expiry/cooldown) as strings. */
function readInt(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return fallback
}

/** Parse a DAO object's `proposal_configs` VecMap into `type_key → config`. */
export function parseProposalConfigs(
  daoJson: Record<string, unknown>,
): Map<string, ProposalConfig> {
  const out = new Map<string, ProposalConfig>()
  const contents = asRecord(daoJson.proposal_configs)?.contents
  if (!Array.isArray(contents)) return out

  for (const entry of contents) {
    const e = asRecord(entry)
    const key = e?.key
    const val = asRecord(e?.value)
    if (typeof key !== 'string' || !val) continue
    out.set(key, {
      quorum: readInt(val.quorum),
      approvalThreshold: readInt(val.approval_threshold),
      proposeThreshold: readInt(val.propose_threshold),
      expiryMs: readInt(val.expiry_ms),
      executionDelayMs: readInt(val.execution_delay_ms),
      cooldownMs: readInt(val.cooldown_ms),
      // Bool arrives natively on both transports; absent means false.
      composableAllowed: val.composable_allowed === true,
    })
  }
  return out
}

/** Parse a DAO object's `type_bindings` VecMap into `type_key → Move type`. */
export function parseTypeBindings(
  daoJson: Record<string, unknown>,
): Map<string, string> {
  const out = new Map<string, string>()
  const contents = asRecord(daoJson.type_bindings)?.contents
  if (!Array.isArray(contents)) return out

  for (const entry of contents) {
    const e = asRecord(entry)
    const key = e?.key
    const val = e?.value
    if (typeof key === 'string' && typeof val === 'string') out.set(key, val)
  }
  return out
}

/** Parse a DAO object's `enabled_proposal_types` VecSet into a set of keys. */
export function parseEnabledProposalTypes(
  daoJson: Record<string, unknown>,
): Set<string> {
  const contents = asRecord(daoJson.enabled_proposal_types)?.contents
  if (!Array.isArray(contents)) return new Set<string>()
  return new Set<string>(
    contents.filter((c): c is string => typeof c === 'string'),
  )
}

// ─── The single-vote predicate ──────────────────────────────────────────────

/**
 * Can ONE board member's vote pass and execute a proposal of this config in a
 * single transaction (`board_voting::submit_vote_execute`)?
 *
 * Board voting is weight-1 per member, so with N members a lone vote is 1/N of
 * total weight. It meets quorum iff `1 × 10000 ≥ N × quorum`. The approval
 * threshold is always satisfied — one 100%-yes vote clears any threshold ≤ 100%
 * — so quorum is the only gate, plus the config must permit atomic execution
 * (`executionDelayMs === 0`, asserted on-chain).
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
  return boardSize * config.quorum <= 10_000
}

// ─── Network reads ──────────────────────────────────────────────────────────

/** Read a DAO's enabled types, per-type configs, and bindings in one fetch. */
export async function fetchDaoGovernance(
  suiClient: ClientWithCoreApi,
  daoId: string,
): Promise<DaoGovernance> {
  const { object } = await suiClient.core.getObject({
    objectId: daoId,
    include: { json: true },
  })
  const json = (object.json ?? {}) as Record<string, unknown>
  return {
    enabledTypes: parseEnabledProposalTypes(json),
    configs: parseProposalConfigs(json),
    typeBindings: parseTypeBindings(json),
  }
}

/** One proposal type's config, or null when the type is not enabled. */
export async function fetchProposalConfig(
  suiClient: ClientWithCoreApi,
  daoId: string,
  typeKey: string,
): Promise<ProposalConfig | null> {
  const { configs } = await fetchDaoGovernance(suiClient, daoId)
  return configs.get(typeKey) ?? null
}

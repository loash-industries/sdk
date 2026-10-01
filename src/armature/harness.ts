import type { Transaction } from '@mysten/sui/transactions'

import type { DaoGovernance, OuState, ProposalConfig } from './governance'
import {
  hasPermissions,
  normalizeMoveType,
  PERMISSIONS,
  slotForType,
} from './governance'
import type { OuExecContext } from './types'

/**
 * The strategy resolver — the load-bearing piece of the Armature module
 * (DESIGN-ARMATURE.md §7).
 *
 * Given an action, a unit's board/parent context, the relevant on-chain
 * configs, and the caller, decide HOW to pass it: preferring one transaction
 * now, falling back to a governance proposal only when the action allows it.
 *
 * Everything here is PURE — no I/O, and no Sui runtime beyond a type import —
 * so the whole ladder is exhaustively unit-testable and can be green long
 * before a transaction is ever signed. Turning a strategy into a `Transaction`
 * is `plan.ts`'s job, deliberately not this module's.
 *
 * Cycle 7 added four on-chain gates the ladder now models, each of which
 * would otherwise surface as an abort AFTER the caller signed: per-type
 * permission bits (+ borrow scope), execution / controller pause, the
 * emergency freeze (keyed by Move type), and per-type cooldown.
 */

type TxArg = ReturnType<Transaction['moveCall']>

export type Strategy =
  /** A — `submit_vote_execute` on the unit itself. */
  | 'own-execute'
  /** B — parent `submit_vote_execute` of a `Control*` payload. */
  | 'control-execute'
  /** C — `submit_proposal` on the unit (deferred). */
  | 'own-propose'
  /** D — parent `submit_proposal` of a `Control*` payload (deferred). */
  | 'control-propose'

/**
 * Why nothing could carry an action.
 *
 * - `not-member` — the caller sits on neither board.
 * - `needs-slow-tier` — only a governance proposal could carry it, and the
 *   action is `single-vote-only`.
 * - `not-permitted` — the type is not enabled, or no member can propose it.
 * - `missing-permissions` — the type IS enabled but its slot lacks the
 *   permission bits / borrow scope its handler needs; it would abort at
 *   execution (`proposal::EPermissionDenied` / `EBorrowScopeDenied`).
 * - `paused` — the executing unit is execution- or controller-paused, or
 *   migrating.
 * - `frozen` — the payload type is frozen on the executing unit.
 * - `cooldown` — the type executed too recently.
 */
export type BlockCode =
  | 'not-member'
  | 'needs-slow-tier'
  | 'not-permitted'
  | 'missing-permissions'
  | 'paused'
  | 'frozen'
  | 'cooldown'

/**
 * The on-chain facts the resolver needs; null config means "not enabled on
 * that unit". Everything past the two configs is optional: absent facts are
 * simply not checked, which is how a caller with only the configs in hand gets
 * the cycle-6 behaviour.
 */
export interface OuCapabilities {
  ownConfig: ProposalConfig | null
  controlConfig: ProposalConfig | null
  /** Last execution of the own type on the unit — for its cooldown. */
  ownLastExecutedMs?: number | null
  /** Last execution of the control type on the parent — for its cooldown. */
  controlLastExecutedMs?: number | null
  /** The unit's root flags (pause, migration, head-current board size). */
  ownState?: OuState
  /** The parent's root flags — the control strategies execute there. */
  parentState?: OuState
  /** Freeze expiry (epoch ms) of the own payload type on the unit, if frozen. */
  ownFrozenUntil?: number | null
  /** Freeze expiry of the control payload type on the parent, if frozen. */
  controlFrozenUntil?: number | null
  /** Head-current membership on the unit's board; overrides `ctx.board`. */
  callerOnOwnBoard?: boolean
  /** Head-current membership on the parent's board; overrides `ctx.parent.board`. */
  callerOnParentBoard?: boolean
  /** "Now" for the cooldown / freeze checks. Defaults to `Date.now()`. */
  nowMs?: number
}

/** The own-governance path — submit on the unit itself. Enables A and C. */
export interface OuOwnAdapter {
  /**
   * The slot's display key on the OWN unit. Cycle 7 keys slots by Move type,
   * so this is only the fallback for config lookup and a label for traces.
   */
  typeKey: string
  /** Type argument for `submit_*` on the own unit — the slot key. */
  payloadMoveType: string
  buildPayload: (tx: Transaction) => TxArg
  /** The domain `execute_*` call consuming the own-unit ticket (strategy A). */
  buildExecute: (tx: Transaction, ticket: TxArg, ownDaoId: string) => void
  /**
   * Permission bits the handler needs (`armature::permissions`). Framework
   * types hold theirs on-chain by construction, so leave it unset for them.
   */
  requiredPermissions?: number
  /** Capability Move types the handler borrows (`borrow_scope`). */
  requiredBorrowScope?: string[]
}

/**
 * The `Control*` path — a parent acting on a child through its `SubOUControl`
 * cap. Enables B and D. Present only where a wired handler exists.
 */
export interface OuControlAdapter {
  typeKey: string
  payloadMoveType: string
  /** The harness supplies `controlCapId` from the parent linkage. */
  buildPayload: (tx: Transaction, controlCapId: string) => TxArg
  /** The `subou_ops::execute_*` call consuming the ticket on the child. */
  buildExecute: (
    tx: Transaction,
    ticket: TxArg,
    capVaultId: string,
    childDaoId: string,
  ) => void
  requiredPermissions?: number
  requiredBorrowScope?: string[]
}

/** A governance action, independent of which strategy ends up carrying it. */
export interface OuProposalAction {
  /** Stable identifier — used for logs and cache invalidation. */
  kind: string
  /** Own-unit path (A/C). Absent for control-only actions (e.g. pausing a child). */
  own?: OuOwnAdapter
  /** Control path (B/D). Absent when no `Control*` handler exists. */
  control?: OuControlAdapter
  /**
   * Whether the action may degrade into a slow proposal. Defaults to
   * `fall-back-to-proposal`; `single-vote-only` blocks instead, for actions
   * where a week-long deferral would be a surprise rather than a service.
   */
  fallbackPolicy?: 'fall-back-to-proposal' | 'single-vote-only'
  /**
   * True when the payload GRANTS permission bits or borrow scope (an
   * `EnableProposalType` whose config holds bits, an `UpdateProposalConfig`
   * that changes them). Grants are standalone-only on-chain, so such an
   * action can never be a composite step (`composite::EGrantInComposite`).
   */
  grantsPermissions?: boolean
}

export interface ExecutionPlan {
  blocked: false
  strategy: Strategy
  /** True for the single-transaction strategies (A/B). */
  immediate: boolean
  /** The board that actually votes on this strategy — own or parent. */
  voterBoardSize: number
  /**
   * Cycle 7 — whether the immediate strategy can use the `_readonly` entry
   * point (`submit_vote_execute_readonly`, cooldown 0): the OU then enters the
   * PTB as an immutable input and concurrent executions stop contending on it.
   */
  readonly?: boolean
  reason: string
  buildTx: () => Transaction
}

export interface BlockedPlan {
  blocked: true
  code: BlockCode
  reason: string
}

export type ResolvedPlan = ExecutionPlan | BlockedPlan

// ─── Strategy selection ─────────────────────────────────────────────────────

const onBoard = (addr: string | undefined, board: string[]): boolean =>
  !!addr && board.some((a) => a.toLowerCase() === addr.toLowerCase())

export type StrategyDecision =
  | {
      blocked: false
      strategy: Strategy
      immediate: boolean
      voterBoardSize: number
      readonly?: boolean
      reason: string
    }
  | { blocked: true; code: BlockCode; reason: string }

export type PathTier = 'immediate' | 'slow'

/** One strategy's viability plus a short explanation, for tracing. */
export interface PathCandidate {
  strategy: Strategy
  tier: PathTier
  voterBoardSize: number
  viable: boolean
  /** False when the action has no adapter for this strategy at all. */
  applicable: boolean
  detail: string
  /** Why it is not viable, as a block code. Absent when viable. */
  blocker?: BlockCode
}

const WINNER_REASON: Record<Strategy, string> = {
  'own-execute': 'Your single vote satisfies this unit’s quorum.',
  'control-execute':
    'Your single vote on the parent unit can apply this to the child.',
  'own-propose': 'Creates a proposal for this unit’s board to vote on.',
  'control-propose':
    'Creates a proposal for the parent unit’s board to vote on.',
}

/** Bit names, for the "missing permissions" trace. */
function bitNames(bits: number): string {
  return (
    Object.entries(PERMISSIONS)
      .filter(([, b]) => (bits & b) !== 0)
      .map(([n]) => n)
      .join('|') || '0'
  )
}

const isTransferAssets = (moveType: string): boolean =>
  normalizeMoveType(moveType).endsWith('::transfer_assets::TransferAssets')

/** The facts one candidate is judged on. */
interface Facts {
  member: boolean
  config: ProposalConfig | null
  boardSize: number
  state?: OuState
  lastExecutedMs?: number | null
  frozenUntil?: number | null
  adapter?: { payloadMoveType: string } & Pick<
    OuOwnAdapter,
    'requiredPermissions' | 'requiredBorrowScope'
  >
  now: number
}

type Verdict =
  | { viable: true; detail: string }
  | {
      viable: false
      detail: string
      blocker: BlockCode
    }

/** Checks shared by both tiers — the ones `submit_proposal` itself asserts. */
function proposable(f: Facts): Verdict | null {
  if (!f.member) {
    return {
      viable: false,
      detail: 'caller not on that board',
      blocker: 'not-member',
    }
  }
  if (!f.config) {
    return {
      viable: false,
      detail: 'type not enabled on that unit',
      blocker: 'not-permitted',
    }
  }
  if (
    f.state?.status === 'migrating' &&
    !(f.adapter && isTransferAssets(f.adapter.payloadMoveType))
  ) {
    return {
      viable: false,
      detail: 'unit is migrating — only TransferAssets may run',
      blocker: 'paused',
    }
  }
  const need = f.adapter?.requiredPermissions ?? 0
  const have = f.config.permissions ?? 0
  if (need && !hasPermissions(have, need)) {
    return {
      viable: false,
      detail: `type lacks permission bits ${bitNames(need & ~have)} — its handler would abort (EPermissionDenied)`,
      blocker: 'missing-permissions',
    }
  }
  const scope = (f.config.borrowScope ?? []).map(normalizeMoveType)
  const missingScope = (f.adapter?.requiredBorrowScope ?? [])
    .map(normalizeMoveType)
    .filter((t) => !scope.includes(t))
  if (missingScope.length > 0) {
    return {
      viable: false,
      detail: `type's borrow scope lacks ${missingScope.join(', ')} (EBorrowScopeDenied)`,
      blocker: 'missing-permissions',
    }
  }
  if (f.config.proposeThreshold > 1) {
    return {
      viable: false,
      detail: `propose threshold ${f.config.proposeThreshold} exceeds a member's weight of 1`,
      blocker: 'not-permitted',
    }
  }
  return null
}

/** Why a single-vote-execute path is (or is not) viable. */
function judgeExecute(f: Facts): Verdict {
  const base = proposable(f)
  if (base) return base
  const config = f.config!
  if (config.executionDelayMs !== 0) {
    return {
      viable: false,
      detail: `execution delay ${config.executionDelayMs}ms forbids atomic execute`,
      blocker: 'needs-slow-tier',
    }
  }
  if (f.boardSize <= 0 || f.boardSize * config.quorum > 10_000) {
    return {
      viable: false,
      detail: `quorum ${config.quorum}bps × ${f.boardSize} members > 10000 → needs a full vote`,
      blocker: 'needs-slow-tier',
    }
  }
  if (f.state?.executionPaused) {
    return {
      viable: false,
      detail: 'unit execution is paused',
      blocker: 'paused',
    }
  }
  if (f.state?.controllerPaused) {
    return {
      viable: false,
      detail: 'unit is paused by its parent (PauseSubOUExecution)',
      blocker: 'paused',
    }
  }
  if (f.frozenUntil != null && f.now < f.frozenUntil) {
    return {
      viable: false,
      detail: `type is frozen until ${new Date(f.frozenUntil).toISOString()}`,
      blocker: 'frozen',
    }
  }
  if (
    config.cooldownMs > 0 &&
    f.lastExecutedMs != null &&
    f.now < f.lastExecutedMs + config.cooldownMs
  ) {
    return {
      viable: false,
      detail: `cooldown active until ${new Date(f.lastExecutedMs + config.cooldownMs).toISOString()}`,
      blocker: 'cooldown',
    }
  }
  return {
    viable: true,
    detail: `single vote clears quorum (${config.quorum}bps × ${f.boardSize})`,
  }
}

/** Whether a deferred proposal can be submitted. */
function judgePropose(f: Facts, label: string): Verdict {
  return proposable(f) ?? { viable: true, detail: `${label} board can vote` }
}

function candidate(
  strategy: Strategy,
  tier: PathTier,
  voterBoardSize: number,
  v: Verdict | undefined,
  missing: string,
): PathCandidate {
  if (!v) {
    return {
      strategy,
      tier,
      voterBoardSize,
      viable: false,
      applicable: false,
      detail: missing,
    }
  }
  return v.viable
    ? {
        strategy,
        tier,
        voterBoardSize,
        viable: true,
        applicable: true,
        detail: v.detail,
      }
    : {
        strategy,
        tier,
        voterBoardSize,
        viable: false,
        applicable: true,
        detail: v.detail,
        blocker: v.blocker,
      }
}

/**
 * Evaluate every strategy's viability independently, in priority order.
 *
 * Pure, and deliberately separate from `selectStrategy` — which picks the first
 * viable entry from THIS SAME array. One list feeding both means a trace can
 * never disagree with the decision it is supposed to explain.
 */
export function evaluatePaths(
  action: OuProposalAction,
  ctx: OuExecContext,
  caps: OuCapabilities,
  caller: string | undefined,
): PathCandidate[] {
  const now = caps.nowMs ?? Date.now()
  const onOwn = caps.callerOnOwnBoard ?? onBoard(caller, ctx.board)
  const hasControl = !!action.control && !!ctx.parent
  const onParent =
    hasControl &&
    (caps.callerOnParentBoard ?? onBoard(caller, ctx.parent!.board))
  const ownSize = caps.ownState?.memberCount ?? ctx.board.length
  const parentSize =
    caps.parentState?.memberCount ?? ctx.parent?.board.length ?? 0

  const own: Facts | undefined = action.own
    ? {
        member: onOwn,
        config: caps.ownConfig,
        boardSize: ownSize,
        state: caps.ownState,
        lastExecutedMs: caps.ownLastExecutedMs,
        frozenUntil: caps.ownFrozenUntil,
        adapter: action.own,
        now,
      }
    : undefined
  const control: Facts | undefined = hasControl
    ? {
        member: onParent,
        config: caps.controlConfig,
        boardSize: parentSize,
        state: caps.parentState,
        lastExecutedMs: caps.controlLastExecutedMs,
        frozenUntil: caps.controlFrozenUntil,
        adapter: action.control,
        now,
      }
    : undefined

  const noOwn = 'no own adapter for this action'
  const noControl = 'no control adapter / parent unit'

  return [
    candidate(
      'own-execute',
      'immediate',
      ownSize,
      own && judgeExecute(own),
      noOwn,
    ),
    candidate(
      'control-execute',
      'immediate',
      parentSize,
      control && judgeExecute(control),
      noControl,
    ),
    candidate(
      'own-propose',
      'slow',
      ownSize,
      own && judgePropose(own, 'unit'),
      noOwn,
    ),
    candidate(
      'control-propose',
      'slow',
      parentSize,
      control && judgePropose(control, 'parent'),
      noControl,
    ),
  ]
}

/** Most specific first: what a caller can act on beats a generic refusal. */
const BLOCKER_PRECEDENCE: BlockCode[] = [
  'missing-permissions',
  'paused',
  'frozen',
  'cooldown',
  'needs-slow-tier',
  'not-permitted',
]

function pickBlocker(cands: PathCandidate[]): PathCandidate | undefined {
  for (const code of BLOCKER_PRECEDENCE) {
    const hit = cands.find((c) => c.blocker === code)
    if (hit) return hit
  }
  return undefined
}

const NOT_MEMBER_REASON = 'You are not on this unit’s board (or its parent’s).'

/**
 * Pick the highest-priority viable strategy: A → B → (fallback gate) → C → D.
 *
 * Blocking is a VALUE, not a throw: "you are not on this board" is an ordinary
 * answer to "can I do this?", and callers branch on it the same way they branch
 * on a chosen strategy. When several things stand in the way, the code names
 * the most actionable one (a missing permission bit before a pause before a
 * cooldown before "needs a vote").
 */
export function selectStrategy(
  action: OuProposalAction,
  ctx: OuExecContext,
  caps: OuCapabilities,
  caller: string | undefined,
): StrategyDecision {
  const candidates = evaluatePaths(action, ctx, caps, caller).filter(
    (c) => c.applicable,
  )
  const pick = (c: PathCandidate): StrategyDecision => {
    const config =
      c.strategy === 'own-execute'
        ? caps.ownConfig
        : c.strategy === 'control-execute'
          ? caps.controlConfig
          : null
    return {
      blocked: false,
      strategy: c.strategy,
      immediate: c.tier === 'immediate',
      voterBoardSize: c.voterBoardSize,
      readonly: !!config && config.cooldownMs === 0,
      reason: WINNER_REASON[c.strategy],
    }
  }

  const immediate = candidates.find((c) => c.tier === 'immediate' && c.viable)
  if (immediate) return pick(immediate)

  if (candidates.length === 0) {
    return {
      blocked: true,
      code: 'not-permitted',
      reason: action.control
        ? 'This action is applied by a parent unit, and this unit has none (or no linked control).'
        : 'This action has no adapter for this unit.',
    }
  }
  if (candidates.every((c) => c.blocker === 'not-member')) {
    return { blocked: true, code: 'not-member', reason: NOT_MEMBER_REASON }
  }

  // Fallback gate — some actions refuse to degrade to a slow proposal.
  if (action.fallbackPolicy === 'single-vote-only') {
    const why = pickBlocker(
      candidates.filter(
        (c) => c.tier === 'immediate' && c.blocker !== 'needs-slow-tier',
      ),
    )
    if (why && why.blocker !== 'not-permitted') {
      return {
        blocked: true,
        code: why.blocker!,
        reason: `No single-vote path: ${why.detail}.`,
      }
    }
    return {
      blocked: true,
      code: 'needs-slow-tier',
      reason:
        'No single-vote path is available and this action does not allow a governance proposal.',
    }
  }

  const slow = candidates.find((c) => c.tier === 'slow' && c.viable)
  if (slow) return pick(slow)

  const why =
    pickBlocker(candidates.filter((c) => c.tier === 'slow')) ??
    pickBlocker(candidates)
  if (why && why.blocker !== 'not-permitted') {
    return { blocked: true, code: why.blocker!, reason: `${why.detail}.` }
  }
  return {
    blocked: true,
    code: 'not-permitted',
    reason: why
      ? `This action isn’t available for your unit right now: ${why.detail}.`
      : 'This action isn’t available for your unit right now.',
  }
}

// ─── Capabilities from a governance read ────────────────────────────────────

/**
 * Assemble the resolver's `OuCapabilities` for one action from the unit's
 * (and its parent's) governance reads. Pure — the handle does the I/O.
 */
export function capabilitiesFor(
  action: OuProposalAction,
  own: DaoGovernance | undefined,
  parent: DaoGovernance | undefined,
  opts: {
    aliases?: ReadonlyMap<string, string>
    nowMs?: number
    callerOnOwnBoard?: boolean
    callerOnParentBoard?: boolean
  } = {},
): OuCapabilities {
  const ownSlot = action.own
    ? slotForType(own, action.own.payloadMoveType, {
        displayKey: action.own.typeKey,
        aliases: opts.aliases,
      })
    : undefined
  const controlSlot = action.control
    ? slotForType(parent, action.control.payloadMoveType, {
        displayKey: action.control.typeKey,
        aliases: opts.aliases,
      })
    : undefined
  return {
    ownConfig: ownSlot?.config ?? null,
    controlConfig: controlSlot?.config ?? null,
    ownLastExecutedMs: ownSlot?.lastExecutedMs ?? null,
    controlLastExecutedMs: controlSlot?.lastExecutedMs ?? null,
    ownState: own?.state,
    parentState: parent?.state,
    ownFrozenUntil: ownSlot
      ? (own?.freeze?.frozenTypes.get(ownSlot.typeName) ?? null)
      : null,
    controlFrozenUntil: controlSlot
      ? (parent?.freeze?.frozenTypes.get(controlSlot.typeName) ?? null)
      : null,
    callerOnOwnBoard: opts.callerOnOwnBoard,
    callerOnParentBoard: opts.callerOnParentBoard,
    nowMs: opts.nowMs,
  }
}

// ─── Composite eligibility ──────────────────────────────────────────────────
//
// A cart of same-tier propose actions can collapse into ONE
// Proposal<CompositePayload> instead of N submit_proposal calls. That is a
// BATCH concern, not a fifth strategy — so `selectStrategy` stays untouched and
// this decides only *whether* the bundle is legal.

/** Max steps in one composite — mirrors `composite::MAX_COMPOSITE_STEPS`. */
export const MAX_COMPOSITE_STEPS = 16

/** The display key composites are submitted under (a default slot since cycle 7). */
export const COMPOSITE_TYPE_KEY = 'Composite'

/** Why a cart cannot be bundled into a single composite. */
export type CompositeIneligibility =
  /** 0–1 actions — nothing to bundle. */
  | 'single-action'
  /** More than `MAX_COMPOSITE_STEPS`. */
  | 'too-many-steps'
  /** The unit has no `Composite` slot. */
  | 'composite-disabled'
  /** A step lacks an own adapter, or its type is not `composableAllowed`. */
  | 'step-not-composable'
  /**
   * A step would grant permission bits / borrow scope (an `EnableProposalType`
   * whose new config holds bits) — grants are standalone-only on-chain
   * (`composite::EGrantInComposite`).
   */
  | 'grant-in-composite'

export interface CompositeEligibility {
  eligible: boolean
  reason?: CompositeIneligibility
}

/**
 * Can `actions` be submitted as one composite proposal on the unit?
 *
 * On-chain (`armature::composite`) requires the `Composite` slot on the unit,
 * every step type `composableAllowed`, no step granting permission bits, and
 * ≤ 16 steps. Composite runs only against the unit's OWN pipeline — there is
 * no control-composite — so every action must carry an own adapter, and the
 * caller pairs this with an `own-propose` strategy. `gov` is the unit's own
 * governance.
 */
export function canComposite(
  actions: OuProposalAction[],
  gov: DaoGovernance | undefined,
  aliases?: ReadonlyMap<string, string>,
): CompositeEligibility {
  if (actions.length <= 1) return { eligible: false, reason: 'single-action' }
  if (actions.length > MAX_COMPOSITE_STEPS) {
    return { eligible: false, reason: 'too-many-steps' }
  }
  const hasComposite =
    !!gov &&
    (gov.enabledTypes.has(COMPOSITE_TYPE_KEY) ||
      !!gov.slots?.some((s) =>
        s.typeName.endsWith('::composite_payload::CompositePayload'),
      ))
  if (!hasComposite) return { eligible: false, reason: 'composite-disabled' }
  if (actions.some((a) => a.grantsPermissions)) {
    return { eligible: false, reason: 'grant-in-composite' }
  }
  const allComposable = actions.every((a) => {
    if (!a.own) return false
    const slot = slotForType(gov, a.own.payloadMoveType, {
      displayKey: a.own.typeKey,
      aliases,
    })
    return !!slot && slot.config.composableAllowed
  })
  if (!allComposable) {
    return { eligible: false, reason: 'step-not-composable' }
  }
  return { eligible: true }
}

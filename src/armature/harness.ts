import type { Transaction } from '@mysten/sui/transactions'

import type { DaoGovernance, ProposalConfig } from './governance'
import { singleVoteExecutable } from './governance'
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

export type BlockCode = 'not-member' | 'needs-slow-tier' | 'not-permitted'

/** Per-type configs the resolver needs; null means "not enabled on that DAO". */
export interface OuCapabilities {
  ownConfig: ProposalConfig | null
  controlConfig: ProposalConfig | null
}

/** The own-governance path — submit on the unit itself. Enables A and C. */
export interface OuOwnAdapter {
  /** Proposal `type_key` submitted on the OWN DAO (drives config lookup). */
  typeKey: string
  /** Type argument for `submit_*` on the own DAO. */
  payloadMoveType: string
  buildPayload: (tx: Transaction) => TxArg
  /** The domain `execute_*` call consuming the own-DAO ticket (strategy A). */
  buildExecute: (tx: Transaction, ticket: TxArg, ownDaoId: string) => void
}

/**
 * The `Control*` path — a parent acting on a child through its `SubDAOControl`
 * cap. Enables B and D. Present only where a wired handler exists.
 */
export interface OuControlAdapter {
  typeKey: string
  payloadMoveType: string
  /** The harness supplies `controlCapId` from the parent linkage. */
  buildPayload: (tx: Transaction, controlCapId: string) => TxArg
  /** The `subdao_ops::execute_*` call consuming the ticket on the child. */
  buildExecute: (
    tx: Transaction,
    ticket: TxArg,
    capVaultId: string,
    childDaoId: string,
  ) => void
}

/** A governance action, independent of which strategy ends up carrying it. */
export interface OuProposalAction {
  /** Stable identifier — used for logs and cache invalidation. */
  kind: string
  /** Own-DAO path (A/C). Absent for control-only actions (e.g. sub-DAO removal). */
  own?: OuOwnAdapter
  /** Control path (B/D). Absent when no `Control*` handler exists. */
  control?: OuControlAdapter
  /**
   * Whether the action may degrade into a slow proposal. Defaults to
   * `fall-back-to-proposal`; `single-vote-only` blocks instead, for actions
   * where a week-long deferral would be a surprise rather than a service.
   */
  fallbackPolicy?: 'fall-back-to-proposal' | 'single-vote-only'
}

export interface ExecutionPlan {
  blocked: false
  strategy: Strategy
  /** True for the single-transaction strategies (A/B). */
  immediate: boolean
  /** The board that actually votes on this strategy — own or parent. */
  voterBoardSize: number
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
  detail: string
}

const WINNER_REASON: Record<Strategy, string> = {
  'own-execute': 'Your single vote satisfies this unit’s quorum.',
  'control-execute':
    'Your single vote on the parent unit can apply this to the child.',
  'own-propose': 'Creates a proposal for this unit’s board to vote on.',
  'control-propose':
    'Creates a proposal for the parent unit’s board to vote on.',
}

/** Why a single-vote-execute path is (or is not) viable, for the trace. */
function describeExecutable(
  member: boolean,
  config: ProposalConfig | null,
  boardSize: number,
): string {
  if (!member) return 'caller not on that board'
  if (!config) return 'type not enabled on that DAO'
  if (config.executionDelayMs !== 0) {
    return `execution delay ${config.executionDelayMs}ms forbids atomic execute`
  }
  if (boardSize * config.quorum > 10_000) {
    return `quorum ${config.quorum}bps × ${boardSize} members > 10000 → needs a full vote`
  }
  return `single vote clears quorum (${config.quorum}bps × ${boardSize})`
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
  const onOwn = onBoard(caller, ctx.board)
  const hasControl = !!action.control && !!ctx.parent
  const onParent = hasControl && onBoard(caller, ctx.parent!.board)
  const parentSize = ctx.parent?.board.length ?? 0

  return [
    {
      strategy: 'own-execute',
      tier: 'immediate',
      voterBoardSize: ctx.board.length,
      viable:
        onOwn &&
        !!caps.ownConfig &&
        singleVoteExecutable(ctx.board.length, caps.ownConfig),
      detail: describeExecutable(onOwn, caps.ownConfig, ctx.board.length),
    },
    {
      strategy: 'control-execute',
      tier: 'immediate',
      voterBoardSize: parentSize,
      viable:
        hasControl &&
        onParent &&
        !!caps.controlConfig &&
        singleVoteExecutable(parentSize, caps.controlConfig),
      detail: !hasControl
        ? 'no control adapter / parent unit'
        : describeExecutable(onParent, caps.controlConfig, parentSize),
    },
    {
      strategy: 'own-propose',
      tier: 'slow',
      voterBoardSize: ctx.board.length,
      viable: onOwn && !!caps.ownConfig,
      detail: !onOwn
        ? 'caller not on unit board'
        : !caps.ownConfig
          ? 'type not enabled on unit'
          : 'unit board can vote',
    },
    {
      strategy: 'control-propose',
      tier: 'slow',
      voterBoardSize: parentSize,
      viable: hasControl && onParent,
      detail: !hasControl
        ? 'no control adapter / parent unit'
        : !onParent
          ? 'caller not on parent board'
          : 'parent board can vote',
    },
  ]
}

/**
 * Pick the highest-priority viable strategy: A → B → (fallback gate) → C → D.
 *
 * Blocking is a VALUE, not a throw: "you are not on this board" is an ordinary
 * answer to "can I do this?", and callers branch on it the same way they branch
 * on a chosen strategy.
 */
export function selectStrategy(
  action: OuProposalAction,
  ctx: OuExecContext,
  caps: OuCapabilities,
  caller: string | undefined,
): StrategyDecision {
  const candidates = evaluatePaths(action, ctx, caps, caller)
  const pick = (c: PathCandidate): StrategyDecision => ({
    blocked: false,
    strategy: c.strategy,
    immediate: c.tier === 'immediate',
    voterBoardSize: c.voterBoardSize,
    reason: WINNER_REASON[c.strategy],
  })

  const immediate = candidates.find((c) => c.tier === 'immediate' && c.viable)
  if (immediate) return pick(immediate)

  // Fallback gate — some actions refuse to degrade to a slow proposal.
  if (action.fallbackPolicy === 'single-vote-only') {
    return {
      blocked: true,
      code: 'needs-slow-tier',
      reason:
        'No single-vote path is available and this action does not allow a governance proposal.',
    }
  }

  const slow = candidates.find((c) => c.tier === 'slow' && c.viable)
  if (slow) return pick(slow)

  const onOwn = onBoard(caller, ctx.board)
  const onParent = !!ctx.parent && onBoard(caller, ctx.parent.board)
  if (!onOwn && !onParent) {
    return {
      blocked: true,
      code: 'not-member',
      reason: 'You are not on this unit’s board (or its parent’s).',
    }
  }
  return {
    blocked: true,
    code: 'not-permitted',
    reason: 'This action isn’t available for your unit right now.',
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

/** The DAO proposal type key composites are submitted under. */
export const COMPOSITE_TYPE_KEY = 'Composite'

/** Why a cart cannot be bundled into a single composite. */
export type CompositeIneligibility =
  /** 0–1 actions — nothing to bundle. */
  | 'single-action'
  /** More than `MAX_COMPOSITE_STEPS`. */
  | 'too-many-steps'
  /** The unit has not enabled the `Composite` type. */
  | 'composite-disabled'
  /** A step lacks an own adapter, or its type is not `composableAllowed`. */
  | 'step-not-composable'

export interface CompositeEligibility {
  eligible: boolean
  reason?: CompositeIneligibility
}

/**
 * Can `actions` be submitted as one composite proposal on the unit?
 *
 * On-chain (`armature::composite`) requires the `Composite` type enabled on the
 * DAO, every step type `composableAllowed`, and ≤ 16 steps. Composite runs only
 * against the DAO's OWN pipeline — there is no control-composite — so every
 * action must carry an own adapter, and the caller pairs this with an
 * `own-propose` strategy. `gov` is the unit's own governance.
 */
export function canComposite(
  actions: OuProposalAction[],
  gov: DaoGovernance | undefined,
): CompositeEligibility {
  if (actions.length <= 1) return { eligible: false, reason: 'single-action' }
  if (actions.length > MAX_COMPOSITE_STEPS) {
    return { eligible: false, reason: 'too-many-steps' }
  }
  if (!gov || !gov.enabledTypes.has(COMPOSITE_TYPE_KEY)) {
    return { eligible: false, reason: 'composite-disabled' }
  }
  const allComposable = actions.every((a) => {
    if (!a.own) return false
    const cfg = gov.configs.get(a.own.typeKey)
    return !!cfg && cfg.composableAllowed
  })
  if (!allComposable) {
    return { eligible: false, reason: 'step-not-composable' }
  }
  return { eligible: true }
}

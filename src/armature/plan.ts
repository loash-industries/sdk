import { type Argument, Transaction } from '@mysten/sui/transactions'

import { TriexClientError, TriexError } from '../errors'
import type { NormalizedExecution } from '../execute'
import { findCreatedObject } from '../execute'
import type {
  ExecutionPlan,
  OuCapabilities,
  OuProposalAction,
  ResolvedPlan,
  Strategy,
} from './harness'
import { selectStrategy } from './harness'
import {
  addStep,
  advanceStep,
  appendDeleteExhaustedFrame,
  beginPipeline,
  finalizePipeline,
  newFrame,
  submitComposite,
  submitProposal,
  submitVoteExecute,
  ticketFromVote,
} from './transactions'
import type { OuExecContext } from './types'

/**
 * Transaction assembly for a chosen strategy.
 *
 * Kept out of `harness.ts` so the resolver stays free of the Sui runtime and
 * remains a pure, exhaustively-testable ladder. Everything here assumes the
 * strategy has already been decided.
 */

type TxArg = ReturnType<Transaction['moveCall']>

/** Per-transaction options a plan is built with. */
export interface PlanOptions {
  /**
   * Use the `_readonly` single-vote entry point (cooldown-0 types only). The
   * resolver sets it from the config; an explicit `false` forces `&mut OU`.
   */
  readonly?: boolean
  /** Recorded on the proposal / `ProposalCreated` event. */
  metadataIpfs?: string | null
}

/** @internal — a typed failure for a strategy the action cannot actually carry. */
function missingAdapter(strategy: Strategy, what: string): never {
  throw new TriexClientError(
    TriexError.ValidationFailed,
    `Strategy ${strategy} requires ${what}.`,
  )
}

/** Append one action's calls for `strategy` to an existing transaction. */
function appendStrategy(
  tx: Transaction,
  strategy: Strategy,
  action: OuProposalAction,
  ctx: OuExecContext,
  armature: string,
  opts: PlanOptions = {},
): void {
  if (strategy === 'own-execute' || strategy === 'own-propose') {
    const own = action.own
    if (!own) missingAdapter(strategy, 'an own adapter')
    const payload = own.buildPayload(tx)
    if (strategy === 'own-execute') {
      const ticket = submitVoteExecute(tx, {
        armature,
        daoId: ctx.daoId,
        payloadMoveType: own.payloadMoveType,
        payload,
        emergencyFreezeId: ctx.emergencyFreezeId,
        readonly: opts.readonly,
        metadataIpfs: opts.metadataIpfs,
      })
      own.buildExecute(tx, ticket, ctx.daoId)
    } else {
      submitProposal(tx, {
        armature,
        daoId: ctx.daoId,
        payloadMoveType: own.payloadMoveType,
        payload,
        metadataIpfs: opts.metadataIpfs,
      })
    }
    return
  }

  // Control strategies need both the adapter and the parent linkage.
  const control = action.control
  const parent = ctx.parent
  if (!control || !parent) {
    missingAdapter(strategy, 'a control adapter and a parent unit')
  }

  const payload = control.buildPayload(tx, parent.controlCapId)
  if (strategy === 'control-execute') {
    const ticket = submitVoteExecute(tx, {
      armature,
      daoId: parent.daoId,
      payloadMoveType: control.payloadMoveType,
      payload,
      emergencyFreezeId: parent.emergencyFreezeId,
      readonly: opts.readonly,
      metadataIpfs: opts.metadataIpfs,
    })
    control.buildExecute(tx, ticket, parent.capVaultId, ctx.daoId)
    return
  }

  submitProposal(tx, {
    armature,
    daoId: parent.daoId,
    payloadMoveType: control.payloadMoveType,
    payload,
    metadataIpfs: opts.metadataIpfs,
  })
}

/**
 * Append several actions' calls for `strategy` to an EXISTING transaction.
 *
 * The append-in-place form exists because some flows need commands in front of
 * the governance ones — claiming a pool's settled balances before a sweep, for
 * instance, where ordering is the whole point and a freshly-built transaction
 * would put the claim in the wrong place.
 *
 * `readonly` applies to every action; leave it unset unless every action's
 * type has cooldown 0 (a `_readonly` call on a cooldown type aborts).
 */
export function appendPlanActions(
  tx: Transaction,
  strategy: Strategy,
  actions: OuProposalAction[],
  ctx: OuExecContext,
  armature: string,
  opts?: PlanOptions,
): void {
  for (const action of actions) {
    appendStrategy(tx, strategy, action, ctx, armature, opts)
  }
}

/** Assemble the transaction for one action under a chosen strategy. */
export function buildPlanTx(
  strategy: Strategy,
  action: OuProposalAction,
  ctx: OuExecContext,
  armature: string,
  opts?: PlanOptions,
): Transaction {
  const tx = new Transaction()
  appendStrategy(tx, strategy, action, ctx, armature, opts)
  return tx
}

/**
 * Assemble one transaction applying SEVERAL actions via the same strategy — e.g.
 * enabling every trading type at once, each of which is its own
 * `EnableProposalType`.
 *
 * On an immediate strategy they execute together and atomically. On a slow one
 * this creates N independent proposals in a single signature — convenient, but
 * note it is N proposals to vote on, not one; `buildCompositeSubmitTx` is the
 * one-proposal form.
 */
export function buildBatchPlanTx(
  strategy: Strategy,
  actions: OuProposalAction[],
  ctx: OuExecContext,
  armature: string,
  opts?: PlanOptions,
): Transaction {
  const tx = new Transaction()
  appendPlanActions(tx, strategy, actions, ctx, armature, opts)
  return tx
}

/**
 * Assemble one transaction submitting several own-unit actions as a SINGLE
 * `Proposal<CompositePayload>` the board votes on once.
 *
 * Frame lifecycle in one PTB: `new_frame` → `add_step<P>` (or its typed
 * `EnableProposalType` / `UpdateProposalConfig` form) per action →
 * `submit_composite` (which seals, shares the frame, and creates the proposal).
 * Each action contributes a step through its existing `own` adapter, so there
 * is no per-action composite code. Own-unit only. Check `canComposite()` first
 * — this builds whatever it is handed, except a step that grants permissions,
 * which the chain would refuse anyway.
 */
export function buildCompositeSubmitTx(
  actions: OuProposalAction[],
  ctx: OuExecContext,
  armature: string,
  opts?: PlanOptions,
): Transaction {
  const tx = new Transaction()
  const frame = newFrame(tx, armature, ctx.daoId)
  for (const action of actions) {
    const own = action.own
    if (!own) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Cannot composite action '${action.kind}' — it has no own adapter.`,
      )
    }
    if (action.grantsPermissions) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Cannot composite action '${action.kind}' — it grants permission bits, which the chain allows only in a standalone proposal (EGrantInComposite).`,
      )
    }
    addStep(tx, {
      armature,
      frame,
      daoId: ctx.daoId,
      payloadMoveType: own.payloadMoveType,
      payload: own.buildPayload(tx),
    })
  }
  submitComposite(tx, {
    armature,
    daoId: ctx.daoId,
    frame,
    metadataIpfs: opts?.metadataIpfs,
  })
  return tx
}

/**
 * Execute an already-PASSED proposal, reusing the action's domain execute call.
 *
 * The ticket comes from the recorded vote rather than a fresh one, so a single
 * `buildExecute` serves both the single-vote path and a governance-passed
 * proposal — which is what closes the deferred-execution loop. Cycle 7 deletes
 * the proposal in the same call (`ticket_from_vote` takes it by value).
 */
export function buildExecutePassedTx(args: {
  action: OuProposalAction
  armature: string
  daoId: string
  proposalId: string
  emergencyFreezeId: string
  /** `ticket_from_vote_readonly` — only when slot AND snapshot cooldown are 0. */
  readonly?: boolean
}): Transaction {
  const own = args.action.own
  if (!own) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      `Cannot execute a passed proposal for '${args.action.kind}' — it has no own adapter.`,
    )
  }
  const tx = new Transaction()
  const ticket = ticketFromVote(tx, {
    armature: args.armature,
    daoId: args.daoId,
    proposalId: args.proposalId,
    payloadMoveType: own.payloadMoveType,
    emergencyFreezeId: args.emergencyFreezeId,
    readonly: args.readonly,
  })
  own.buildExecute(tx, ticket, args.daoId)
  return tx
}

/**
 * One step of a composite execution: the Move payload type `P` recorded at
 * `add_step<P>` — which `advance_step<P>` asserts against — plus the domain
 * `execute_*` that consumes the resulting ticket.
 */
export interface CompositeStep {
  payloadMoveType: string
  buildExecute: (tx: Transaction, ticket: TxArg, ownDaoId: string) => void
}

/**
 * Execute an already-passed `Composite` proposal through the frame pipeline, in
 * one PTB: `ticket_from_vote<CompositePayload>` → `begin_pipeline` → per step
 * `advance_step<P_i>` + that step's handler → `finalize_pipeline`.
 *
 * The pipeline is a hot potato threaded call to call, so ordering is enforced
 * on-chain rather than trusted here. Own-unit only. The proposal itself is
 * deleted by `ticket_from_vote` (cycle 7); `deleteFrame` also reclaims the
 * exhausted frame in the same transaction — off by default, so the frame
 * stays readable for anyone reconstructing the steps.
 */
export function buildExecuteCompositeTx(args: {
  armature: string
  daoId: string
  proposalId: string
  emergencyFreezeId: string
  frameId: string
  steps: CompositeStep[]
  /** Also `delete_exhausted_frame` after the pipeline (rebate to gas payer). */
  deleteFrame?: boolean
}): Transaction {
  if (args.steps.length === 0) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      'Cannot execute a composite with no steps.',
    )
  }
  const tx = new Transaction()
  const ticket = ticketFromVote(tx, {
    armature: args.armature,
    daoId: args.daoId,
    proposalId: args.proposalId,
    payloadMoveType: `${args.armature}::composite_payload::CompositePayload`,
    emergencyFreezeId: args.emergencyFreezeId,
  })

  // Typed as `Argument` so it can hold both the `begin_pipeline` Result and
  // each `advance_step` NestedResult as the potato moves forward.
  let pipeline: Argument = beginPipeline(tx, {
    armature: args.armature,
    daoId: args.daoId,
    frameId: args.frameId,
    ticket,
  })

  for (const step of args.steps) {
    const [stepTicket, next] = advanceStep(tx, {
      armature: args.armature,
      daoId: args.daoId,
      frameId: args.frameId,
      pipeline,
      emergencyFreezeId: args.emergencyFreezeId,
      payloadMoveType: step.payloadMoveType,
    })
    step.buildExecute(tx, stepTicket, args.daoId)
    pipeline = next
  }

  finalizePipeline(tx, args.armature, pipeline)
  if (args.deleteFrame) {
    appendDeleteExhaustedFrame(tx, args.armature, args.frameId)
  }
  return tx
}

/**
 * The `Proposal` object a `submit_proposal` / `submit_composite` transaction
 * created, from the execution result.
 *
 * Read from effects, never from a follow-up indexer read: a proposal that was
 * created moments ago is not in `/v1/orgs/{id}/proposals` yet, and polling for
 * it is the wrong shape of wait (DESIGN-ARMATURE.md §12). Single-PTB
 * executions create NO proposal object in cycle 7, so this is undefined for
 * them by design.
 */
export function extractCreatedProposalId(
  res: NormalizedExecution,
): string | undefined {
  return findCreatedObject(res, '::proposal::Proposal<')?.objectId
}

/** Pick a strategy (pure) and attach its lazy transaction builder. */
export function resolveExecutionPlan(
  action: OuProposalAction,
  ctx: OuExecContext,
  caps: OuCapabilities,
  caller: string | undefined,
  armature: string,
  opts?: { metadataIpfs?: string | null },
): ResolvedPlan {
  const decision = selectStrategy(action, ctx, caps, caller)
  if (decision.blocked) return decision
  const readonly = decision.immediate && !!decision.readonly
  const plan: ExecutionPlan = {
    blocked: false,
    strategy: decision.strategy,
    immediate: decision.immediate,
    voterBoardSize: decision.voterBoardSize,
    readonly,
    reason: decision.reason,
    buildTx: () =>
      buildPlanTx(decision.strategy, action, ctx, armature, {
        readonly,
        metadataIpfs: opts?.metadataIpfs,
      }),
  }
  return plan
}

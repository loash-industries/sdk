import { Transaction } from '@mysten/sui/transactions'

import { CLOCK_ID } from '../config'

/**
 * Pure PTB builders for the `armature` framework — the primitives every
 * governance path is assembled from (DESIGN-ARMATURE.md §6.1).
 *
 * These append to a caller-supplied `Transaction` and return the Move call
 * result, so they compose inside a larger PTB. `plan.ts` and `actions.ts` are
 * the intended callers; they are exported because a caller doing something the
 * facade does not cover should not have to re-derive the argument order.
 *
 * A note that costs people transactions: the on-chain `type_key` is a BARE
 * ascii name (`SetBoard`) while the type ARGUMENT is fully qualified
 * (`0xPKG::set_board::SetBoard`). Generic payloads keep the bare name as the
 * key and pass the instantiated type as the argument. Mixing the two up aborts
 * at `submit_*`.
 */

type TxArg = ReturnType<Transaction['moveCall']>

/** Config values for `proposal::new_config`, in basis points / milliseconds. */
export interface ProposalConfigInput {
  quorum: number
  approvalThreshold: number
  proposeThreshold: number
  expiryMs: number
  executionDelayMs: number
  cooldownMs: number
}

/**
 * `proposal::new_config` — always constructs `composable_allowed = false`.
 * Chain {@link withComposableAllowed} to flip it.
 */
export function newConfig(
  tx: Transaction,
  armature: string,
  c: ProposalConfigInput,
): TxArg {
  return tx.moveCall({
    target: `${armature}::proposal::new_config`,
    arguments: [
      tx.pure.u16(c.quorum),
      tx.pure.u16(c.approvalThreshold),
      tx.pure.u64(c.proposeThreshold),
      tx.pure.u64(c.expiryMs),
      tx.pure.u64(c.executionDelayMs),
      tx.pure.u64(c.cooldownMs),
    ],
  })
}

/** `proposal::with_composable_allowed` — lets the type be a composite step. */
export function withComposableAllowed(
  tx: Transaction,
  armature: string,
  config: TxArg,
  allowed = true,
): TxArg {
  return tx.moveCall({
    target: `${armature}::proposal::with_composable_allowed`,
    arguments: [config, tx.pure.bool(allowed)],
  })
}

/**
 * `board_voting::submit_vote_execute<P>` — vote and pass in one call, yielding
 * the `ExecutionTicket<P>` a domain `execute_*` consumes. Only legal when the
 * type's `execution_delay_ms` is 0 and the caller's lone vote clears quorum;
 * `singleVoteExecutable()` is the off-chain form of that check.
 */
export function submitVoteExecute(
  tx: Transaction,
  args: {
    armature: string
    daoId: string
    typeKey: string
    payloadMoveType: string
    payload: TxArg
    emergencyFreezeId: string
  },
): TxArg {
  return tx.moveCall({
    target: `${args.armature}::board_voting::submit_vote_execute`,
    typeArguments: [args.payloadMoveType],
    arguments: [
      tx.object(args.daoId),
      tx.pure.string(args.typeKey),
      tx.pure.option('string', null),
      args.payload,
      tx.object(args.emergencyFreezeId),
      tx.object(CLOCK_ID),
    ],
  })
}

/** `board_voting::submit_proposal<P>` — the deferred path; creates a Proposal. */
export function submitProposal(
  tx: Transaction,
  args: {
    armature: string
    daoId: string
    typeKey: string
    payloadMoveType: string
    payload: TxArg
  },
): void {
  tx.moveCall({
    target: `${args.armature}::board_voting::submit_proposal`,
    typeArguments: [args.payloadMoveType],
    arguments: [
      tx.object(args.daoId),
      tx.pure.string(args.typeKey),
      tx.pure.option('string', null),
      args.payload,
      tx.object(CLOCK_ID),
    ],
  })
}

/**
 * `board_voting::ticket_from_vote<P>` — the ticket for an ALREADY-passed
 * proposal. Same handoff as {@link submitVoteExecute}, except the authority
 * comes from the recorded vote, which is what lets one `buildExecute` serve
 * both the single-vote path and a governance-passed proposal.
 */
export function ticketFromVote(
  tx: Transaction,
  args: {
    armature: string
    daoId: string
    proposalId: string
    payloadMoveType: string
    emergencyFreezeId: string
  },
): TxArg {
  return tx.moveCall({
    target: `${args.armature}::board_voting::ticket_from_vote`,
    typeArguments: [args.payloadMoveType],
    arguments: [
      tx.object(args.daoId),
      tx.object(args.proposalId),
      tx.object(args.emergencyFreezeId),
      tx.object(CLOCK_ID),
    ],
  })
}

/** `proposal::vote<P>` — cast a vote on an open proposal. */
export function voteTx(args: {
  armature: string
  proposalId: string
  payloadMoveType: string
  approve: boolean
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::proposal::vote`,
    typeArguments: [args.payloadMoveType],
    arguments: [
      tx.object(args.proposalId),
      tx.pure.bool(args.approve),
      tx.object(CLOCK_ID),
    ],
  })
  return tx
}

/**
 * `proposal::try_expire<P>` — retire a proposal whose voting window lapsed.
 * Permissionless; the indexer reports such proposals as `pending` until someone
 * calls this, which is why `pending` and "still votable" are not the same thing.
 */
export function tryExpireTx(args: {
  armature: string
  proposalId: string
  payloadMoveType: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::proposal::try_expire`,
    typeArguments: [args.payloadMoveType],
    arguments: [tx.object(args.proposalId), tx.object(CLOCK_ID)],
  })
  return tx
}

// ─── Composite frame lifecycle ──────────────────────────────────────────────

/** `composite::new_frame` — opens a frame the steps are added to. */
export function newFrame(
  tx: Transaction,
  armature: string,
  daoId: string,
): TxArg {
  return tx.moveCall({
    target: `${armature}::composite::new_frame`,
    arguments: [tx.pure.id(daoId)],
  })
}

/** `composite::add_step<P>` — records one step's payload against the frame. */
export function addStep(
  tx: Transaction,
  args: {
    armature: string
    frame: TxArg
    daoId: string
    typeKey: string
    payloadMoveType: string
    payload: TxArg
  },
): void {
  tx.moveCall({
    target: `${args.armature}::composite::add_step`,
    typeArguments: [args.payloadMoveType],
    arguments: [
      args.frame,
      tx.object(args.daoId),
      tx.pure.string(args.typeKey),
      args.payload,
    ],
  })
}

/** `composite::submit_composite` — seals + shares the frame, creates the proposal. */
export function submitComposite(
  tx: Transaction,
  args: { armature: string; daoId: string; frame: TxArg },
): void {
  tx.moveCall({
    target: `${args.armature}::composite::submit_composite`,
    arguments: [
      tx.object(args.daoId),
      args.frame,
      tx.pure.option('string', null),
      tx.object(CLOCK_ID),
    ],
  })
}

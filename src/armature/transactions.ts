import type { Argument } from '@mysten/sui/transactions'
import { Transaction } from '@mysten/sui/transactions'

import { CLOCK_ID } from '../config'

/**
 * Pure PTB builders for the `armature` framework — the primitives every
 * governance path is assembled from (DESIGN-ARMATURE.md §6.1).
 *
 * Fragments append to a caller-supplied `Transaction` and return the Move call
 * result, so they compose inside a larger PTB; the `*Tx` builders return a
 * finished one-purpose transaction. `plan.ts` and the action catalog are the
 * intended callers; they are exported because a caller doing something the
 * facade does not cover should not have to re-derive the argument order.
 *
 * Cycle 7: the proposal-type registry is keyed by the payload's Move type, so
 * NO submit/execute call takes a `type_key` any more — the type argument `P`
 * selects the slot. The display key is a label the chain records, nothing
 * more. Getting the type argument right is now the whole contract.
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
  /** Chains `with_composable_allowed` when set. Ignored for default slots. */
  composableAllowed?: boolean
  /**
   * Cycle 7 — `armature::permissions` bits (`with_permissions`). Any
   * high-impact bit needs `approvalThreshold ≥ 8000` or the store aborts.
   */
  permissions?: number
  /** Cycle 7 — capability Move types a `VAULT_BORROW` type may borrow. */
  borrowScope?: string[]
}

// ─── Config & type-name values ──────────────────────────────────────────────

/** `ou::type_name_of<T>()` — the canonical `TypeName` the registry keys by. */
export function typeNameOf(
  tx: Transaction,
  armature: string,
  moveType: string,
): TxArg {
  return tx.moveCall({
    target: `${armature}::ou::type_name_of`,
    typeArguments: [moveType],
  })
}

/** A `vector<TypeName>` built in the PTB (TypeName cannot cross as pure). */
export function typeNameVec(
  tx: Transaction,
  armature: string,
  moveTypes: string[],
): TxArg {
  return tx.makeMoveVec({
    type: '0x1::type_name::TypeName',
    elements: moveTypes.map((t) => typeNameOf(tx, armature, t)),
  }) as unknown as TxArg
}

/**
 * `proposal::new_config`, then `with_composable_allowed` / `with_permissions`
 * / `with_borrow_scope` for whichever of those the input sets. `new_config`
 * itself always builds `composable_allowed = false`, no bits, empty scope.
 */
export function newConfig(
  tx: Transaction,
  armature: string,
  c: ProposalConfigInput,
): TxArg {
  let config = tx.moveCall({
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
  if (c.composableAllowed) {
    config = withComposableAllowed(tx, armature, config, true)
  }
  if (c.permissions) {
    config = tx.moveCall({
      target: `${armature}::proposal::with_permissions`,
      arguments: [config, tx.pure.u64(c.permissions)],
    })
  }
  if (c.borrowScope && c.borrowScope.length > 0) {
    config = tx.moveCall({
      target: `${armature}::proposal::with_borrow_scope`,
      arguments: [config, typeNameVec(tx, armature, c.borrowScope)],
    })
  }
  return config
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
 * `ou::new_type_init<T>(display_key, config)` — one construction-time slot
 * initializer for the `*_configured` constructors.
 */
export function newTypeInit(
  tx: Transaction,
  armature: string,
  init: { moveType: string; displayKey: string; config: ProposalConfigInput },
): TxArg {
  return tx.moveCall({
    target: `${armature}::ou::new_type_init`,
    typeArguments: [init.moveType],
    arguments: [
      tx.pure.string(init.displayKey),
      newConfig(tx, armature, init.config),
    ],
  })
}

/** A `vector<ou::ProposalTypeInit>` (possibly empty). */
export function typeInitVec(
  tx: Transaction,
  armature: string,
  inits: {
    moveType: string
    displayKey: string
    config: ProposalConfigInput
  }[],
): TxArg {
  return tx.makeMoveVec({
    type: `${armature}::ou::ProposalTypeInit`,
    elements: inits.map((i) => newTypeInit(tx, armature, i)),
  }) as unknown as TxArg
}

/** `governance::init_board(members)` — the `GovernanceTypeInit` a new OU takes. */
export function initBoard(
  tx: Transaction,
  armature: string,
  members: string[],
): TxArg {
  return tx.moveCall({
    target: `${armature}::governance::init_board`,
    arguments: [tx.pure.vector('address', members)],
  })
}

// ─── Submit / vote / execute ────────────────────────────────────────────────

/**
 * `board_voting::submit_vote_execute<P>` — vote and pass in one call, yielding
 * the `ExecutionTicket<P>` a domain `execute_*` consumes. Only legal when the
 * type's `execution_delay_ms` is 0 and the caller's lone vote clears quorum;
 * `singleVoteExecutable()` is the off-chain form of that check.
 *
 * No `Proposal` object is created (cycle 7): the proposal id is minted from
 * the transaction context and the events are the audit trail.
 *
 * `readonly` selects `submit_vote_execute_readonly`, legal only for a type
 * with `cooldown_ms == 0`: the OU then enters the PTB as an immutable input,
 * so concurrent single-vote executions stop contending on it.
 */
export function submitVoteExecute(
  tx: Transaction,
  args: {
    armature: string
    daoId: string
    payloadMoveType: string
    payload: TxArg
    emergencyFreezeId: string
    readonly?: boolean
    metadataIpfs?: string | null
  },
): TxArg {
  const fn = args.readonly
    ? 'submit_vote_execute_readonly'
    : 'submit_vote_execute'
  return tx.moveCall({
    target: `${args.armature}::board_voting::${fn}`,
    typeArguments: [args.payloadMoveType],
    arguments: [
      tx.object(args.daoId),
      tx.pure.option('string', args.metadataIpfs ?? null),
      args.payload,
      tx.object(args.emergencyFreezeId),
      tx.object(CLOCK_ID),
    ],
  })
}

/** `board_voting::submit_proposal<P>` — the deferred path; shares a `Proposal<P>`. */
export function submitProposal(
  tx: Transaction,
  args: {
    armature: string
    daoId: string
    payloadMoveType: string
    payload: TxArg
    metadataIpfs?: string | null
  },
): void {
  tx.moveCall({
    target: `${args.armature}::board_voting::submit_proposal`,
    typeArguments: [args.payloadMoveType],
    arguments: [
      tx.object(args.daoId),
      tx.pure.option('string', args.metadataIpfs ?? null),
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
 *
 * Cycle 7: the proposal is taken BY VALUE and deleted — the storage rebate
 * goes to this transaction's gas payer, and a second execute cannot happen
 * because the object is gone. The executor must be a CURRENT board member,
 * and the call aborts once the execution window (`passed_at +
 * execution_delay_ms + expiry_ms`) has closed.
 *
 * `readonly` selects `ticket_from_vote_readonly` (cooldown 0 on both the slot
 * and the proposal's snapshot).
 */
export function ticketFromVote(
  tx: Transaction,
  args: {
    armature: string
    daoId: string
    proposalId: string
    payloadMoveType: string
    emergencyFreezeId: string
    readonly?: boolean
  },
): TxArg {
  const fn = args.readonly ? 'ticket_from_vote_readonly' : 'ticket_from_vote'
  return tx.moveCall({
    target: `${args.armature}::board_voting::${fn}`,
    typeArguments: [args.payloadMoveType],
    arguments: [
      tx.object(args.daoId),
      tx.object(args.proposalId),
      tx.object(args.emergencyFreezeId),
      tx.object(CLOCK_ID),
    ],
  })
}

/**
 * `board_voting::vote<P>` — cast a vote on an open proposal of `ouId`.
 *
 * Cycle 7: voting moved from `proposal::vote` and now takes the OU (to read
 * its roster), aborting unless the OU is the proposal's own. A voter must have
 * been a member at the proposal's snapshot roster version — members added
 * after it was created cannot vote, members removed since still can — and the
 * vote aborts (`EVotingClosed`) once `created_at + expiry_ms` has passed.
 */
export function voteTx(args: {
  armature: string
  proposalId: string
  ouId: string
  payloadMoveType: string
  approve: boolean
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::board_voting::vote`,
    typeArguments: [args.payloadMoveType],
    arguments: [
      tx.object(args.proposalId),
      tx.object(args.ouId),
      tx.pure.bool(args.approve),
      tx.object(CLOCK_ID),
    ],
  })
  return tx
}

/**
 * `proposal::delete_expired_proposal<P>` — append one permissionless cleanup.
 *
 * Deletes an ACTIVE proposal once `created_at + expiry_ms` has passed, or a
 * PASSED one once its execution window (`passed_at + execution_delay_ms +
 * expiry_ms`) has closed; emits `ProposalExpired`. Anyone may call it and the
 * storage rebate goes to the gas payer. Aborts (`ENotExpired`) before then.
 */
export function appendDeleteExpiredProposal(
  tx: Transaction,
  args: { armature: string; proposalId: string; payloadMoveType: string },
): void {
  tx.moveCall({
    target: `${args.armature}::proposal::delete_expired_proposal`,
    typeArguments: [args.payloadMoveType],
    arguments: [tx.object(args.proposalId), tx.object(CLOCK_ID)],
  })
}

/** {@link appendDeleteExpiredProposal} for one or more proposals, as a transaction. */
export function deleteExpiredProposalTx(args: {
  armature: string
  proposals: { proposalId: string; payloadMoveType: string }[]
}): Transaction {
  const tx = new Transaction()
  for (const p of args.proposals) {
    appendDeleteExpiredProposal(tx, { armature: args.armature, ...p })
  }
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

/** The typed `add_*_step` entry a payload type needs, or null for `add_step<P>`. */
export function typedStepFunction(payloadMoveType: string): string | null {
  const base = payloadMoveType.split('<')[0]
  if (base.endsWith('::enable_proposal_type::EnableProposalType')) {
    return 'add_enable_proposal_type_step'
  }
  if (base.endsWith('::update_proposal_config::UpdateProposalConfig')) {
    return 'add_update_proposal_config_step'
  }
  return null
}

/**
 * `composite::add_step<P>` — record one step's payload against the frame.
 *
 * Cycle 7: no `type_key` (the step's type IS `P`), and `EnableProposalType` /
 * `UpdateProposalConfig` steps must go through their typed entry points
 * (`add_enable_proposal_type_step` / `add_update_proposal_config_step`), which
 * refuse any step that grants permission bits (`EGrantInComposite`). This
 * picks the right one from the payload type.
 */
export function addStep(
  tx: Transaction,
  args: {
    armature: string
    frame: TxArg
    daoId: string
    payloadMoveType: string
    payload: TxArg
  },
): void {
  const typed = typedStepFunction(args.payloadMoveType)
  tx.moveCall({
    target: `${args.armature}::composite::${typed ?? 'add_step'}`,
    typeArguments: typed ? [] : [args.payloadMoveType],
    arguments: [args.frame, tx.object(args.daoId), args.payload],
  })
}

/**
 * `composite::submit_composite` — seals + shares the frame and creates the
 * `Proposal<CompositePayload>`, whose effective config is the component-wise
 * max of the `Composite` slot and every step's config.
 */
export function submitComposite(
  tx: Transaction,
  args: {
    armature: string
    daoId: string
    frame: TxArg
    metadataIpfs?: string | null
  },
): void {
  tx.moveCall({
    target: `${args.armature}::composite::submit_composite`,
    arguments: [
      tx.object(args.daoId),
      args.frame,
      tx.pure.option('string', args.metadataIpfs ?? null),
      tx.object(CLOCK_ID),
    ],
  })
}

/** `composite::begin_pipeline` — turns the composite ticket into a step sequencer. */
export function beginPipeline(
  tx: Transaction,
  args: { armature: string; daoId: string; frameId: string; ticket: TxArg },
): Argument {
  return tx.moveCall({
    target: `${args.armature}::composite::begin_pipeline`,
    arguments: [tx.object(args.daoId), tx.object(args.frameId), args.ticket],
  })
}

/** `composite::advance_step<P>` — yields `(ExecutionTicket<P>, Pipeline)`. */
export function advanceStep(
  tx: Transaction,
  args: {
    armature: string
    daoId: string
    frameId: string
    pipeline: Argument
    emergencyFreezeId: string
    payloadMoveType: string
  },
): [TxArg, Argument] {
  const [ticket, next] = tx.moveCall({
    target: `${args.armature}::composite::advance_step`,
    typeArguments: [args.payloadMoveType],
    arguments: [
      tx.object(args.daoId),
      tx.object(args.frameId),
      args.pipeline,
      tx.object(args.emergencyFreezeId),
      tx.object(CLOCK_ID),
    ],
  })
  return [ticket as unknown as TxArg, next]
}

/** `composite::finalize_pipeline` — consumes the sequencer once every step ran. */
export function finalizePipeline(
  tx: Transaction,
  armature: string,
  pipeline: Argument,
): void {
  tx.moveCall({
    target: `${armature}::composite::finalize_pipeline`,
    arguments: [pipeline],
  })
}

/**
 * `composite::delete_exhausted_frame` — append the permissionless cleanup of a
 * frame whose every step has run. The storage rebate goes to the gas payer.
 */
export function appendDeleteExhaustedFrame(
  tx: Transaction,
  armature: string,
  frameId: string,
): void {
  tx.moveCall({
    target: `${armature}::composite::delete_exhausted_frame`,
    arguments: [tx.object(frameId)],
  })
}

/** {@link appendDeleteExhaustedFrame} as a transaction. */
export function deleteExhaustedFrameTx(args: {
  armature: string
  frameId: string
}): Transaction {
  const tx = new Transaction()
  appendDeleteExhaustedFrame(tx, args.armature, args.frameId)
  return tx
}

// ─── Emergency freeze (FreezeAdminCap holder) ───────────────────────────────

/**
 * `emergency::freeze_type<P>` — freeze one payload type on a unit, for the
 * unit's `max_freeze_duration_ms`. Only the `FreezeAdminCap` holder can call
 * it; freeze-exempt types (always `TransferFreezeAdmin` and
 * `UnfreezeProposalType`) abort. Generic payloads freeze per instantiation:
 * `SendCoin<CRED>` is frozen, `SendCoin<SUI>` is not.
 */
export function freezeTypeTx(args: {
  armature: string
  emergencyFreezeId: string
  freezeAdminCapId: string
  moveType: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::emergency::freeze_type`,
    typeArguments: [args.moveType],
    arguments: [
      tx.object(args.emergencyFreezeId),
      tx.object(args.freezeAdminCapId),
      tx.object(CLOCK_ID),
    ],
  })
  return tx
}

/** `emergency::unfreeze_type<P>` — the `FreezeAdminCap` holder lifts a freeze early. */
export function unfreezeTypeTx(args: {
  armature: string
  emergencyFreezeId: string
  freezeAdminCapId: string
  moveType: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::emergency::unfreeze_type`,
    typeArguments: [args.moveType],
    arguments: [
      tx.object(args.emergencyFreezeId),
      tx.object(args.freezeAdminCapId),
    ],
  })
  return tx
}

// ─── Encrypted entries (member-gated, no vote) ──────────────────────────────
//
// `encrypted_entry` is gated on board membership alone — any current member
// may publish, edit, re-key or remove, with no permission bit and no vote.
// That is the module's design (a shared notebook for the board), not a gap.

/** `encrypted_entry::publish_entry` — index a new encrypted blob on the unit (max 32). */
export function publishEntryTx(args: {
  armature: string
  ouId: string
  location: string
  description: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::encrypted_entry::publish_entry`,
    arguments: [
      tx.object(args.ouId),
      tx.pure.string(args.location),
      tx.pure.string(args.description),
    ],
  })
  return tx
}

/**
 * `encrypted_entry::update_entry` — re-point a STALE entry (encrypted under an
 * older epoch) at its re-encrypted blob; stamps it with the current epoch.
 * Aborts `EEntryNotStale` for a current entry — use {@link editEntryTx}.
 */
export function updateEntryTx(args: {
  armature: string
  ouId: string
  entryId: string
  location: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::encrypted_entry::update_entry`,
    arguments: [
      tx.object(args.ouId),
      tx.object(args.entryId),
      tx.pure.string(args.location),
    ],
  })
  return tx
}

/** `encrypted_entry::edit_entry` — move a blob within the same epoch (no re-key). */
export function editEntryTx(args: {
  armature: string
  ouId: string
  entryId: string
  location: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::encrypted_entry::edit_entry`,
    arguments: [
      tx.object(args.ouId),
      tx.object(args.entryId),
      tx.pure.string(args.location),
    ],
  })
  return tx
}

/** `encrypted_entry::rotate_encryption_epoch` — mark every entry stale. */
export function rotateEncryptionEpochTx(args: {
  armature: string
  ouId: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::encrypted_entry::rotate_encryption_epoch`,
    arguments: [tx.object(args.ouId)],
  })
  return tx
}

/** `encrypted_entry::remove_entry` — unindex and delete an entry. */
export function removeEntryTx(args: {
  armature: string
  ouId: string
  entryId: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::encrypted_entry::remove_entry`,
    arguments: [tx.object(args.ouId), tx.object(args.entryId)],
  })
  return tx
}

// ─── Standalone OU lifecycle ────────────────────────────────────────────────

/**
 * `ou::create` — a standalone OU (no parent) with board governance and the
 * default slots. Every companion object is shared and the `FreezeAdminCap`
 * goes to the sender. For a full organization (root + officers + members,
 * controls wired) use `createTribeTx`.
 */
export function createOuTx(args: {
  armature: string
  board: string[]
  name: string
  metadataUri: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::ou::create`,
    arguments: [
      initBoard(tx, args.armature, args.board),
      tx.pure.string(args.name),
      tx.pure.string(args.metadataUri),
    ],
  })
  return tx
}

/**
 * `ou::destroy` — permissionless cleanup of a MIGRATING OU (after a SpawnOU
 * executed) and all four companion objects. Aborts unless the treasury and
 * capability vault are empty and no encrypted entries remain — move assets
 * out with TransferAssets first.
 */
export function destroyOuTx(args: {
  armature: string
  ouId: string
  treasuryId: string
  capabilityVaultId: string
  charterId: string
  emergencyFreezeId: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armature}::ou::destroy`,
    arguments: [
      tx.object(args.ouId),
      tx.object(args.treasuryId),
      tx.object(args.capabilityVaultId),
      tx.object(args.charterId),
      tx.object(args.emergencyFreezeId),
    ],
  })
  return tx
}

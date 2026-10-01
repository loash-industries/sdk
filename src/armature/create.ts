import { Transaction } from '@mysten/sui/transactions'

import { TRADING_TYPE_CONFIG, tradingTypeEntries } from './actions'
import { typeInitVec, type ProposalConfigInput } from './transactions'

/**
 * Creating an organization (B1, cycle 7).
 *
 * `armature_proposals::tribe_setup::create_tribe_configured` builds the
 * three-tier tree in one call — the root ("org"), an officers unit and a
 * members unit — wires each parent's `SubOUControl` into its vault, AND
 * enables the controller types (`ControllerBatchAddMembers` / `…Remove…` /
 * `PauseSubOUExecution` single-vote; `UnpauseSubOUExecution`,
 * `ReclaimCapFromSubOU`, `TransferCapToSubOU` at 50%) on the root and officer
 * units with their permission bits and `SubOUControl` borrow scope. The
 * framework's own `tribe::create_tribe_configured` leaves those controls
 * dormant, which is why the SDK targets `tribe_setup`.
 *
 * Overrides are `ou::ProposalTypeInit`s: a default slot's override keeps the
 * slot's bits and display key (`EDisplayKeyMismatch` otherwise); a new type is
 * enabled with whatever bits its config carries (80% approval for a
 * high-impact bit).
 */

/** One construction-time slot: a Move type, its display key, its config. */
export interface TypeInitInput {
  moveType: string
  displayKey: string
  config: ProposalConfigInput
}

export interface CreateTribeParams {
  armature: string
  armatureProposals: string
  /** Root ("org") board. */
  tribeBoard: string[]
  officers: string[]
  members: string[]
  tribeName: string
  officerName: string
  memberName: string
  tribeMetadataUri: string
  officerMetadataUri: string
  memberMetadataUri: string
  /** Receives the officers unit's `FreezeAdminCap`. */
  officerFreezeAdmin: string
  /** Receives the members unit's `FreezeAdminCap`. */
  memberFreezeAdmin: string
  tribeOverrides?: TypeInitInput[]
  officerOverrides?: TypeInitInput[]
  memberOverrides?: TypeInitInput[]
}

/**
 * `tribe_setup::create_tribe_configured`. The root's `FreezeAdminCap` goes to
 * the sender. Returns the transaction; the three OU ids come from its effects
 * (`OrgsWriteApi.create` resolves which is which).
 */
export function createTribeTx(p: CreateTribeParams): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${p.armatureProposals}::tribe_setup::create_tribe_configured`,
    arguments: [
      tx.pure.vector('address', p.tribeBoard),
      tx.pure.vector('address', p.officers),
      tx.pure.vector('address', p.members),
      tx.pure.string(p.tribeName),
      tx.pure.string(p.officerName),
      tx.pure.string(p.memberName),
      tx.pure.string(p.tribeMetadataUri),
      tx.pure.string(p.officerMetadataUri),
      tx.pure.string(p.memberMetadataUri),
      tx.pure.address(p.officerFreezeAdmin),
      tx.pure.address(p.memberFreezeAdmin),
      typeInitVec(tx, p.armature, p.tribeOverrides ?? []),
      typeInitVec(tx, p.armature, p.officerOverrides ?? []),
      typeInitVec(tx, p.armature, p.memberOverrides ?? []),
    ],
  })
  return tx
}

/**
 * The officer-tier overrides that make a new organization trade from day one:
 * every `armature_trading` type, single-vote, with the bits its handler needs
 * (`DepositCoinToBook` → treasury withdraw at 80%, which one officer's YES
 * still clears). Mirrors triex-app-api's `buildCreateTribeConfiguredTx`.
 */
export function tradingTypeInits(
  armatureTrading: string,
  quoteType: string,
): TypeInitInput[] {
  return tradingTypeEntries(armatureTrading, quoteType).map((e) => ({
    moveType: e.moveType,
    displayKey: e.typeKey,
    config: e.permissions
      ? {
          ...TRADING_TYPE_CONFIG,
          approvalThreshold: 8000,
          permissions: e.permissions,
          composableAllowed: true,
        }
      : { ...TRADING_TYPE_CONFIG, composableAllowed: true },
  }))
}

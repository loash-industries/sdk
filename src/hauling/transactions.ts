import type {
  Transaction,
  TransactionArgument,
  TransactionObjectArgument,
} from '@mysten/sui/transactions'
import { TriexClientError, TriexError } from '../errors'
import type { PackageIds } from '../types'

/**
 * PTB builders for hauling agreements (armature-vault `hauling_agreements`),
 * ported from triex-app-api `src/hauling/tx.ts`. Each appends to a caller's
 * `Transaction`; item balances (cargo, deliveries) and coins (reward,
 * collateral, posting fee) are sourced by the caller — see
 * `HaulingWriteApi`, which does that from the wallet and hangar.
 *
 * Agreements carry LISTS of items: cargo, `want` and a delivery are vectors
 * built with `makeMoveVec`, and the lists the contract returns (accepted,
 * cancelled or collected cargo) go to one address through
 * `agreements::payout::pay_all`, since `transferObjects` can't take a vector.
 */

const CLOCK = '0x6'

/** The hauling package ids, resolved; throws on a network without hauling. */
export interface HaulingIds {
  hauling: string
  config: string
  agreements: string
  agreementsOriginal: string
  roles: string
  /** `roles`' original id: `acl::Principal`'s type tag. */
  rolesOriginal: string
  agreementRoles: string
  multicoin: string
}

/** @throws `ValidationFailed` when the network has no hauling deployment. */
export function haulingIds(ids: PackageIds): HaulingIds {
  const {
    haulingAgreements: hauling,
    haulingConfig: config,
    agreements,
    roles,
    agreementRoles,
  } = ids
  if (!hauling || !config || !agreements || !roles || !agreementRoles) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      'Hauling agreements are not deployed on this network (packageIds.haulingAgreements / haulingConfig / agreements / roles / agreementRoles unset).',
    )
  }
  return {
    hauling,
    config,
    agreements,
    agreementsOriginal: ids.agreementsOriginal ?? agreements,
    roles,
    rolesOriginal: ids.rolesOriginal ?? roles,
    agreementRoles,
    multicoin: ids.multicoin,
  }
}

/** One wanted item: what must be handed in, at which collection. */
export interface WantSpec {
  /** The receipt collection of the hub the item must reach. */
  collectionId: string
  assetId: string | bigint
  quantity: bigint
}

/** A claim-gate principal: who may accept. */
export type HaulingPrincipal =
  | { kind: 'player'; address: string }
  | { kind: 'machine'; address: string }
  | { kind: 'ou'; orgId: string }

/** `balances` as one `vector<multicoin::Balance>`. */
export function balanceVector(
  tx: Transaction,
  h: HaulingIds,
  balances: TransactionArgument[],
): TransactionArgument {
  return tx.makeMoveVec({
    type: `${h.multicoin}::multicoin::Balance`,
    elements: balances as TransactionObjectArgument[],
  })
}

/** Send every balance in a returned `vector<Balance>` to `to`. */
export function payAll(
  tx: Transaction,
  h: HaulingIds,
  balances: TransactionArgument,
  to: string,
): void {
  tx.moveCall({
    target: `${h.agreements}::payout::pay_all`,
    arguments: [balances, tx.pure.address(to)],
  })
}

export interface PostAgreementArgs {
  /** Coin type `T` of reward and collateral; must be approved in the config. */
  currency: string
  /** One balance per cargo item, in order. */
  cargo: TransactionArgument[]
  /** The escrowed reward coin (exactly the reward). */
  reward: TransactionArgument
  /** Coin type `F` of the posting fee (`0x2::sui::SUI` with a zero coin when free). */
  postFeeCoinType: string
  /** The posting fee coin (a zero coin when the config charges none). */
  postFee: TransactionArgument
  /** What must be handed in, one entry per item, in delivery order. */
  want: WantSpec[]
  /** Collateral the hauler locks on accept, raw units of `currency`. */
  collateral: bigint
  /** How long the agreement can be accepted, ms from posting. */
  acceptWindowMs: bigint | number
  /** How long a hauler has to deliver once they accept, ms. */
  haulDurationMs: bigint | number
  /** Paid on delivery or default; omitted pays whoever holds the lister cap. */
  beneficiary?: string
  /** Who may accept (a claim gate); empty or omitted: anyone. */
  principals?: HaulingPrincipal[]
}

/**
 * `terms::new[_for_cap_holder]` → `hauling::draft<T, F>` →
 * [`agreement_roles::claim::requirement` → `hauling::require_to_accept`] →
 * `hauling::publish` → the `ListerCap`, which the caller keeps.
 */
export function postAgreement(
  tx: Transaction,
  h: HaulingIds,
  args: PostAgreementArgs,
): TransactionArgument {
  if (!args.want.length || args.want.some((w) => w.quantity <= 0n)) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      'Name at least one wanted item, each with a positive quantity.',
    )
  }
  if ((args.principals?.length ?? 0) > 32) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      'A claim gate lists at most 32 players, machine keys or organizations.',
    )
  }
  const T = args.currency
  const want = tx.makeMoveVec({
    type: `${h.agreementsOriginal}::spec::Spec`,
    elements: args.want.map(
      (w) =>
        tx.moveCall({
          target: `${h.agreements}::spec::new`,
          arguments: [
            tx.pure.id(w.collectionId),
            tx.pure.u64(BigInt(w.assetId)),
            tx.pure.u64(w.quantity),
          ],
        })[0],
    ),
  })
  const windows = [
    tx.pure.u64(args.collateral),
    tx.pure.u64(BigInt(args.acceptWindowMs)),
    tx.pure.u64(BigInt(args.haulDurationMs)),
  ]
  const [terms] = args.beneficiary
    ? tx.moveCall({
        target: `${h.hauling}::terms::new`,
        arguments: [want, ...windows, tx.pure.address(args.beneficiary)],
      })
    : tx.moveCall({
        target: `${h.hauling}::terms::new_for_cap_holder`,
        arguments: [want, ...windows],
      })

  const [draft] = tx.moveCall({
    target: `${h.hauling}::hauling::draft`,
    typeArguments: [T, args.postFeeCoinType],
    arguments: [
      balanceVector(tx, h, args.cargo),
      args.reward,
      terms,
      tx.object(h.config),
      args.postFee,
      tx.object(CLOCK),
    ],
  })

  if (args.principals?.length) {
    const principals = args.principals.map(
      (p) =>
        tx.moveCall({
          target: `${h.roles}::acl::${p.kind}`,
          arguments: [
            p.kind === 'ou' ? tx.pure.id(p.orgId) : tx.pure.address(p.address),
          ],
        })[0],
    )
    const [gate] = tx.moveCall({
      target: `${h.agreementRoles}::claim::requirement`,
      arguments: [
        tx.makeMoveVec({
          type: `${h.rolesOriginal}::acl::Principal`,
          elements: principals,
        }),
      ],
    })
    tx.moveCall({
      target: `${h.hauling}::hauling::require_to_accept`,
      typeArguments: [T],
      arguments: [draft, gate],
    })
  }

  const [cap] = tx.moveCall({
    target: `${h.hauling}::hauling::publish`,
    typeArguments: [T],
    arguments: [draft],
  })
  return cap
}

/** One step of a claim plan: how to satisfy one accept requirement. */
export interface ClaimStep {
  reqIndex: number
  action: string
  orgId: string | null
  typeName?: string
}

/**
 * Lock the collateral and take the cargo. Without claim steps:
 * `hauling::accept`. With them: `begin_accept`, each gate satisfied as the
 * plan says (`satisfy_directly`, or `satisfy` through an organization), then
 * `finish_accept`. Returns the cargo `vector<Balance>`.
 */
export function acceptAgreement(
  tx: Transaction,
  h: HaulingIds,
  args: {
    agreementId: string
    currency: string
    collateral: TransactionArgument
    steps: ClaimStep[]
  },
): TransactionArgument {
  const blocked = args.steps.find(
    (s) => s.action !== 'satisfy_directly' && s.action !== 'satisfy',
  )
  if (blocked) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      blocked.action === 'not_satisfiable'
        ? 'This address is not on the agreement’s claim list.'
        : `The agreement has a requirement the SDK cannot satisfy (${blocked.typeName ?? blocked.action}).`,
    )
  }
  const T = args.currency
  const agreement = tx.object(args.agreementId)
  const clock = tx.object(CLOCK)
  if (!args.steps.length) {
    return tx.moveCall({
      target: `${h.hauling}::hauling::accept`,
      typeArguments: [T],
      arguments: [agreement, args.collateral, clock],
    })[0]
  }
  const [request] = tx.moveCall({
    target: `${h.hauling}::hauling::begin_accept`,
    typeArguments: [T],
    arguments: [agreement, clock],
  })
  for (const step of [...args.steps].sort((a, b) => a.reqIndex - b.reqIndex)) {
    if (step.action === 'satisfy') {
      if (!step.orgId) {
        throw new TriexClientError(
          TriexError.ValidationFailed,
          'The claim plan is missing the organization to satisfy the gate through.',
        )
      }
      tx.moveCall({
        target: `${h.agreementRoles}::claim::satisfy`,
        arguments: [request, tx.object(step.orgId)],
      })
    } else {
      tx.moveCall({
        target: `${h.agreementRoles}::claim::satisfy_directly`,
        arguments: [request],
      })
    }
  }
  return tx.moveCall({
    target: `${h.hauling}::hauling::finish_accept`,
    typeArguments: [T],
    arguments: [agreement, request, args.collateral, clock],
  })[0]
}

/** Hand in exactly the wanted balances, one per `want` entry, in order. */
export function deliverAgreement(
  tx: Transaction,
  h: HaulingIds,
  args: {
    agreementId: string
    currency: string
    delivered: TransactionArgument[]
  },
): void {
  tx.moveCall({
    target: `${h.hauling}::hauling::deliver`,
    typeArguments: [args.currency],
    arguments: [
      tx.object(args.agreementId),
      balanceVector(tx, h, args.delivered),
      tx.object(CLOCK),
    ],
  })
}

/**
 * Delete an open agreement with its cap: the cargo and reward come back, and
 * go to `owner`.
 */
export function cancelAgreement(
  tx: Transaction,
  h: HaulingIds,
  args: { agreementId: string; capId: string; currency: string; owner: string },
): void {
  const [cargo, reward] = tx.moveCall({
    target: `${h.hauling}::hauling::cancel`,
    typeArguments: [args.currency],
    arguments: [
      tx.object(args.agreementId),
      tx.object(args.capId),
      tx.object(CLOCK),
    ],
  })
  payAll(tx, h, cargo, args.owner)
  tx.transferObjects([reward], args.owner)
}

/**
 * `default` (anyone, after the delivery deadline) or `forfeit` (the hauler,
 * before it): reward and collateral go to whoever the terms pay.
 */
export function endAgreement(
  tx: Transaction,
  h: HaulingIds,
  args: { agreementId: string; currency: string; kind: 'default' | 'forfeit' },
): void {
  tx.moveCall({
    target: `${h.hauling}::hauling::${args.kind}`,
    typeArguments: [args.currency],
    arguments: [tx.object(args.agreementId), tx.object(CLOCK)],
  })
}

/**
 * Open the `Proceeds<T>` sent to the lister cap and keep what it held: the
 * wanted items after a delivery (the coin is then empty and destroyed), the
 * reward plus collateral after a default or forfeit, or the cargo and reward
 * after a lapse.
 */
export function collectProceeds(
  tx: Transaction,
  h: HaulingIds,
  args: {
    capId: string
    proceedsId: string
    currency: string
    owner: string
    /** True when the agreement ended delivered: the returned coin is empty. */
    delivered: boolean
  },
): void {
  const [items, coin] = tx.moveCall({
    target: `${h.hauling}::hauling::collect`,
    typeArguments: [args.currency],
    arguments: [tx.object(args.capId), tx.object(args.proceedsId)],
  })
  payAll(tx, h, items, args.owner)
  if (args.delivered) {
    tx.moveCall({
      target: '0x2::coin::destroy_zero',
      typeArguments: [args.currency],
      arguments: [coin],
    })
  } else {
    tx.transferObjects([coin], args.owner)
  }
}

/** Delete a spent lister cap that doesn't receive proceeds. */
export function deleteListerCap(
  tx: Transaction,
  h: HaulingIds,
  capId: string,
): void {
  tx.moveCall({
    target: `${h.hauling}::hauling::delete_cap`,
    arguments: [tx.object(capId)],
  })
}

import { Transaction } from '@mysten/sui/transactions'

import { CLOCK_ID } from '../config'
import type { ArmaturePkgs } from './actions'
import { genericTypeKey } from './actions'
import { PERMISSIONS } from './governance'
import type { OuProposalAction } from './harness'
import type { ProposalConfigInput } from './transactions'

/**
 * An organization's own currency (`armature_proposals::currency`, cycle 7).
 *
 * The OU takes custody of a coin's `TreasuryCap<T>` (`AdoptCurrency`) and can
 * then mint into its treasury or to an address (`MintCoin`), burn from the
 * treasury (`BurnCoin`), or give the cap back (`ReturnCurrencyCap`). Every
 * type is per-coin: each `T` is its own slot, enabled with the bits and
 * borrow scope `armature_proposals::type_permissions` names
 * ({@link currencyTypeEntries}).
 *
 * `MintAllowance<T>` is the one BYPASS-capable type: after an
 * `EnableBypassType<MintAllowance<T>>` vote AND a `ConfigureMintAllowance<T>`
 * vote naming minters, a per-call cap and the kill-switch, an allowlisted
 * minter mints without a vote through {@link mintAllowanceBypassTx}.
 */

/** `0x2::coin::TreasuryCap<T>` — the borrow scope of the currency types. */
export function treasuryCapType(coinType: string): string {
  return `0x2::coin::TreasuryCap<${coinType}>`
}

/** One currency type to enable, with the bits/scope its handler needs. */
export interface CurrencyTypeEntry {
  typeKey: string
  moveType: string
  config: ProposalConfigInput
}

/**
 * The currency types for one coin, each with its `type_permissions` bits and
 * borrow scope. Every one but `ConfigureMintAllowance` holds an 80%-floor bit,
 * so `base` is lifted to an 8000 approval where needed. Feed these to
 * `enableProposalTypeAction` (the handle's `types.enableCurrency`).
 */
export function currencyTypeEntries(
  armatureProposals: string,
  coinType: string,
  base: ProposalConfigInput,
): CurrencyTypeEntry[] {
  const scope = [treasuryCapType(coinType)]
  const at80 = (bits: number, borrowScope: string[] = []) => ({
    ...base,
    approvalThreshold: Math.max(base.approvalThreshold, 8000),
    permissions: bits,
    borrowScope,
  })
  const entry = (mod: string, struct: string, config: ProposalConfigInput) => ({
    typeKey: genericTypeKey(struct, coinType),
    moveType: `${armatureProposals}::${mod}::${struct}<${coinType}>`,
    config,
  })
  return [
    entry('adopt_currency', 'AdoptCurrency', {
      ...base,
      permissions: PERMISSIONS.VAULT_STORE,
    }),
    entry('mint_coin', 'MintCoin', at80(PERMISSIONS.VAULT_BORROW, scope)),
    entry(
      'burn_coin',
      'BurnCoin',
      at80(PERMISSIONS.TREASURY_WITHDRAW | PERMISSIONS.VAULT_BORROW, scope),
    ),
    entry(
      'return_currency_cap',
      'ReturnCurrencyCap',
      at80(PERMISSIONS.VAULT_EXTRACT),
    ),
    entry('configure_mint_allowance', 'ConfigureMintAllowance', { ...base }),
  ]
}

/**
 * Hand a coin's `TreasuryCap<T>` to the organization (`AdoptCurrency<T>`).
 * The cap is passed BY VALUE at execution, so the executor must own it.
 */
export function adoptCurrencyAction(
  pkgs: ArmaturePkgs,
  params: {
    coinType: string
    treasuryCapId: string
    capabilityVaultId: string
  },
): OuProposalAction {
  const { armatureProposals: p } = pkgs
  return {
    kind: 'adopt_currency',
    own: {
      typeKey: genericTypeKey('AdoptCurrency', params.coinType),
      payloadMoveType: `${p}::adopt_currency::AdoptCurrency<${params.coinType}>`,
      requiredPermissions: PERMISSIONS.VAULT_STORE,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${p}::adopt_currency::new`,
          typeArguments: [params.coinType],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${p}::currency_ops::execute_adopt_currency`,
          typeArguments: [params.coinType],
          arguments: [
            tx.object(params.capabilityVaultId),
            tx.object(params.treasuryCapId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/** Shared shape of the two mint payloads. */
function mintLike(
  pkgs: ArmaturePkgs,
  which: 'mint_coin' | 'mint_allowance',
  params: {
    coinType: string
    treasuryCapId: string
    amount: bigint
    recipient?: string
    capabilityVaultId: string
    treasuryVaultId: string
  },
): OuProposalAction {
  const { armatureProposals: p } = pkgs
  const struct = which === 'mint_coin' ? 'MintCoin' : 'MintAllowance'
  return {
    kind: which,
    own: {
      typeKey: genericTypeKey(struct, params.coinType),
      payloadMoveType: `${p}::${which}::${struct}<${params.coinType}>`,
      requiredPermissions: PERMISSIONS.VAULT_BORROW,
      requiredBorrowScope: [treasuryCapType(params.coinType)],
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${p}::${which}::new`,
          typeArguments: [params.coinType],
          arguments: [
            tx.pure.id(params.treasuryCapId),
            tx.pure.u64(params.amount),
            tx.pure.option('address', params.recipient ?? null),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${p}::currency_ops::execute_${which}`,
          typeArguments: [params.coinType],
          arguments: [
            tx.object(params.capabilityVaultId),
            tx.object(params.treasuryVaultId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Mint `amount` of the org's coin (`MintCoin<T>`) into its treasury, or to
 * `recipient` when given.
 */
export function mintCoinAction(
  pkgs: ArmaturePkgs,
  params: {
    coinType: string
    treasuryCapId: string
    amount: bigint
    recipient?: string
    capabilityVaultId: string
    treasuryVaultId: string
  },
): OuProposalAction {
  return mintLike(pkgs, 'mint_coin', params)
}

/**
 * `MintAllowance<T>` by vote — identical mechanics to {@link mintCoinAction}.
 * Its real use is the bypass path ({@link mintAllowanceBypassTx}).
 */
export function mintAllowanceAction(
  pkgs: ArmaturePkgs,
  params: {
    coinType: string
    treasuryCapId: string
    amount: bigint
    recipient?: string
    capabilityVaultId: string
    treasuryVaultId: string
  },
): OuProposalAction {
  return mintLike(pkgs, 'mint_allowance', params)
}

/** Withdraw `amount` of the org's coin from its treasury and burn it (`BurnCoin<T>`). */
export function burnCoinAction(
  pkgs: ArmaturePkgs,
  params: {
    coinType: string
    treasuryCapId: string
    amount: bigint
    capabilityVaultId: string
    treasuryVaultId: string
  },
): OuProposalAction {
  const { armatureProposals: p } = pkgs
  return {
    kind: 'burn_coin',
    own: {
      typeKey: genericTypeKey('BurnCoin', params.coinType),
      payloadMoveType: `${p}::burn_coin::BurnCoin<${params.coinType}>`,
      requiredPermissions:
        PERMISSIONS.TREASURY_WITHDRAW | PERMISSIONS.VAULT_BORROW,
      requiredBorrowScope: [treasuryCapType(params.coinType)],
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${p}::burn_coin::new`,
          typeArguments: [params.coinType],
          arguments: [
            tx.pure.id(params.treasuryCapId),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${p}::currency_ops::execute_burn_coin`,
          typeArguments: [params.coinType],
          arguments: [
            tx.object(params.capabilityVaultId),
            tx.object(params.treasuryVaultId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/** Give the `TreasuryCap<T>` back to an address (`ReturnCurrencyCap<T>`). */
export function returnCurrencyCapAction(
  pkgs: ArmaturePkgs,
  params: {
    coinType: string
    treasuryCapId: string
    recipient: string
    capabilityVaultId: string
  },
): OuProposalAction {
  const { armatureProposals: p } = pkgs
  return {
    kind: 'return_currency_cap',
    own: {
      typeKey: genericTypeKey('ReturnCurrencyCap', params.coinType),
      payloadMoveType: `${p}::return_currency_cap::ReturnCurrencyCap<${params.coinType}>`,
      requiredPermissions: PERMISSIONS.VAULT_EXTRACT,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${p}::return_currency_cap::new`,
          typeArguments: [params.coinType],
          arguments: [
            tx.pure.id(params.treasuryCapId),
            tx.pure.address(params.recipient),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${p}::currency_ops::execute_return_currency_cap`,
          typeArguments: [params.coinType],
          arguments: [tx.object(params.capabilityVaultId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Configure the `MintAllowance<T>` bypass (`ConfigureMintAllowance<T>`):
 * add/remove allowlisted minters (≤16 each per call, ≤32 total), set the
 * per-call cap and the kill-switch. Writes only its own type-state, so it
 * holds no bits.
 */
export function configureMintAllowanceAction(
  pkgs: ArmaturePkgs,
  params: {
    coinType: string
    addMinters?: string[]
    removeMinters?: string[]
    maxPerCall?: bigint
    enabled?: boolean
  },
): OuProposalAction {
  const { armatureProposals: p } = pkgs
  return {
    kind: 'configure_mint_allowance',
    own: {
      typeKey: genericTypeKey('ConfigureMintAllowance', params.coinType),
      payloadMoveType: `${p}::configure_mint_allowance::ConfigureMintAllowance<${params.coinType}>`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${p}::configure_mint_allowance::new`,
          typeArguments: [params.coinType],
          arguments: [
            tx.pure.vector('address', params.addMinters ?? []),
            tx.pure.vector('address', params.removeMinters ?? []),
            tx.pure.option('u64', params.maxPerCall ?? null),
            tx.pure.option('bool', params.enabled ?? null),
          ],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${p}::configure_mint_allowance::execute_configure_mint_allowance`,
          typeArguments: [params.coinType],
          arguments: [tx.object(ownDaoId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Mint WITHOUT a vote through the `MintAllowance<T>` bypass
 * (`currency_ops::mint_allowance_bypass`). Not governance: the sender must be
 * on the OU's minter allowlist, the allowance enabled, and `amount ≤
 * max_per_call`; the chain checks all three, then runs the usual freeze /
 * pause / cooldown checks. `bypassCapId` is the
 * `ExternalExecutionCap<MintAllowance<T>>` in the OU's vault.
 */
export function mintAllowanceBypassTx(args: {
  armatureProposals: string
  coinType: string
  ouId: string
  capabilityVaultId: string
  treasuryVaultId: string
  emergencyFreezeId: string
  bypassCapId: string
  treasuryCapId: string
  amount: bigint
  recipient?: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${args.armatureProposals}::currency_ops::mint_allowance_bypass`,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(args.ouId),
      tx.object(args.capabilityVaultId),
      tx.object(args.treasuryVaultId),
      tx.object(args.emergencyFreezeId),
      tx.pure.id(args.bypassCapId),
      tx.pure.id(args.treasuryCapId),
      tx.pure.u64(args.amount),
      tx.pure.option('address', args.recipient ?? null),
      tx.object(CLOCK_ID),
    ],
  })
  return tx
}

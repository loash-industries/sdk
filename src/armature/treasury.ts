import { bcs } from '@mysten/sui/bcs'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Transaction, coinWithBalance } from '@mysten/sui/transactions'

import { CLOCK_ID } from '../config'
import type { ArmaturePkgs } from './actions'
import { genericTypeKey, sendCoinToOuTypeKey, sendCoinTypeKey } from './actions'
import { PERMISSIONS } from './governance'
import type { OuProposalAction } from './harness'

/**
 * The organization treasury: reading what a `TreasuryVault` holds, funding it,
 * and paying out of it.
 *
 * Two very different authorization models sit side by side here, and the
 * asymmetry is the point. **Depositing is permissionless** — anyone can fund an
 * organization, no governance involved, so it is a plain `Transaction`.
 * **Paying out is governance**, so it is an `OuProposalAction` the resolver
 * carries like any other.
 *
 * Cycle 7: the treasury holds COINS only. Multicoin (item) balances moved to
 * armature-vault's `OuReceiptVault`, and the batch multicoin send types are
 * gone.
 */

// ─── Reads ──────────────────────────────────────────────────────────────────

/** One coin balance held by a treasury vault. */
export interface TreasuryCoinBalance {
  /** Move type name as the vault records it — see the note on original ids. */
  coinType: string
  amount: bigint
}

/**
 * A Move `type_name` string as the vault keys its coin balances by: the address
 * WITHOUT `0x`, zero-padded to 64, then the module and name.
 *
 * The vault uses `type_name::with_original_ids<T>()`, so the address is the
 * coin package's ORIGINAL id. For a package that has never been upgraded those
 * coincide; for one that has, passing the current id here silently reads a
 * balance that does not exist and reports 0.
 */
export function toTypeNameKey(coinType: string): string {
  const [address, ...rest] = coinType.split('::')
  const hex = address.replace(/^0x/i, '').toLowerCase().padStart(64, '0')
  return [hex, ...rest].join('::')
}

/** `sui::balance::Balance<T>` is a bare u64 in BCS. */
const BalanceBcs = bcs.u64()

/**
 * Every coin balance the treasury holds.
 *
 * The vault tracks its own `coin_types` set, so this enumerates from the object
 * itself rather than walking dynamic fields — one read plus one per distinct
 * coin, and no pagination. Cycle 7 drops a coin from the set when a
 * withdrawal drains it, so every entry is a non-zero balance.
 */
export async function fetchTreasuryCoinBalances(
  suiClient: ClientWithCoreApi,
  treasuryVaultId: string,
): Promise<TreasuryCoinBalance[]> {
  const { object } = await suiClient.core.getObject({
    objectId: treasuryVaultId,
    include: { json: true },
  })
  const json = (object.json ?? {}) as Record<string, unknown>
  // VecSet<ascii::String>; gRPC exposes `contents`, JSON-RPC nests in `fields`.
  const set = json.coin_types as
    { contents?: string[]; fields?: { contents?: string[] } } | undefined
  const typeKeys = set?.contents ?? set?.fields?.contents ?? []

  const out: TreasuryCoinBalance[] = []
  for (const typeKey of typeKeys) {
    const amount = await readCoinBalance(suiClient, treasuryVaultId, typeKey)
    out.push({ coinType: typeKey, amount })
  }
  return out
}

/** One coin's balance, or 0n when the vault holds none. */
export async function fetchTreasuryCoinBalance(
  suiClient: ClientWithCoreApi,
  treasuryVaultId: string,
  coinType: string,
): Promise<bigint> {
  return readCoinBalance(suiClient, treasuryVaultId, toTypeNameKey(coinType))
}

/** @internal — the `Balance<T>` dynamic field, keyed by an `ascii::String`. */
async function readCoinBalance(
  suiClient: ClientWithCoreApi,
  treasuryVaultId: string,
  typeNameKey: string,
): Promise<bigint> {
  const field = await suiClient.core
    .getDynamicField({
      parentId: treasuryVaultId,
      name: {
        type: '0x1::ascii::String',
        bcs: bcs.string().serialize(typeNameKey).toBytes(),
      },
    })
    .catch(() => null)
  if (!field) return 0n
  try {
    return BigInt(BalanceBcs.parse(field.dynamicField.value.bcs))
  } catch {
    return 0n
  }
}

// ─── Funding (permissionless) ───────────────────────────────────────────────

/**
 * Deposit a coin from the caller's wallet into an organization's treasury.
 *
 * PERMISSIONLESS — no board seat, no proposal, no governance. Anyone can fund
 * an organization, which is why this returns a plain `Transaction` rather than
 * an action.
 *
 * `useGasCoin: false` matters: under a gas station the gas coin belongs to the
 * sponsor, and a SUI-denominated deposit that split it would spend someone
 * else's money.
 */
export function depositToTreasuryTx(args: {
  armature: string
  treasuryVaultId: string
  coinType: string
  amount: bigint
}): Transaction {
  const tx = new Transaction()
  const coin = tx.add(
    coinWithBalance({
      type: args.coinType,
      balance: args.amount,
      useGasCoin: false,
    }),
  )
  tx.moveCall({
    target: `${args.armature}::treasury_vault::deposit`,
    typeArguments: [args.coinType],
    arguments: [tx.object(args.treasuryVaultId), coin],
  })
  return tx
}

/**
 * `treasury_vault::claim_coin<T>` for each coin object that was
 * `public_transfer`red to the treasury's ADDRESS (a common mistake when
 * "sending to the org") — pulls it into the vault's balance. Permissionless;
 * every coin must be of `coinType`.
 */
export function claimTreasuryCoinsTx(args: {
  armature: string
  treasuryVaultId: string
  coinType: string
  coinObjectIds: string[]
}): Transaction {
  const tx = new Transaction()
  for (const id of args.coinObjectIds) {
    tx.moveCall({
      target: `${args.armature}::treasury_vault::claim_coin`,
      typeArguments: [args.coinType],
      arguments: [tx.object(args.treasuryVaultId), tx.object(id)],
    })
  }
  return tx
}

// ─── Paying out (governance) ────────────────────────────────────────────────

/**
 * Pay `amount` of one coin from the unit's treasury to a wallet address.
 *
 * Own-only, and governance-sensitive: the type holds `TREASURY_WITHDRAW`
 * (enabled with `TREASURY_TYPE_CONFIG`, 80% approval), so on a real board this
 * resolves to a proposal rather than a single vote. That is the intended
 * shape — a treasury that one officer can drain alone is not a treasury.
 *
 * Requires `SendCoin<Coin>` enabled on the unit first (`types.enableSendCoin`).
 */
export function sendCoinAction(
  pkgs: ArmaturePkgs,
  params: {
    coinType: string
    recipient: string
    amount: bigint
    treasuryVaultId: string
  },
): OuProposalAction {
  const { armatureProposals } = pkgs
  return {
    kind: 'send_coin',
    own: {
      typeKey: sendCoinTypeKey(params.coinType),
      payloadMoveType: `${armatureProposals}::send_coin::SendCoin<${params.coinType}>`,
      requiredPermissions: PERMISSIONS.TREASURY_WITHDRAW,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armatureProposals}::send_coin::new`,
          typeArguments: [params.coinType],
          arguments: [
            tx.pure.address(params.recipient),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${armatureProposals}::treasury_ops::execute_send_coin`,
          typeArguments: [params.coinType],
          arguments: [tx.object(params.treasuryVaultId), ticket],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Move `amount` of one coin from this unit's treasury into ANOTHER
 * organization's treasury.
 *
 * The recipient is a `TreasuryVault` object id, not a wallet — that is the
 * whole difference from {@link sendCoinAction}, and passing a wallet address
 * here aborts on-chain. Requires `SendCoinToOU<Coin>` enabled on the source
 * unit.
 */
export function sendCoinToOuAction(
  pkgs: ArmaturePkgs,
  params: {
    coinType: string
    recipientTreasuryId: string
    amount: bigint
    treasuryVaultId: string
  },
): OuProposalAction {
  const { armatureProposals } = pkgs
  return {
    kind: 'send_coin_to_ou',
    own: {
      typeKey: sendCoinToOuTypeKey(params.coinType),
      payloadMoveType: `${armatureProposals}::send_coin_to_ou::SendCoinToOU<${params.coinType}>`,
      requiredPermissions: PERMISSIONS.TREASURY_WITHDRAW,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armatureProposals}::send_coin_to_ou::new`,
          typeArguments: [params.coinType],
          arguments: [
            tx.pure.id(params.recipientTreasuryId),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${armatureProposals}::treasury_ops::execute_send_coin_to_ou`,
          typeArguments: [params.coinType],
          arguments: [
            tx.object(params.treasuryVaultId),
            tx.object(params.recipientTreasuryId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/**
 * Pay a SMALL amount, rate-limited: `SendSmallPayment<T>` keeps per-epoch
 * spend state on the OU (24h epochs, 1% of the treasury's balance per
 * epoch, both fixed on-chain) and aborts once an epoch's cap would be exceeded. Meant
 * to be enabled with a lighter config than `SendCoin<T>` — it still holds
 * `TREASURY_WITHDRAW`, so its approval must be ≥ 80%.
 */
export function sendSmallPaymentAction(
  pkgs: ArmaturePkgs,
  params: {
    coinType: string
    recipient: string
    amount: bigint
    treasuryVaultId: string
  },
): OuProposalAction {
  const { armatureProposals } = pkgs
  return {
    kind: 'send_small_payment',
    own: {
      typeKey: genericTypeKey('SendSmallPayment', params.coinType),
      payloadMoveType: `${armatureProposals}::send_small_payment::SendSmallPayment<${params.coinType}>`,
      requiredPermissions: PERMISSIONS.TREASURY_WITHDRAW,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armatureProposals}::send_small_payment::new`,
          typeArguments: [params.coinType],
          arguments: [
            tx.pure.address(params.recipient),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${armatureProposals}::treasury_ops::execute_send_small_payment`,
          typeArguments: [params.coinType],
          arguments: [
            tx.object(ownDaoId),
            tx.object(params.treasuryVaultId),
            ticket,
            tx.object(CLOCK_ID),
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

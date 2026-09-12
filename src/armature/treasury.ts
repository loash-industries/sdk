import { bcs } from '@mysten/sui/bcs'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Transaction, coinWithBalance } from '@mysten/sui/transactions'

import type { ArmaturePkgs } from './actions'
import { sendCoinToDaoTypeKey, sendCoinTypeKey } from './actions'
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

/** `multicoin::Balance { id, collection, asset_id, amount }`. */
const MultiCoinBalanceBcs = bcs.struct('MultiCoinBalance', {
  id: bcs.Address,
  collection: bcs.Address,
  asset_id: bcs.u64(),
  amount: bcs.u64(),
})

const CollectionKeyBcs = bcs.struct('CollectionKey', {
  collection_id: bcs.Address,
})
const AssetKeyBcs = bcs.struct('AssetKey', { asset_id: bcs.u64() })

/**
 * Every coin balance the treasury holds.
 *
 * The vault tracks its own `coin_types` set, so this enumerates from the object
 * itself rather than walking dynamic fields — one read plus one per distinct
 * coin, and no pagination. Coins that were fully withdrawn may linger in the
 * set with a zero balance; they are returned as 0 rather than dropped, because
 * "held nothing" and "never held" are different answers.
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

/**
 * One multicoin (item) balance the treasury holds.
 *
 * Two hops on purpose: the vault keys a `CollectionRecord` object by collection,
 * and that record keys each asset's balance. Enumerating every item therefore
 * means listing the record's dynamic fields — not done here; ask for the assets
 * you care about.
 */
export async function fetchTreasuryItemBalance(
  suiClient: ClientWithCoreApi,
  treasuryVaultId: string,
  params: { collectionId: string; assetId: bigint },
): Promise<bigint> {
  const record = await suiClient.core
    .getDynamicField({
      parentId: treasuryVaultId,
      name: {
        type: 'CollectionKey',
        bcs: CollectionKeyBcs.serialize({
          collection_id: params.collectionId,
        }).toBytes(),
      },
    })
    .catch(() => null)
  if (!record) return 0n

  // A dynamic OBJECT field's value is the child object's id.
  let recordId: string
  try {
    recordId = bcs.Address.parse(record.dynamicField.value.bcs)
  } catch {
    return 0n
  }

  const balance = await suiClient.core
    .getDynamicField({
      parentId: recordId,
      name: {
        type: 'AssetKey',
        bcs: AssetKeyBcs.serialize({ asset_id: params.assetId }).toBytes(),
      },
    })
    .catch(() => null)
  if (!balance) return 0n
  try {
    return BigInt(
      MultiCoinBalanceBcs.parse(balance.dynamicField.value.bcs).amount,
    )
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

// ─── Paying out (governance) ────────────────────────────────────────────────

/**
 * Pay `amount` of one coin from the unit's treasury to a wallet address.
 *
 * Own-only, and governance-sensitive: the type is enabled with
 * `GOVERNANCE_TYPE_CONFIG`, so on a real board this resolves to a proposal
 * rather than a single vote. That is the intended shape — a treasury that one
 * officer can drain alone is not a treasury.
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
 * here aborts on-chain. `recipientTreasuryId` is a Move `ID`, which serialises
 * identically to an address.
 *
 * Requires `SendCoinToDAO<Coin>` enabled on the source unit.
 */
export function sendCoinToDaoAction(
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
    kind: 'send_coin_to_dao',
    own: {
      typeKey: sendCoinToDaoTypeKey(params.coinType),
      payloadMoveType: `${armatureProposals}::send_coin_to_dao::SendCoinToDAO<${params.coinType}>`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${armatureProposals}::send_coin_to_dao::new`,
          typeArguments: [params.coinType],
          arguments: [
            tx.pure.address(params.recipientTreasuryId),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${armatureProposals}::treasury_ops::execute_send_coin_to_dao`,
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

import type { ClientWithCoreApi } from '@mysten/sui/client'
import type {
  Transaction,
  TransactionObjectArgument,
} from '@mysten/sui/transactions'

import { TriexClientError, TriexError } from './errors'
import {
  fetchCharacterInfo,
  fetchInventorySlotQuantity,
  fetchSsuOwnerInfo,
  findOwnedItemReceipts,
  getBalanceManagerItemBalance,
  getObjectRef,
  getRegistryMulticoinCollectionId,
} from './onchain'
import { depositMulticoinObject, sourceItemsFromHangar } from './transactions'
import type { PackageIds } from './types'

/**
 * Impure PTB-input preparation: resolves live chain state and appends funding
 * moves to a caller-provided `Transaction`. Ported from triex-app-api's
 * production flows (`prepareWalletQuoteInput`, `depositItemsForSell`); nothing
 * here signs or submits.
 */

// ─── Currency funding ────────────────────────────────────────────────────────

/**
 * Split `amount` of a coin out of the owner's wallet, merging multiple Coin
 * objects into the first when no single object covers it (a wallet's balance
 * is spread across many). Returns the split coin argument for a deposit call.
 * Throws `InsufficientBalance` when the wallet total is short.
 */
export async function prepareWalletCoinInput(
  suiClient: ClientWithCoreApi,
  tx: Transaction,
  owner: string,
  coinType: string,
  amount: bigint,
  insufficientMessage = 'Insufficient wallet balance to fund this transaction.',
): Promise<TransactionObjectArgument> {
  const core = (suiClient as any).core
  const funding: { objectId: string; balance: bigint }[] = []
  let total = 0n
  let cursor: string | null | undefined
  for (let i = 0; i < 40 && total < amount; i++) {
    const page = await core.listCoins({
      owner,
      coinType,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    })
    for (const c of page?.objects ?? []) {
      funding.push({ objectId: c.objectId, balance: BigInt(c.balance) })
      total += BigInt(c.balance)
      if (total >= amount) break
    }
    const hasNext = page?.hasNextPage ?? page?.pageInfo?.hasNextPage
    cursor = page?.cursor ?? page?.pageInfo?.endCursor
    if (!hasNext || !cursor || (page?.objects?.length ?? 0) === 0) break
  }

  if (total < amount) {
    throw new TriexClientError(
      TriexError.InsufficientBalance,
      `${insufficientMessage} (need ${amount}, wallet holds ${total}).`,
    )
  }

  const primary = tx.object(funding[0].objectId)
  if (funding.length > 1) {
    tx.mergeCoins(
      primary,
      funding.slice(1).map((c) => tx.object(c.objectId)),
    )
  }
  const [split] = tx.splitCoins(primary, [tx.pure.u64(amount)])
  return split
}

// ─── Item funding (wallet receipts → SSU/character hangar) ───────────────────

export interface SourceItemsParams {
  owner: string
  /** SSU object id (0x-padded 64-hex). */
  ssuObjectId: string
  vaultConfigId: string
  vaultCollectionId: string
  assetId: bigint
  /** Total amount that must newly arrive in the balance manager. */
  amount: bigint
  /** Resolved BM id, or null when the BM is being created in this PTB. */
  balanceManagerId: string | null
  /**
   * When true, the target is "BM holds ≥ amount" (sell funding): the current
   * BM item balance counts toward it. When false (plain deposit), the full
   * `amount` is sourced regardless of what the BM already holds.
   */
  deficitMode?: boolean
}

/**
 * Ensure the balance manager receives `amount` of `assetId`, sourcing in
 * priority order (exactly the app's sell-funding flow):
 *   1. Wallet-held `multicoin::Balance` receipts in the market's collection.
 *   2. SSU hangar slot (via SSU OwnerCap) — only when the player owns the hub.
 *   3. Character hangar slot (via Character OwnerCap).
 *
 * Appends moves to `tx` in place; nothing is submitted. Throws typed
 * `InsufficientBalance` / `CollectionMismatch` / `CharacterNotFound` errors.
 */
export async function sourceItemsIntoBalanceManager(
  suiClient: ClientWithCoreApi,
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  params: SourceItemsParams,
): Promise<void> {
  const { assetId, amount } = params
  if (amount <= 0n) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      'Item amount must be positive.',
    )
  }

  const bmState =
    params.deficitMode && params.balanceManagerId
      ? await getBalanceManagerItemBalance(
          suiClient,
          ids,
          params.balanceManagerId,
          params.vaultCollectionId,
          assetId,
        )
      : { hasKey: false, balance: 0n }

  let remainingDeficit = params.deficitMode
    ? amount - bmState.balance
    : amount
  if (remainingDeficit <= 0n) return

  // ── Step 1: wallet receipts (market collection only) ───────────────────────
  const receipts = await findOwnedItemReceipts(suiClient, ids, params.owner, {
    assetId: assetId.toString(),
  })
  const wantedCollection = (
    params.vaultCollectionId ||
    (await getRegistryMulticoinCollectionId(suiClient, ids))
  )
    .trim()
    .toLowerCase()

  const usable = receipts
    .filter(
      (r) =>
        r.amount > 0n &&
        (!r.collectionId || r.collectionId.toLowerCase() === wantedCollection),
    )
    // Greedy largest-first to minimize deposited objects.
    .sort((a, b) => (a.amount > b.amount ? -1 : 1))

  let fromWallet = 0n
  for (const r of usable) {
    if (fromWallet >= remainingDeficit) break
    depositMulticoinObject(tx, ids, bm, r.objectId)
    fromWallet += r.amount
  }
  remainingDeficit -= fromWallet
  if (remainingDeficit <= 0n) return

  // ── Step 2: SSU / character hangar (borrow cap → receipt → deposit) ────────
  const [ssuOwnerInfo, charInfo] = await Promise.all([
    fetchSsuOwnerInfo(suiClient, params.ssuObjectId, params.owner),
    fetchCharacterInfo(suiClient, ids, params.owner),
  ])

  const addHangarBlock = async (
    capObjectId: string,
    capTypeArg: string,
    characterId: string,
    take: bigint,
  ) => {
    const capRef = await getObjectRef(suiClient, capObjectId)
    sourceItemsFromHangar(tx, ids, bm, {
      ssuObjectId: params.ssuObjectId,
      characterId,
      capRef,
      capTypeArg,
      vaultConfigId: params.vaultConfigId,
      vaultCollectionId: params.vaultCollectionId,
      assetId,
      amount: Number(take),
    })
  }

  const ssuCapType = `${ids.worldOriginal}::storage_unit::StorageUnit`
  const charCapType = `${ids.worldOriginal}::character::Character`

  if (ssuOwnerInfo) {
    // Player owns this hub: drain the SSU slot first, then the character slot.
    const [ssuSlotQty, charSlotQty] = await Promise.all([
      fetchInventorySlotQuantity(
        suiClient,
        params.ssuObjectId,
        ssuOwnerInfo.ssuOwnerCapId,
        assetId.toString(),
      ),
      fetchInventorySlotQuantity(
        suiClient,
        params.ssuObjectId,
        ssuOwnerInfo.charOwnerCapId,
        assetId.toString(),
      ),
    ])

    const fromSsu = ssuSlotQty >= remainingDeficit ? remainingDeficit : ssuSlotQty
    const stillNeeded = remainingDeficit - fromSsu
    const fromChar = stillNeeded <= charSlotQty ? stillNeeded : charSlotQty

    if (fromSsu + fromChar < remainingDeficit) {
      throw new TriexClientError(
        TriexError.InsufficientBalance,
        `Insufficient items in the hub inventory (SSU slot: ${ssuSlotQty}, character slot: ${charSlotQty}, needed: ${remainingDeficit}).`,
      )
    }
    if (fromSsu > 0n) {
      await addHangarBlock(
        ssuOwnerInfo.ssuOwnerCapId,
        ssuCapType,
        ssuOwnerInfo.characterId,
        fromSsu,
      )
    }
    if (fromChar > 0n) {
      await addHangarBlock(
        ssuOwnerInfo.charOwnerCapId,
        charCapType,
        ssuOwnerInfo.characterId,
        fromChar,
      )
    }
    return
  }

  if (charInfo) {
    const slotQty = await fetchInventorySlotQuantity(
      suiClient,
      params.ssuObjectId,
      charInfo.ownerCapId,
      assetId.toString(),
    )
    if (slotQty < remainingDeficit) {
      throw new TriexClientError(
        TriexError.InsufficientBalance,
        `Insufficient items (need ${amount}, BM holds ${bmState.balance}, wallet receipts cover ${fromWallet}, hangar slot holds ${slotQty}).`,
      )
    }
    await addHangarBlock(
      charInfo.ownerCapId,
      charCapType,
      charInfo.characterId,
      remainingDeficit,
    )
    return
  }

  // Neither wallet nor hangar can cover the remainder.
  const otherCollections = receipts.filter(
    (r) => r.collectionId && r.collectionId.toLowerCase() !== wantedCollection,
  )
  if (fromWallet === 0n && otherCollections.length > 0) {
    const summary = otherCollections
      .slice(0, 5)
      .map((r) => `${r.collectionId}=${r.amount}`)
      .join(', ')
    throw new TriexClientError(
      TriexError.CollectionMismatch,
      `You own item receipts for asset ${assetId}, but in a different MultiCoin collection than this market trades. Expected ${wantedCollection}; found: ${summary}.`,
    )
  }
  throw new TriexClientError(
    TriexError.CharacterNotFound,
    `Insufficient wallet receipts (cover ${fromWallet} of ${amount}) and no on-chain character resolved for ${params.owner} to draw hangar items from.`,
  )
}

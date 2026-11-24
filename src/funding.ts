import type { ClientWithCoreApi } from '@mysten/sui/client'
import type {
  Transaction,
  TransactionArgument,
  TransactionObjectArgument,
} from '@mysten/sui/transactions'

import { TriexClientError, TriexError } from './errors'
import {
  fetchCharacterInfo,
  fetchInventorySlotQuantity,
  fetchSsuOwnerInfo,
  findOwnedItemReceipts,
  getTradingAccountItemBalance,
  getObjectRef,
} from './onchain'
import {
  depositHangarReceipt,
  depositMulticoinObject,
  sourceItemsFromHangar,
} from './transactions'
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
  /** Total amount that must newly arrive in the trading account. */
  amount: bigint
  /** Resolved BM id, or null when the BM is being created in this PTB. */
  tradingAccountId: string | null
  /**
   * When true, the target is "BM holds ≥ amount" (sell funding): the current
   * BM item balance counts toward it. When false (plain deposit), the full
   * `amount` is sourced regardless of what the BM already holds.
   */
  deficitMode?: boolean
}

/**
 * Ensure the trading account receives `amount` of `assetId`, sourcing in
 * priority order (exactly the app's sell-funding flow):
 *   1. Wallet-held `multicoin::Balance` receipts in the market's collection.
 *   2. SSU hangar slot (via SSU OwnerCap) — only when the player owns the hub.
 *   3. Character hangar slot (via Character OwnerCap).
 *
 * Appends moves to `tx` in place; nothing is submitted. Throws typed
 * `InsufficientBalance` / `CollectionMismatch` / `CharacterNotFound` errors.
 */
export async function sourceItemsIntoTradingAccount(
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
  // The market's collection is the hub vault's — cycle 7 dropped the
  // registry-wide `MultiCoinCollectionKey`, so pools may trade any collection.
  const wantedCollection = params.vaultCollectionId.trim().toLowerCase()
  if (!wantedCollection) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      'vaultCollectionId is required to source items for a market.',
    )
  }

  const bmState =
    params.deficitMode && params.tradingAccountId
      ? await getTradingAccountItemBalance(
          suiClient,
          ids,
          params.tradingAccountId,
          params.vaultCollectionId,
          assetId,
        )
      : { hasKey: false, balance: 0n }

  let remainingDeficit = params.deficitMode ? amount - bmState.balance : amount
  if (remainingDeficit <= 0n) return

  // ── Step 1: wallet receipts (market collection only) ───────────────────────
  const receipts = await findOwnedItemReceipts(suiClient, ids, params.owner, {
    assetId: assetId.toString(),
  })

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

    const fromSsu =
      ssuSlotQty >= remainingDeficit ? remainingDeficit : ssuSlotQty
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

// ─── Item balances (wallet receipts → hangar) ────────────────────────────────

export interface SourceItemBalanceParams {
  owner: string
  /** The receipt collection the balance must be in (a hub vault's). */
  collectionId: string
  assetId: bigint
  /** Exactly this many units. */
  quantity: bigint
  /**
   * Draw what wallet receipts can't cover from this hub's hangar (the
   * owner's storage-unit slot first when they own the hub, then their
   * character's slot), depositing it into a receipt in the same transaction.
   * Omitted: wallet receipts only.
   */
  hangar?: { ssuObjectId: string; vaultConfigId: string }
}

/**
 * One `multicoin::Balance` of exactly `quantity` units of `assetId` in
 * `collectionId`, built in `tx` — for hauling cargo and deliveries, which
 * take balances rather than a trading account.
 *
 * Wallet receipts go first, largest first, joined and split to the exact
 * amount (the remainder stays in the wallet); the hangar covers the rest when
 * `hangar` is given. Ported from triex-app-api's `receiptBalanceArg` /
 * `hangarBalanceArgs`.
 * @throws `ValidationFailed` for a non-positive quantity;
 *   `InsufficientBalance` when wallet and hangar together fall short.
 */
export async function sourceItemBalance(
  suiClient: ClientWithCoreApi,
  tx: Transaction,
  ids: PackageIds,
  params: SourceItemBalanceParams,
): Promise<TransactionArgument> {
  const { quantity, assetId } = params
  if (quantity <= 0n) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      'Item quantity must be positive.',
    )
  }
  const collection = params.collectionId.trim().toLowerCase()
  const receipts = (
    await findOwnedItemReceipts(suiClient, ids, params.owner, {
      assetId: assetId.toString(),
    })
  )
    .filter(
      (r) => r.amount > 0n && r.collectionId?.toLowerCase() === collection,
    )
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0))

  const used: typeof receipts = []
  let fromWallet = 0n
  for (const r of receipts) {
    if (fromWallet >= quantity) break
    used.push(r)
    fromWallet += r.amount
  }

  // Wallet receipts alone cover it: join, then split off exactly `quantity`.
  let walletPart: TransactionObjectArgument | null = null
  if (used.length) {
    const primary = tx.object(used[0].objectId)
    for (const r of used.slice(1)) {
      tx.moveCall({
        target: `${ids.multicoin}::multicoin::join_entry`,
        arguments: [primary, tx.object(r.objectId)],
      })
    }
    const take = fromWallet >= quantity ? quantity : fromWallet
    walletPart =
      fromWallet === take
        ? primary
        : (tx.moveCall({
            target: `${ids.multicoin}::multicoin::split`,
            arguments: [primary, tx.pure.u64(take)],
          })[0] as TransactionObjectArgument)
    if (fromWallet >= quantity) return walletPart
  }

  const remaining = quantity - fromWallet
  if (!params.hangar) {
    throw new TriexClientError(
      TriexError.InsufficientBalance,
      `Wallet receipts hold ${fromWallet} of asset ${assetId} in collection ${params.collectionId}; ${quantity} are needed. Pass a hangar to draw the rest from.`,
    )
  }
  const { ssuObjectId, vaultConfigId } = params.hangar
  const ssuCapType = `${ids.worldOriginal}::storage_unit::StorageUnit`
  const charCapType = `${ids.worldOriginal}::character::Character`

  // Which slots to draw from, in order: (cap, cap type, character, take).
  const draws: [string, string, string, bigint][] = []
  const ssuOwner = await fetchSsuOwnerInfo(suiClient, ssuObjectId, params.owner)
  if (ssuOwner) {
    const [ssuQty, charQty] = await Promise.all([
      fetchInventorySlotQuantity(
        suiClient,
        ssuObjectId,
        ssuOwner.ssuOwnerCapId,
        assetId.toString(),
      ),
      fetchInventorySlotQuantity(
        suiClient,
        ssuObjectId,
        ssuOwner.charOwnerCapId,
        assetId.toString(),
      ),
    ])
    const fromSsu = ssuQty >= remaining ? remaining : ssuQty
    const fromChar = remaining - fromSsu
    if (fromChar > charQty) {
      throw new TriexClientError(
        TriexError.InsufficientBalance,
        `Insufficient items for asset ${assetId}: wallet receipts ${fromWallet}, storage-unit slot ${ssuQty}, character slot ${charQty}; ${quantity} are needed.`,
      )
    }
    if (fromSsu > 0n) {
      draws.push([
        ssuOwner.ssuOwnerCapId,
        ssuCapType,
        ssuOwner.characterId,
        fromSsu,
      ])
    }
    if (fromChar > 0n) {
      draws.push([
        ssuOwner.charOwnerCapId,
        charCapType,
        ssuOwner.characterId,
        fromChar,
      ])
    }
  } else {
    const character = await fetchCharacterInfo(suiClient, ids, params.owner)
    if (!character) {
      throw new TriexClientError(
        TriexError.CharacterNotFound,
        `Wallet receipts cover ${fromWallet} of ${quantity}, and no on-chain character resolved for ${params.owner} to draw hangar items from.`,
      )
    }
    const slot = await fetchInventorySlotQuantity(
      suiClient,
      ssuObjectId,
      character.ownerCapId,
      assetId.toString(),
    )
    if (slot < remaining) {
      throw new TriexClientError(
        TriexError.InsufficientBalance,
        `Insufficient items for asset ${assetId}: wallet receipts ${fromWallet}, hangar slot ${slot}; ${quantity} are needed.`,
      )
    }
    draws.push([
      character.ownerCapId,
      charCapType,
      character.characterId,
      remaining,
    ])
  }

  let result: TransactionObjectArgument | null = walletPart
  for (const [capId, capTypeArg, characterId, take] of draws) {
    if (take > 0xffff_ffffn) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `A hangar draw is at most ${0xffff_ffff} units (u32); asked for ${take}.`,
      )
    }
    const receipt = depositHangarReceipt(tx, ids, {
      ssuObjectId,
      characterId,
      capRef: await getObjectRef(suiClient, capId),
      capTypeArg,
      vaultConfigId,
      vaultCollectionId: params.collectionId,
      assetId,
      amount: Number(take),
    })
    if (result) {
      tx.moveCall({
        target: `${ids.multicoin}::multicoin::join_entry`,
        arguments: [receipt, result],
      })
    }
    result = receipt
  }
  return result!
}

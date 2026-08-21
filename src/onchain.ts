import { bcs } from '@mysten/sui/bcs'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import type { PackageIds } from './types'

/**
 * Fullnode (head-current) reads and object resolution, ported from
 * triex-app-api's production trading code (`useTriexbookMulticoinOrders.ts`,
 * `UserBalanceMeta.tsx`, `suiTradeBalances.ts`, `sweepAllTx.ts`).
 *
 * Everything transaction-building needs from the chain lives here: currency
 * and item balances, character / owner-cap resolution, hangar contents, and
 * receipt scans. Currency balances are fullnode reads by design — the indexer
 * serves item balances only, and write-flow deficit math must be head-current
 * (DESIGN.md §12).
 *
 * The unified (gRPC-era) Sui client takes dynamic-field names as BCS bytes and
 * returns values as BCS bytes, so the exact Move layouts are declared here:
 *   triexbook/sources/balance_manager.move
 *     `BalanceKey<phantom T> {}`                 (empty struct — one dummy bool)
 *     `MultiCoinBalanceKey { collection_id: ID, asset_id: u64 }`
 *   triexbook/sources/registry.move
 *     `MultiCoinCollectionKey {}`                (empty struct)
 *   multicoin/sources/multicoin.move
 *     `Balance { id: UID, collection: ID, asset_id: u64, amount: u64 }`
 *   sui::balance::Balance<T> is a bare u64 in BCS.
 */

// ─── BCS layouts ─────────────────────────────────────────────────────────────

const BalanceKeyBcs = bcs.struct('BalanceKey', {
  dummy_field: bcs.bool(),
})

/** Serialized name bytes for any empty-struct dynamic-field key. */
export function serializeBalanceKey(): Uint8Array {
  return BalanceKeyBcs.serialize({ dummy_field: false }).toBytes()
}

/** `balance_manager::MultiCoinBalanceKey { collection_id, asset_id }`. */
const MultiCoinBalanceKeyBcs = bcs.struct('MultiCoinBalanceKey', {
  collection_id: bcs.Address,
  asset_id: bcs.u64(),
})

export function serializeMultiCoinBalanceKey(
  collectionId: string,
  assetId: bigint,
): Uint8Array {
  return MultiCoinBalanceKeyBcs.serialize({
    collection_id: collectionId,
    asset_id: assetId,
  }).toBytes()
}

/** `multicoin::Balance { id, collection, asset_id, amount }`. */
export const MultiCoinBalanceBcs = bcs.struct('MultiCoinBalance', {
  id: bcs.Address,
  collection: bcs.Address,
  asset_id: bcs.u64(),
  amount: bcs.u64(),
})

/** `sui::balance::Balance<T>` — a bare u64 in BCS. */
const SuiBalanceBcs = bcs.u64()

// ─── JSON unwrap helpers (Move struct JSON shapes vary by client/kind) ───────

function unwrapMoveFields(value: unknown): any {
  if (value && typeof value === 'object' && 'fields' in value) {
    return (value as any).fields
  }
  return value as any
}

function tryIdToString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const v = value as any
    if (typeof v.objectId === 'string') return v.objectId
    if (typeof v.id === 'string') return v.id
    if (typeof v.bytes === 'string') return v.bytes
    if (v.id) return tryIdToString(v.id)
  }
  return null
}

const core = (suiClient: ClientWithCoreApi) => (suiClient as any).core

/**
 * Normalize a storage-unit identifier to a 0x-padded 64-hex Sui object id.
 * Accepts either the on-chain object id (passes through, normalized) or the
 * game's decimal SSU id (converted, matching the app's derivation).
 */
export function toSsuObjectId(storageUnitId: string): string {
  return '0x' + BigInt(storageUnitId).toString(16).padStart(64, '0')
}

/** Object reference (id/version/digest) — the shape `tx.receivingRef` needs. */
export interface ObjectRef {
  objectId: string
  version: string
  digest: string
}

/** Fetch a live object reference for `tx.receivingRef` (throws if missing). */
export async function getObjectRef(
  suiClient: ClientWithCoreApi,
  objectId: string,
): Promise<ObjectRef> {
  const { object } = await core(suiClient).getObject({ objectId })
  return {
    objectId: object.objectId,
    version: object.version,
    digest: object.digest,
  }
}

// ─── Currency balances ───────────────────────────────────────────────────────

/**
 * Total CRED held as wallet `Coin` objects for `address`, summed across all
 * coin objects (a wallet's balance is typically spread over many).
 */
export async function getWalletCurrencyBalance(
  suiClient: ClientWithCoreApi,
  address: string,
  coinType: string,
): Promise<bigint> {
  let total = 0n
  let cursor: string | null | undefined
  for (let i = 0; i < 40; i++) {
    const page = await core(suiClient).listCoins({
      owner: address,
      coinType,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    })
    for (const c of page?.objects ?? []) total += BigInt(c.balance)
    const hasNext = page?.hasNextPage ?? page?.pageInfo?.hasNextPage
    cursor = page?.cursor ?? page?.pageInfo?.endCursor
    if (!hasNext || !cursor || (page?.objects?.length ?? 0) === 0) break
  }
  return total
}

/**
 * CRED held inside a balance manager, read via the BM's `balances` Bag:
 * `BalanceKey<CRED>` → `sui::balance::Balance<CRED>` (bare u64). Returns 0n
 * when the BM has no CRED entry (or the object cannot be read).
 */
export async function getBalanceManagerCurrencyBalance(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  balanceManagerId: string,
): Promise<bigint> {
  const bmObj = await core(suiClient)
    .getObject({ objectId: balanceManagerId, include: { json: true } })
    .catch(() => null)

  const bmFields = bmObj?.object?.json
  const balancesBag = unwrapMoveFields(bmFields?.balances)
  const balancesBagId = tryIdToString(balancesBag?.id)
  if (!balancesBagId) return 0n

  const keyType = `${ids.triexbook}::balance_manager::BalanceKey<${ids.credCoinType}>`
  const df = await core(suiClient)
    .getDynamicField({
      parentId: balancesBagId,
      name: { type: keyType, bcs: serializeBalanceKey() },
    })
    .catch(() => null)

  if (!df) return 0n
  return BigInt(SuiBalanceBcs.parse(df.dynamicField.value.bcs))
}

// ─── Item balances ───────────────────────────────────────────────────────────

/**
 * Item balance held inside a balance manager for one (collection, asset).
 * `MultiCoinBalanceKey → multicoin::Balance` is a dynamic *object* field; the
 * child's content is BCS-decoded (mirrors the app / server).
 */
export async function getBalanceManagerItemBalance(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  balanceManagerId: string,
  collectionId: string,
  assetId: bigint,
): Promise<{ hasKey: boolean; balance: bigint }> {
  const keyType = `${ids.triexbook}::balance_manager::MultiCoinBalanceKey`
  const resp = await core(suiClient)
    .getDynamicObjectField({
      parentId: balanceManagerId,
      name: {
        type: keyType,
        bcs: serializeMultiCoinBalanceKey(collectionId, assetId),
      },
      include: { content: true },
    })
    .catch(() => null)

  if (!resp) return { hasKey: false, balance: 0n }
  const bal = MultiCoinBalanceBcs.parse(resp.object.content)
  return { hasKey: true, balance: BigInt(bal.amount) }
}

/**
 * The registry's canonical MultiCoin collection id — the collection triexbook
 * markets trade against (singleton `MultiCoinCollectionKey` dynamic field).
 */
export async function getRegistryMulticoinCollectionId(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
): Promise<string> {
  const keyType = `${ids.triexbook}::registry::MultiCoinCollectionKey`
  const resp = await core(suiClient)
    .getDynamicField({
      parentId: ids.triexRegistry,
      name: { type: keyType, bcs: serializeBalanceKey() },
    })
    .catch(() => null)
  if (!resp) {
    throw new Error(
      'Registry MultiCoin collection id not found (registry not initialized?).',
    )
  }
  return bcs.Address.parse(resp.dynamicField.value.bcs)
}

/** One wallet-held item receipt (`multicoin::Balance` object). */
export interface OwnedItemReceipt {
  objectId: string
  collectionId: string
  assetId: string
  amount: bigint
}

/**
 * Scan the wallet's `multicoin::Balance` receipt objects, optionally filtered
 * by asset id. Paginates the full owner set (matches the app's
 * `fetchItemBalanceByAssetId`).
 */
export async function findOwnedItemReceipts(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  owner: string,
  filter?: { assetId?: string },
): Promise<OwnedItemReceipt[]> {
  const type = `${ids.multicoin}::multicoin::Balance`
  const out: OwnedItemReceipt[] = []
  let cursor: string | null | undefined
  for (let i = 0; i < 40; i++) {
    const page = await core(suiClient).listOwnedObjects({
      owner,
      type,
      limit: 50,
      include: { content: true },
      ...(cursor ? { cursor } : {}),
    })
    for (const obj of page?.objects ?? []) {
      try {
        const parsed = MultiCoinBalanceBcs.parse(obj.content)
        if (filter?.assetId && String(parsed.asset_id) !== filter.assetId) {
          continue
        }
        out.push({
          objectId: obj.objectId,
          collectionId: parsed.collection,
          assetId: String(parsed.asset_id),
          amount: BigInt(parsed.amount),
        })
      } catch {
        // Not a decodable receipt — skip.
      }
    }
    const hasNext = page?.hasNextPage ?? page?.pageInfo?.hasNextPage
    cursor = page?.cursor ?? page?.pageInfo?.endCursor
    if (!hasNext || !cursor || (page?.objects?.length ?? 0) === 0) break
  }
  return out
}

// ─── Character / owner-cap resolution ────────────────────────────────────────

export interface CharacterInfo {
  characterId: string
  ownerCapId: string
}

/**
 * Find the player's Character id and Character OwnerCap id via their
 * PlayerProfile (checked under both the original and current world package).
 */
export async function fetchCharacterInfo(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  ownerAddress: string,
): Promise<CharacterInfo | null> {
  const pkgIds = [ids.worldOriginal]
  if (ids.world !== ids.worldOriginal) pkgIds.push(ids.world)

  for (const pkgId of pkgIds) {
    const profileType = `${pkgId}::character::PlayerProfile`
    const profilePage = await core(suiClient)
      .listOwnedObjects({
        owner: ownerAddress,
        type: profileType,
        include: { json: true },
        limit: 1,
      })
      .catch(() => null)

    const profileFields = profilePage?.objects?.[0]?.json
    const characterId =
      typeof profileFields?.character_id === 'string'
        ? profileFields.character_id
        : null
    if (!characterId) continue

    const charObj = await core(suiClient)
      .getObject({ objectId: characterId, include: { json: true } })
      .catch(() => null)
    const capId = charObj?.object?.json?.owner_cap_id
    if (typeof capId === 'string') return { characterId, ownerCapId: capId }
  }
  return null
}

/** Owner-cap info when the player owns the storage unit itself. */
export interface SsuOwnerInfo {
  ssuOwnerCapId: string
  characterId: string
  charOwnerCapId: string
}

/**
 * Resolve the SSU's OwnerCap → holding Character → Character OwnerCap chain,
 * returning null unless that Character belongs to `accountAddress` (i.e. the
 * player owns this storage unit).
 */
export async function fetchSsuOwnerInfo(
  suiClient: ClientWithCoreApi,
  ssuObjectId: string,
  accountAddress: string,
): Promise<SsuOwnerInfo | null> {
  const ssuObj = await core(suiClient)
    .getObject({ objectId: ssuObjectId, include: { json: true } })
    .catch(() => null)
  const ssuOwnerCapId = ssuObj?.object?.json?.owner_cap_id
  if (typeof ssuOwnerCapId !== 'string') return null

  // The cap is typically held by a Character via
  // transfer::transfer(cap, id_address(character)) → AddressOwner.
  const capObj = await core(suiClient)
    .getObject({ objectId: ssuOwnerCapId })
    .catch(() => null)
  const capOwner = capObj?.object?.owner
  if (!capOwner || typeof capOwner !== 'object') return null

  let possibleCharacterId: string | null = null
  if (capOwner.AddressOwner) {
    if (capOwner.AddressOwner === accountAddress) return null
    possibleCharacterId = capOwner.AddressOwner
  } else if (capOwner.ObjectOwner) {
    possibleCharacterId = capOwner.ObjectOwner
  }
  if (!possibleCharacterId) return null

  const charObj = await core(suiClient)
    .getObject({ objectId: possibleCharacterId, include: { json: true } })
    .catch(() => null)
  const charFields = charObj?.object?.json
  if (charFields?.character_address !== accountAddress) return null

  const charOwnerCapId = charFields?.owner_cap_id
  if (typeof charOwnerCapId !== 'string') return null

  return { ssuOwnerCapId, characterId: possibleCharacterId, charOwnerCapId }
}

/**
 * Sum items matching `assetId` in an SSU hangar slot keyed by an OwnerCap id.
 * The slot is a plain dynamic field `Field<0x2::object::ID, Inventory>` whose
 * flattened JSON is `{ …, value: { items: { contents: [{ key, value }] } } }`.
 */
export async function fetchInventorySlotQuantity(
  suiClient: ClientWithCoreApi,
  ssuObjectId: string,
  ownerCapId: string,
  assetId: string,
): Promise<bigint> {
  const df = await core(suiClient)
    .getDynamicField({
      parentId: ssuObjectId,
      name: {
        type: '0x2::object::ID',
        bcs: bcs.Address.serialize(ownerCapId).toBytes(),
      },
    })
    .catch(() => null)
  if (!df) return 0n

  const res = await core(suiClient)
    .getObject({ objectId: df.dynamicField.fieldId, include: { json: true } })
    .catch(() => null)
  const contents: any[] = res?.object?.json?.value?.items?.contents ?? []

  let total = 0n
  for (const entry of contents) {
    const typeId = String(entry?.value?.type_id ?? '')
    if (typeId !== assetId) continue
    total += BigInt(String(entry?.value?.quantity ?? '0'))
  }
  return total
}

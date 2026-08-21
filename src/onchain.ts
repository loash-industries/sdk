import { bcs } from '@mysten/sui/bcs'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import type { PackageIds } from './types'

/**
 * Fullnode (head-current) balance reads, ported from triex-app-api's
 * production trading hooks. Currency (CRED) balances live here and NOT on the
 * indexer: `/v1/inventory/balances` serves item balances only, and write-flow
 * deficit math must be head-current anyway (DESIGN.md §12).
 *
 * The unified (gRPC-era) Sui client takes dynamic-field names as BCS bytes and
 * returns values as BCS bytes, so the exact Move layouts are declared here:
 *   triexbook/sources/balance_manager.move
 *     `BalanceKey<phantom T> {}`   (empty struct — a single dummy bool in BCS)
 *   sui::balance::Balance<T> is a bare u64 in BCS.
 */

/** `balance_manager::BalanceKey<phantom T>` — empty Move struct. */
const BalanceKeyBcs = bcs.struct('BalanceKey', {
  dummy_field: bcs.bool(),
})

/** Serialized name bytes for a `BalanceKey<T>` dynamic field (type-independent). */
export function serializeBalanceKey(): Uint8Array {
  return BalanceKeyBcs.serialize({ dummy_field: false }).toBytes()
}

/** `sui::balance::Balance<T>` — a bare u64 in BCS. */
const SuiBalanceBcs = bcs.u64()

/** Move struct JSON arrives either as `{ fields: {...} }` or unwrapped. */
function unwrapMoveFields(value: unknown): any {
  if (value && typeof value === 'object' && 'fields' in value) {
    return (value as any).fields
  }
  return value as any
}

/** Object ids appear as strings or as `{ id }` / `{ objectId }` / `{ bytes }`. */
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

/**
 * Total CRED held as wallet `Coin` objects for `address`, summed across all
 * coin objects (a wallet's balance is typically spread over many).
 */
export async function getWalletCurrencyBalance(
  suiClient: ClientWithCoreApi,
  address: string,
  coinType: string,
): Promise<bigint> {
  const core = (suiClient as any).core
  let total = 0n
  let cursor: string | undefined
  // Bounded pagination: follows `pageInfo` when the client exposes it.
  for (let i = 0; i < 20; i++) {
    const page = await core.listCoins({
      owner: address,
      coinType,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    })
    for (const c of page?.objects ?? []) total += BigInt(c.balance)
    if (!page?.pageInfo?.hasNextPage || !page?.pageInfo?.endCursor) break
    cursor = page.pageInfo.endCursor
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
  const core = (suiClient as any).core
  const bmObj = await core
    .getObject({ objectId: balanceManagerId, include: { json: true } })
    .catch(() => null)

  const bmFields = bmObj?.object?.json
  const balancesBag = unwrapMoveFields(bmFields?.balances)
  const balancesBagId = tryIdToString(balancesBag?.id)
  if (!balancesBagId) return 0n

  const keyType = `${ids.triexbook}::balance_manager::BalanceKey<${ids.credCoinType}>`
  const df = await core
    .getDynamicField({
      parentId: balancesBagId,
      name: { type: keyType, bcs: serializeBalanceKey() },
    })
    .catch(() => null)

  if (!df) return 0n
  return BigInt(SuiBalanceBcs.parse(df.dynamicField.value.bcs))
}

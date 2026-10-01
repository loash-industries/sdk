import { bcs } from '@mysten/sui/bcs'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'

import { TriexClientError, TriexError, explainMoveAbort } from './errors'
import { FEE_RATE_SCALING } from './money'
import type { TradingAccountCapKind } from './transactions'
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
 * returns values as BCS bytes, so the exact Move layouts are declared here
 * (see the CLOB Move contracts: https://github.com/loash-industries/trinary-exchange):
 *   sources/trading_account.move
 *     `BalanceKey<phantom T> {}`                 (empty struct — one dummy bool)
 *     `MultiCoinBalanceKey { collection_id: ID, asset_id: u64 }`
 *     `TradeCap | DepositCap | WithdrawCap { id: UID, trading_account_id: ID }`
 *   sources/state/fee_schedule.move
 *     `FeeSchedule { tiers: vector<FeeTier { min_turnover: u128,
 *                    taker_fee: u64, maker_fee: u64 }> }`
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

/** `trading_account::MultiCoinBalanceKey { collection_id, asset_id }`. */
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
 * CRED held inside a trading account, read via the BM's `balances` Bag:
 * `BalanceKey<CRED>` → `sui::balance::Balance<CRED>` (bare u64). Returns 0n
 * when the BM has no CRED entry (or the object cannot be read).
 */
export async function getTradingAccountCurrencyBalance(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  tradingAccountId: string,
): Promise<bigint> {
  const bmObj = await core(suiClient)
    .getObject({ objectId: tradingAccountId, include: { json: true } })
    .catch(() => null)

  const bmFields = bmObj?.object?.json
  const balancesBag = unwrapMoveFields(bmFields?.balances)
  const balancesBagId = tryIdToString(balancesBag?.id)
  if (!balancesBagId) return 0n

  const keyType = `${ids.triex}::trading_account::BalanceKey<${ids.credCoinType}>`
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
 * Item balance held inside a trading account for one (collection, asset).
 * `MultiCoinBalanceKey → multicoin::Balance` is a dynamic *object* field; the
 * child's content is BCS-decoded (mirrors the app / server).
 */
export async function getTradingAccountItemBalance(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  tradingAccountId: string,
  collectionId: string,
  assetId: bigint,
): Promise<{ hasKey: boolean; balance: bigint }> {
  const keyType = `${ids.triex}::trading_account::MultiCoinBalanceKey`
  const resp = await core(suiClient)
    .getDynamicObjectField({
      parentId: tradingAccountId,
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

// ─── Trading-account capabilities ────────────────────────────────────────────

/** `TradeCap | DepositCap | WithdrawCap { id, trading_account_id }`. */
const TradingAccountCapBcs = bcs.struct('TradingAccountCap', {
  id: bcs.Address,
  trading_account_id: bcs.Address,
})

/** A trading-account capability object held by an address. */
export interface OwnedTradingAccountCap {
  objectId: string
  kind: TradingAccountCapKind
  /** The account the cap acts on (it may belong to someone else). */
  tradingAccountId: string
}

const CAP_STRUCTS: Record<TradingAccountCapKind, string> = {
  trade: 'TradeCap',
  deposit: 'DepositCap',
  withdraw: 'WithdrawCap',
}

/** The Move struct type of a trading-account capability kind. */
export function tradingAccountCapType(
  ids: PackageIds,
  kind: TradingAccountCapKind,
): string {
  return `${ids.triex}::trading_account::${CAP_STRUCTS[kind]}`
}

/**
 * Every TradeCap / DepositCap / WithdrawCap `owner` holds, for any account.
 * A cap only works while its id is on the account's allow-list — compare
 * with {@link getTradingAccountAllowList}.
 */
export async function findOwnedTradingAccountCaps(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  owner: string,
): Promise<OwnedTradingAccountCap[]> {
  const out: OwnedTradingAccountCap[] = []
  for (const kind of Object.keys(CAP_STRUCTS) as TradingAccountCapKind[]) {
    const type = tradingAccountCapType(ids, kind)
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
          const parsed = TradingAccountCapBcs.parse(obj.content)
          out.push({
            objectId: obj.objectId,
            kind,
            tradingAccountId: parsed.trading_account_id,
          })
        } catch {
          // Not decodable as a cap — skip.
        }
      }
      const hasNext = page?.hasNextPage ?? page?.pageInfo?.hasNextPage
      cursor = page?.cursor ?? page?.pageInfo?.endCursor
      if (!hasNext || !cursor || (page?.objects?.length ?? 0) === 0) break
    }
  }
  return out
}

/**
 * The ids on a trading account's `allow_listed` set — every live
 * Trade/Deposit/WithdrawCap minted for it and not yet revoked. Empty when the
 * account cannot be read.
 */
export async function getTradingAccountAllowList(
  suiClient: ClientWithCoreApi,
  tradingAccountId: string,
): Promise<string[]> {
  const res = await core(suiClient)
    .getObject({ objectId: tradingAccountId, include: { json: true } })
    .catch(() => null)
  const set = unwrapMoveFields(res?.object?.json?.allow_listed)
  const contents: unknown = Array.isArray(set) ? set : set?.contents
  if (!Array.isArray(contents)) return []
  return contents
    .map((v) => tryIdToString(v))
    .filter((v): v is string => v !== null)
}

// ─── Fees (FeePolicy class ladder + per-account tier) ────────────────────────

/** `fee_schedule::FeeSchedule { tiers: vector<FeeTier> }`. */
export const FeeScheduleBcs = bcs.struct('FeeSchedule', {
  tiers: bcs.vector(
    bcs.struct('FeeTier', {
      min_turnover: bcs.u128(),
      taker_fee: bcs.u64(),
      maker_fee: bcs.u64(),
    }),
  ),
})

/** One rung of a fee ladder (`fee_schedule::FeeTier`); rates are × 1e9. */
export interface FeeTier {
  /** Inclusive lower bound on trailing fee turnover, in quote base units. */
  minTurnover: bigint
  takerFeeRate: bigint
  makerFeeRate: bigint
}

/** The rates one trading account resolves to on a pool right now. */
export interface AccountFeeRates {
  tradingAccountId: string
  /** Index into `schedule` of the tier the account occupies. */
  tier: number
  /**
   * Fees the account paid over the trailing 30-epoch window in this quote
   * (exchange-wide, plus this pool's pending maker credits) — what tiers
   * resolve against.
   */
  turnover: bigint
  takerFeeRate: bigint
  makerFeeRate: bigint
}

/**
 * Fee configuration for one item pool, read head-current from the chain
 * (`multicoin_pool::pool_fee_class` / `pool_fee_schedule` /
 * `pool_fee_schedule_next` / `trade_params_for_account` / `account_fee_tier`
 * / `account_fee_turnover`, `fee_policy::cancel_retention_bps`). All rates
 * are 1e9-scaled (22_000_000 = 2.2%).
 */
export interface TradingFees {
  poolId: string
  /** The pool's pricing class in the shared FeePolicy. */
  feeClass: number
  /** Epoch the rates were resolved in, when the fullnode reports it. */
  epoch: bigint | null
  /** The ladder pricing trades this epoch (tier 0 first, rates descending). */
  schedule: FeeTier[]
  /** The ladder staged to take over — equal to `schedule` when none is. */
  nextSchedule: FeeTier[]
  /** Epoch `nextSchedule` takes effect (≤ `epoch` when nothing is pending). */
  nextScheduleEpoch: bigint
  /** Tier-0 taker rate: what an account with no turnover pays (the indexer's `fee`). */
  entryTakerFeeRate: bigint
  /** Tier-0 maker rate. */
  entryMakerFeeRate: bigint
  /**
   * Share (bps) of a bid's escrowed maker fee kept by the protocol when the
   * order is cancelled, modified down or expires (the rest is refunded).
   */
  cancelRetentionBps: bigint
  /** The account's own tier and rates; null when no account was given. */
  account: AccountFeeRates | null
  /**
   * The rate a bid's deposit must cover so it is never under-funded:
   * the highest taker or maker rate any account can be charged across the
   * active and staged ladders (tier-0 rates bound every tier). Feed it to
   * `computeBidQuoteDeposit`.
   */
  bidEscrowFeeRate: bigint
}

function parseFeeSchedule(bytes: Uint8Array): FeeTier[] {
  return FeeScheduleBcs.parse(bytes).tiers.map((t) => ({
    minTurnover: BigInt(t.min_turnover),
    takerFeeRate: BigInt(t.taker_fee),
    makerFeeRate: BigInt(t.maker_fee),
  }))
}

function maxRate(...rates: bigint[]): bigint {
  const max = rates.reduce((a, b) => (b > a ? b : a), 0n)
  return max > FEE_RATE_SCALING ? FEE_RATE_SCALING : max
}

/**
 * Read an item pool's fee ladder — and, given a trading account, the tier and
 * rates that account trades at — in one simulated transaction of view calls
 * (nothing executes). Needs a client whose `simulateTransaction` returns
 * `commandResults` (the gRPC / GraphQL v2 clients). `sender` must own the
 * trading account when one is passed (the account is an owned object).
 */
export async function getPoolTradingFees(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  params: { poolId: string; sender: string; tradingAccountId?: string | null },
): Promise<TradingFees> {
  const tx = new Transaction()
  tx.setSender(params.sender)
  const q = [ids.credCoinType]
  const pool = tx.object(params.poolId)
  const policy = tx.object(ids.triexFeePolicy)
  const view = (fn: string, args: any[]) =>
    tx.moveCall({
      target: `${ids.triex}::multicoin_pool::${fn}`,
      typeArguments: q,
      arguments: args,
    })
  const [feeClass] = view('pool_fee_class', [pool]) // 0
  view('pool_fee_schedule', [pool, policy]) // 1
  view('pool_fee_schedule_next', [pool, policy]) // 2
  tx.moveCall({
    target: `${ids.triex}::fee_policy::cancel_retention_bps`,
    arguments: [policy, feeClass],
  }) // 3
  const taId = params.tradingAccountId ?? null
  if (taId) {
    const ta = tx.object(taId)
    view('trade_params_for_account', [pool, policy, ta]) // 4
    view('account_fee_tier', [pool, policy, ta]) // 5
    view('account_fee_turnover', [pool, ta]) // 6
  }

  const res = await core(suiClient).simulateTransaction({
    transaction: tx,
    include: { commandResults: true, effects: true },
    checksEnabled: false,
  })
  if (res?.$kind === 'FailedTransaction' || res?.FailedTransaction) {
    const error = res.FailedTransaction?.status?.error ?? 'unknown error'
    const explained = explainMoveAbort(JSON.stringify(error))
    throw new TriexClientError(
      TriexError.TransactionFailed,
      `Fee read for pool ${params.poolId} failed${explained ? `: ${explained}` : ''}.`,
      error,
    )
  }
  const results: any[] | undefined = res?.commandResults
  const value = (cmd: number, i = 0): Uint8Array => {
    const bytes = results?.[cmd]?.returnValues?.[i]?.bcs
    if (!bytes) {
      throw new TriexClientError(
        TriexError.UnexpectedResponse,
        'Fee read returned no command results — use a Sui client whose simulateTransaction supports `include: { commandResults: true }` (gRPC or GraphQL).',
      )
    }
    return bytes
  }

  const schedule = parseFeeSchedule(value(1))
  const nextSchedule = parseFeeSchedule(value(2, 0))
  const entry = schedule[0] ?? {
    minTurnover: 0n,
    takerFeeRate: 0n,
    makerFeeRate: 0n,
  }
  const nextEntry = nextSchedule[0] ?? entry
  const account: AccountFeeRates | null = taId
    ? {
        tradingAccountId: taId,
        takerFeeRate: BigInt(bcs.u64().parse(value(4, 0))),
        makerFeeRate: BigInt(bcs.u64().parse(value(4, 1))),
        tier: Number(bcs.u64().parse(value(5))),
        turnover: BigInt(bcs.u128().parse(value(6))),
      }
    : null
  const epoch = res?.Transaction?.epoch

  return {
    poolId: params.poolId,
    feeClass: bcs.u16().parse(value(0)),
    epoch: epoch === null || epoch === undefined ? null : BigInt(epoch),
    schedule,
    nextSchedule,
    nextScheduleEpoch: BigInt(bcs.u64().parse(value(2, 1))),
    entryTakerFeeRate: entry.takerFeeRate,
    entryMakerFeeRate: entry.makerFeeRate,
    cancelRetentionBps: BigInt(bcs.u64().parse(value(3))),
    account,
    bidEscrowFeeRate: maxRate(
      entry.takerFeeRate,
      entry.makerFeeRate,
      nextEntry.takerFeeRate,
      nextEntry.makerFeeRate,
    ),
  }
}

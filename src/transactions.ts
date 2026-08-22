import type {
  Transaction,
  TransactionResult,
  TransactionObjectArgument,
} from '@mysten/sui/transactions'
import type { PackageIds } from './types'

/**
 * Pure PTB builders for CLOB item (multicoin) trading (Move contracts:
 * https://github.com/loash-industries/trinary-exchange). Each function
 * APPENDS Move calls to a caller-provided `tx` and returns any on-chain result
 * handles; none execute. The high-level client resolves object IDs (from the
 * indexer + fullnode) and composes these into atomic transactions.
 *
 * Entry points confirmed against triex-app-api
 * (`useTriexbookMulticoinOrders.ts`, `sweepAllTx.ts`). Arg orders for the
 * `multicoin_pool::place_*` calls should be re-verified against the on-chain
 * module before Phase 3 sign-off (DESIGN.md §6).
 */

// ─── Balance manager lifecycle ───────────────────────────────────────────────

/** `balance_manager::new()` → the new BalanceManager (transfer to self after). */
export function newBalanceManager(
  tx: Transaction,
  ids: PackageIds,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::balance_manager::new`,
    arguments: [],
  })
}

/** `balance_manager::generate_proof_as_owner(bm)` — required before trading. */
export function generateProofAsOwner(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::balance_manager::generate_proof_as_owner`,
    arguments: [bm],
  })
}

// ─── Deposits ────────────────────────────────────────────────────────────────

/** `balance_manager::deposit<T>(bm, coin)` — deposit a prepared coin. */
export function depositCoin(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  coin: TransactionObjectArgument,
  coinType: string = ids.credCoinType,
): void {
  tx.moveCall({
    target: `${ids.triex}::balance_manager::deposit`,
    typeArguments: [coinType],
    arguments: [bm, coin],
  })
}

/** `balance_manager::deposit_multicoin(bm, object)` — deposit an item Balance. */
export function depositMulticoinObject(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  itemObjectId: string,
): void {
  tx.moveCall({
    target: `${ids.triex}::balance_manager::deposit_multicoin`,
    arguments: [bm, tx.object(itemObjectId)],
  })
}

// ─── Withdrawals ─────────────────────────────────────────────────────────────

/** `balance_manager::withdraw<T>(bm, amount)` → coin (partial withdraw). */
export function withdrawCoin(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  amount: bigint,
  coinType: string = ids.credCoinType,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::balance_manager::withdraw`,
    typeArguments: [coinType],
    arguments: [bm, tx.pure.u64(amount)],
  })
}

/** `balance_manager::withdraw_all<T>(bm)` → coin (transfer to self after). */
export function withdrawAllCoin(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  coinType: string = ids.credCoinType,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::balance_manager::withdraw_all`,
    typeArguments: [coinType],
    arguments: [bm],
  })
}

/** `balance_manager::withdraw_all_multicoin(bm, collectionId, assetId)` → balance. */
export function withdrawAllMulticoin(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  collectionId: string,
  assetId: bigint,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::balance_manager::withdraw_all_multicoin`,
    arguments: [bm, tx.pure.id(collectionId), tx.pure.u64(assetId)],
  })
}

/**
 * `receipt::redeem_receipt(balance, ssu, character, vaultConfig, collection, isOwner)`
 * — deposit a withdrawn item balance back into the hangar / SSU (#12 step 2).
 */
export function redeemReceipt(
  tx: Transaction,
  ids: PackageIds,
  balance: TransactionObjectArgument,
  args: {
    ssuObjectId: string
    characterId: string
    vaultConfigId: string
    collectionId: string
    isOwner: boolean
  },
): void {
  tx.moveCall({
    target: `${ids.warehouseReceipts}::receipt::redeem_receipt`,
    arguments: [
      balance,
      tx.object(args.ssuObjectId),
      tx.object(args.characterId),
      tx.object(args.vaultConfigId),
      tx.object(args.collectionId),
      tx.pure.bool(args.isOwner),
    ],
  })
}

// ─── Direct-from-hangar item sourcing (DESIGN.md §6.1) ───────────────────────

export interface HangarSourceArgs {
  /** SSU object id (0x-padded 64-hex from the storage unit id). */
  ssuObjectId: string
  /** The player's on-chain character object id. */
  characterId: string
  /** Owner-cap object ref (id/version/digest) for `tx.receivingRef`. */
  capRef: { objectId: string; version: string; digest: string }
  /** Owner-cap type argument (SSU cap vs character cap). */
  capTypeArg: string
  vaultConfigId: string
  vaultCollectionId: string
  assetId: bigint
  /** Quantity to pull from the hangar (u32). */
  amount: number
}

/**
 * Pull items out of a hangar/SSU and deposit them into the balance manager, in
 * one PTB fragment:
 *   borrow_owner_cap → receipt::deposit_for_receipt → return_owner_cap
 *   → balance_manager::deposit_multicoin
 *
 * TODO(RQ-3): confirm which owner cap (SSU vs character) applies for a personal
 * player at their own vs a public hub, and the exact `capTypeArg`.
 */
export function sourceItemsFromHangar(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  args: HangarSourceArgs,
): void {
  const character = tx.object(args.characterId)

  const borrow = tx.moveCall({
    target: `${ids.world}::character::borrow_owner_cap`,
    typeArguments: [args.capTypeArg],
    arguments: [character, tx.receivingRef(args.capRef)],
  })
  const cap = borrow[0]
  const borrowReceipt = borrow[1]

  const [receipt] = tx.moveCall({
    target: `${ids.warehouseReceipts}::receipt::deposit_for_receipt`,
    typeArguments: [args.capTypeArg],
    arguments: [
      tx.object(args.ssuObjectId),
      character,
      cap,
      tx.object(args.vaultConfigId),
      tx.object(args.vaultCollectionId),
      tx.pure.u64(args.assetId),
      tx.pure.u32(args.amount),
    ],
  })

  tx.moveCall({
    target: `${ids.world}::character::return_owner_cap`,
    typeArguments: [args.capTypeArg],
    arguments: [character, cap, borrowReceipt],
  })

  tx.moveCall({
    target: `${ids.triex}::balance_manager::deposit_multicoin`,
    arguments: [bm, receipt],
  })
}

// ─── Orders (item / multicoin pools) ─────────────────────────────────────────

export interface PlaceLimitOrderArgs {
  poolId: string
  bm: TransactionObjectArgument
  proof: TransactionObjectArgument
  price: bigint
  quantity: bigint
  isBid: boolean
  /** u8; default 0. */
  orderType?: number
  /** u8 self-matching option; default 0. */
  selfMatchingOption?: number
  /** Epoch milliseconds. */
  expireTimestamp: bigint
}

/** `multicoin_pool::place_limit_order<Quote>(...)`. */
export function placeLimitOrderItem(
  tx: Transaction,
  ids: PackageIds,
  args: PlaceLimitOrderArgs,
): void {
  tx.moveCall({
    target: `${ids.triex}::multicoin_pool::place_limit_order`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(args.poolId),
      args.bm,
      args.proof,
      tx.pure.u8(args.orderType ?? 0),
      tx.pure.u8(args.selfMatchingOption ?? 0),
      tx.pure.u64(args.price),
      tx.pure.u64(args.quantity),
      tx.pure.bool(args.isBid),
      tx.pure.u64(args.expireTimestamp),
      tx.object(ids.clock),
    ],
  })
}

export interface PlaceMarketOrderArgs {
  poolId: string
  bm: TransactionObjectArgument
  proof: TransactionObjectArgument
  quantity: bigint
  isBid: boolean
  selfMatchingOption?: number
}

/** `multicoin_pool::place_market_order<Quote>(...)`. */
export function placeMarketOrderItem(
  tx: Transaction,
  ids: PackageIds,
  args: PlaceMarketOrderArgs,
): void {
  tx.moveCall({
    target: `${ids.triex}::multicoin_pool::place_market_order`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(args.poolId),
      args.bm,
      args.proof,
      tx.pure.u8(args.selfMatchingOption ?? 0),
      tx.pure.u64(args.quantity),
      tx.pure.bool(args.isBid),
      tx.object(ids.clock),
    ],
  })
}

/**
 * `multicoin_pool::cancel_order<Quote>(pool, bm, proof, orderId, clock)`.
 * `orderId` is the pool-local order id (u64) as surfaced by open-orders /
 * discovery reads — matches the app and TRIEX_SYSTEM_DESIGN §7.3.
 */
export function cancelOrderItem(
  tx: Transaction,
  ids: PackageIds,
  args: {
    poolId: string
    bm: TransactionObjectArgument
    proof: TransactionObjectArgument
    orderId: bigint
  },
): void {
  tx.moveCall({
    target: `${ids.triex}::multicoin_pool::cancel_order`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(args.poolId),
      args.bm,
      args.proof,
      tx.pure.u64(args.orderId),
      tx.object(ids.clock),
    ],
  })
}

/** `multicoin_pool::cancel_all_orders<Quote>(pool, bm, proof, clock)`. */
export function cancelAllOrdersItem(
  tx: Transaction,
  ids: PackageIds,
  args: {
    poolId: string
    bm: TransactionObjectArgument
    proof: TransactionObjectArgument
  },
): void {
  tx.moveCall({
    target: `${ids.triex}::multicoin_pool::cancel_all_orders`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(args.poolId),
      args.bm,
      args.proof,
      tx.object(ids.clock),
    ],
  })
}

/**
 * `multicoin_pool::modify_order<Quote>(pool, bm, proof, orderId, newQuantity, clock)`
 * — reduce a resting order's quantity (newQuantity < original, > filled).
 */
export function modifyOrderItem(
  tx: Transaction,
  ids: PackageIds,
  args: {
    poolId: string
    bm: TransactionObjectArgument
    proof: TransactionObjectArgument
    orderId: bigint
    newQuantity: bigint
  },
): void {
  tx.moveCall({
    target: `${ids.triex}::multicoin_pool::modify_order`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(args.poolId),
      args.bm,
      args.proof,
      tx.pure.u64(args.orderId),
      tx.pure.u64(args.newQuantity),
      tx.object(ids.clock),
    ],
  })
}

/**
 * `multicoin_pool::withdraw_settled_amounts<Quote>(pool, bm, proof)` — claim
 * settled (post-fill) proceeds from a pool into the balance manager. Fill
 * proceeds sit "settled" in the pool until claimed; bots must call this (or
 * `account.claimSettled`) before withdrawing.
 */
export function withdrawSettledAmounts(
  tx: Transaction,
  ids: PackageIds,
  args: {
    poolId: string
    bm: TransactionObjectArgument
    proof: TransactionObjectArgument
    quoteCoinType?: string
  },
): void {
  tx.moveCall({
    target: `${ids.triex}::multicoin_pool::withdraw_settled_amounts`,
    typeArguments: [args.quoteCoinType ?? ids.credCoinType],
    arguments: [tx.object(args.poolId), args.bm, args.proof],
  })
}

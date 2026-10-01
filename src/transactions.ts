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
 * Every target and argument list is verified against trinary-exchange `main`
 * (cycle 7 + TRIEX-158, `packages/triex/sources`: `trading_account.move`,
 * `multicoin_pool.move`). Cycle 7 renamed the `balance_manager` module to
 * `trading_account` (`BalanceManager` → `TradingAccount`), made order ids
 * `u128`, and added a shared `&FeePolicy` argument to order placement,
 * cancel, cancel-all, modify, swaps, pool creation and the operator-share
 * claim. `ctx: &TxContext` parameters are implicit and never passed.
 */

// ─── Trading account lifecycle ───────────────────────────────────────────────

/** `trading_account::new()` → the new TradingAccount (transfer to self after). */
export function newTradingAccount(
  tx: Transaction,
  ids: PackageIds,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::new`,
    arguments: [],
  })
}

/**
 * `trading_account::new_with_custom_owner(owner)` → a TradingAccount owned by
 * `owner` (owner-only functions then need `owner`'s signature).
 */
export function newTradingAccountWithOwner(
  tx: Transaction,
  ids: PackageIds,
  owner: string,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::new_with_custom_owner`,
    arguments: [tx.pure.address(owner)],
  })
}

/**
 * `trading_account::new_with_custom_owner_and_caps(owner)` → the account; a
 * DepositCap, WithdrawCap and TradeCap are minted and sent to `owner` on-chain
 * (never returned to the caller).
 */
export function newTradingAccountWithOwnerAndCaps(
  tx: Transaction,
  ids: PackageIds,
  owner: string,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::new_with_custom_owner_and_caps`,
    arguments: [tx.pure.address(owner)],
  })
}

/**
 * `trading_account::register_trading_account(bm, registry)` — file the account
 * under its owner in the registry (owner-only; capped at 100 per owner,
 * `registry::EMaxTradingAccountsReached`).
 */
export function registerTradingAccount(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
): void {
  tx.moveCall({
    target: `${ids.triex}::trading_account::register_trading_account`,
    arguments: [bm, tx.object(ids.triexRegistry)],
  })
}

// ─── Capabilities & proofs ───────────────────────────────────────────────────

/** Which `trading_account` capability to mint. */
export type TradingAccountCapKind = 'trade' | 'deposit' | 'withdraw'

/**
 * `trading_account::mint_{trade,deposit,withdraw}_cap(bm)` → the new cap
 * (owner-only; at most 1000 live caps per account, `EMaxCapsReached`).
 * Transfer it to whoever should hold it.
 */
export function mintTradingAccountCap(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  kind: TradingAccountCapKind,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::mint_${kind}_cap`,
    arguments: [bm],
  })
}

/**
 * `trading_account::revoke_trade_cap(bm, &capId)` — remove any cap (trade,
 * deposit or withdraw) from the allow-list (owner-only; `ECapNotInList` when
 * the id is not listed).
 */
export function revokeTradingAccountCap(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  capId: string,
): void {
  tx.moveCall({
    target: `${ids.triex}::trading_account::revoke_trade_cap`,
    arguments: [bm, tx.pure.id(capId)],
  })
}

/**
 * `trading_account::generate_proof_as_trader(bm, tradeCap)` — a TradeProof
 * for a TradeCap holder (`EInvalidTrader` once the cap is revoked).
 */
export function generateProofAsTrader(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  tradeCap: TransactionObjectArgument,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::generate_proof_as_trader`,
    arguments: [bm, tradeCap],
  })
}

/** `trading_account::generate_proof_as_owner(bm)` — required before trading. */
export function generateProofAsOwner(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::generate_proof_as_owner`,
    arguments: [bm],
  })
}

// ─── Deposits ────────────────────────────────────────────────────────────────

/** `trading_account::deposit<T>(bm, coin)` — deposit a prepared coin. */
export function depositCoin(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  coin: TransactionObjectArgument,
  coinType: string = ids.credCoinType,
): void {
  tx.moveCall({
    target: `${ids.triex}::trading_account::deposit`,
    typeArguments: [coinType],
    arguments: [bm, coin],
  })
}

/** `trading_account::deposit_multicoin(bm, object)` — deposit an item Balance. */
export function depositMulticoinObject(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  itemObjectId: string,
): void {
  tx.moveCall({
    target: `${ids.triex}::trading_account::deposit_multicoin`,
    arguments: [bm, tx.object(itemObjectId)],
  })
}

/** `trading_account::deposit_with_cap<T>(bm, depositCap, coin)`. */
export function depositCoinWithCap(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  depositCap: TransactionObjectArgument,
  coin: TransactionObjectArgument,
  coinType: string = ids.credCoinType,
): void {
  tx.moveCall({
    target: `${ids.triex}::trading_account::deposit_with_cap`,
    typeArguments: [coinType],
    arguments: [bm, depositCap, coin],
  })
}

/** `trading_account::deposit_multicoin_with_cap(bm, depositCap, balance)`. */
export function depositMulticoinWithCap(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  depositCap: TransactionObjectArgument,
  balance: TransactionObjectArgument,
): void {
  tx.moveCall({
    target: `${ids.triex}::trading_account::deposit_multicoin_with_cap`,
    arguments: [bm, depositCap, balance],
  })
}

// ─── Withdrawals ─────────────────────────────────────────────────────────────

/** `trading_account::withdraw<T>(bm, amount)` → coin (partial withdraw). */
export function withdrawCoin(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  amount: bigint,
  coinType: string = ids.credCoinType,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::withdraw`,
    typeArguments: [coinType],
    arguments: [bm, tx.pure.u64(amount)],
  })
}

/** `trading_account::withdraw_all<T>(bm)` → coin (transfer to self after). */
export function withdrawAllCoin(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  coinType: string = ids.credCoinType,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::withdraw_all`,
    typeArguments: [coinType],
    arguments: [bm],
  })
}

/** `trading_account::withdraw_all_multicoin(bm, collectionId, assetId)` → balance. */
export function withdrawAllMulticoin(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  collectionId: string,
  assetId: bigint,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::withdraw_all_multicoin`,
    arguments: [bm, tx.pure.id(collectionId), tx.pure.u64(assetId)],
  })
}

/**
 * `trading_account::withdraw_multicoin(bm, collectionId, assetId, amount)` →
 * balance (partial item withdraw; `EMultiCoinBalanceTooLow` when short).
 */
export function withdrawMulticoin(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  collectionId: string,
  assetId: bigint,
  amount: bigint,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::withdraw_multicoin`,
    arguments: [
      bm,
      tx.pure.id(collectionId),
      tx.pure.u64(assetId),
      tx.pure.u64(amount),
    ],
  })
}

/** `trading_account::withdraw_with_cap<T>(bm, withdrawCap, amount)` → coin. */
export function withdrawCoinWithCap(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  withdrawCap: TransactionObjectArgument,
  amount: bigint,
  coinType: string = ids.credCoinType,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::withdraw_with_cap`,
    typeArguments: [coinType],
    arguments: [bm, withdrawCap, tx.pure.u64(amount)],
  })
}

/**
 * `trading_account::withdraw_multicoin_with_cap(bm, withdrawCap,
 * collectionId, assetId, amount)` → balance.
 */
export function withdrawMulticoinWithCap(
  tx: Transaction,
  ids: PackageIds,
  bm: TransactionObjectArgument,
  withdrawCap: TransactionObjectArgument,
  collectionId: string,
  assetId: bigint,
  amount: bigint,
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::trading_account::withdraw_multicoin_with_cap`,
    arguments: [
      bm,
      withdrawCap,
      tx.pure.id(collectionId),
      tx.pure.u64(assetId),
      tx.pure.u64(amount),
    ],
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
 * Pull items out of a hangar/SSU and deposit them into the trading account, in
 * one PTB fragment:
 *   borrow_owner_cap → receipt::deposit_for_receipt → return_owner_cap
 *   → trading_account::deposit_multicoin
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
    target: `${ids.triex}::trading_account::deposit_multicoin`,
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

/**
 * `multicoin_pool::place_limit_order<Quote>(pool, policy, account, proof,
 * orderType, selfMatchingOption, price, quantity, isBid, expireTimestamp, clock)`.
 */
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
      tx.object(ids.triexFeePolicy),
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

/**
 * `multicoin_pool::place_market_order<Quote>(pool, policy, account, proof,
 * selfMatchingOption, quantity, isBid, clock)`.
 */
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
      tx.object(ids.triexFeePolicy),
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
 * `multicoin_pool::cancel_order<Quote>(pool, policy, account, proof, orderId, clock)`.
 * `orderId` is the `u128` order id as surfaced by open-orders / discovery
 * reads (`order_id`), matching the app.
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
      tx.object(ids.triexFeePolicy),
      args.bm,
      args.proof,
      tx.pure.u128(args.orderId),
      tx.object(ids.clock),
    ],
  })
}

/** `multicoin_pool::cancel_all_orders<Quote>(pool, policy, account, proof, clock)`. */
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
      tx.object(ids.triexFeePolicy),
      args.bm,
      args.proof,
      tx.object(ids.clock),
    ],
  })
}

/**
 * `multicoin_pool::cancel_orders<Quote>(pool, policy, account, proof,
 * orderIds: vector<u128>, clock)` — all-or-nothing batch cancel.
 */
export function cancelOrdersItem(
  tx: Transaction,
  ids: PackageIds,
  args: {
    poolId: string
    bm: TransactionObjectArgument
    proof: TransactionObjectArgument
    orderIds: bigint[]
  },
): void {
  tx.moveCall({
    target: `${ids.triex}::multicoin_pool::cancel_orders`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      args.bm,
      args.proof,
      tx.pure.vector('u128', args.orderIds),
      tx.object(ids.clock),
    ],
  })
}

/**
 * `multicoin_pool::modify_order<Quote>(pool, policy, account, proof, orderId, newQuantity, clock)`
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
      tx.object(ids.triexFeePolicy),
      args.bm,
      args.proof,
      tx.pure.u128(args.orderId),
      tx.pure.u64(args.newQuantity),
      tx.object(ids.clock),
    ],
  })
}

/**
 * `multicoin_pool::withdraw_settled_amounts<Quote>(pool, account, proof)` — claim
 * settled (post-fill) proceeds from a pool into the trading account. Fill
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

/**
 * `multicoin_pool::withdraw_settled_amounts_permissionless<Quote>(pool,
 * account)` — push an account's settled proceeds into it without a proof
 * (anyone may call; funds only ever move pool → account).
 */
export function withdrawSettledAmountsPermissionless(
  tx: Transaction,
  ids: PackageIds,
  args: {
    poolId: string
    bm: TransactionObjectArgument
    quoteCoinType?: string
  },
): void {
  tx.moveCall({
    target: `${ids.triex}::multicoin_pool::withdraw_settled_amounts_permissionless`,
    typeArguments: [args.quoteCoinType ?? ids.credCoinType],
    arguments: [tx.object(args.poolId), args.bm],
  })
}

// ─── Swaps (item pools, no resting order) ────────────────────────────────────

/**
 * `multicoin_pool::swap_exact_base_for_quote<Quote>(pool, policy, baseIn,
 * credIn, minQuoteOut, clock)` → `[baseLeft, quoteOut, credLeft]`: sell an
 * item `Balance` without a trading account (a temporary one is created and
 * deleted on-chain). `credIn` comes back unchanged — pass a zero CRED coin.
 * Aborts `EMinimumQuantityOutNotMet` below `minQuoteOut`.
 */
export function swapExactBaseForQuoteItem(
  tx: Transaction,
  ids: PackageIds,
  args: {
    poolId: string
    baseIn: TransactionObjectArgument
    credIn: TransactionObjectArgument
    minQuoteOut: bigint
  },
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::multicoin_pool::swap_exact_base_for_quote`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      args.baseIn,
      args.credIn,
      tx.pure.u64(args.minQuoteOut),
      tx.object(ids.clock),
    ],
  })
}

/**
 * `multicoin_pool::swap_exact_quote_for_base<Quote>(pool, policy, quoteIn,
 * credIn, minBaseOut, clock)` → `[baseOut, quoteLeft, credLeft]`: buy items
 * with a quote coin, without a trading account. The quantity bought is sized
 * on-chain so notional plus the entry-tier taker fee fits in `quoteIn`.
 */
export function swapExactQuoteForBaseItem(
  tx: Transaction,
  ids: PackageIds,
  args: {
    poolId: string
    quoteIn: TransactionObjectArgument
    credIn: TransactionObjectArgument
    minBaseOut: bigint
  },
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::multicoin_pool::swap_exact_quote_for_base`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      args.quoteIn,
      args.credIn,
      tx.pure.u64(args.minBaseOut),
      tx.object(ids.clock),
    ],
  })
}

export interface SwapWithTradingAccountArgs {
  poolId: string
  bm: TransactionObjectArgument
  tradeCap: TransactionObjectArgument
  depositCap: TransactionObjectArgument
  withdrawCap: TransactionObjectArgument
}

/**
 * `multicoin_pool::swap_exact_base_for_quote_with_trading_account<Quote>(pool,
 * policy, account, tradeCap, depositCap, withdrawCap, baseIn, minQuoteOut,
 * clock)` → `[baseLeft, quoteOut]`, priced at the account's own fee tier.
 */
export function swapExactBaseForQuoteWithTradingAccountItem(
  tx: Transaction,
  ids: PackageIds,
  args: SwapWithTradingAccountArgs & {
    baseIn: TransactionObjectArgument
    minQuoteOut: bigint
  },
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::multicoin_pool::swap_exact_base_for_quote_with_trading_account`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      args.bm,
      args.tradeCap,
      args.depositCap,
      args.withdrawCap,
      args.baseIn,
      tx.pure.u64(args.minQuoteOut),
      tx.object(ids.clock),
    ],
  })
}

/**
 * `multicoin_pool::swap_exact_quote_for_base_with_trading_account<Quote>(pool,
 * policy, account, tradeCap, depositCap, withdrawCap, quoteIn, minBaseOut,
 * clock)` → `[baseOut, quoteLeft]`, priced at the account's own fee tier.
 */
export function swapExactQuoteForBaseWithTradingAccountItem(
  tx: Transaction,
  ids: PackageIds,
  args: SwapWithTradingAccountArgs & {
    quoteIn: TransactionObjectArgument
    minBaseOut: bigint
  },
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::multicoin_pool::swap_exact_quote_for_base_with_trading_account`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      args.bm,
      args.tradeCap,
      args.depositCap,
      args.withdrawCap,
      args.quoteIn,
      tx.pure.u64(args.minBaseOut),
      tx.object(ids.clock),
    ],
  })
}

// ─── Pool lifecycle & hub revenue ────────────────────────────────────────────

/** `constants::pool_creation_fee()` — 500 CRED (6 decimals). */
export const POOL_CREATION_FEE = 500_000_000n

/**
 * `multicoin_pool::create_permissionless_pool<Quote>(registry, policy,
 * collection, assetId, creationFee)` → the new pool's `ID`. `creationFee` must
 * be a `Coin<CRED>` of exactly {@link POOL_CREATION_FEE} (`EInvalidFee`); the
 * pool joins its quote's multicoin default fee class.
 */
export function createPermissionlessPoolItem(
  tx: Transaction,
  ids: PackageIds,
  args: {
    collectionId: string
    assetId: bigint
    creationFee: TransactionObjectArgument
  },
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::multicoin_pool::create_permissionless_pool`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(ids.triexRegistry),
      tx.object(ids.triexFeePolicy),
      tx.object(args.collectionId),
      tx.pure.u64(args.assetId),
      args.creationFee,
    ],
  })
}

/**
 * `multicoin_pool::claim_operator_share<Quote>(pool, policy, registry, clock)`
 * → `(hubAmount, treasuryAmount)`: pay the hub operator's accrued fee share to
 * the collection's registered beneficiary and the rest to the treasury.
 * Permissionless — both destinations come from on-chain configuration. Aborts
 * `ENoOperatorBeneficiary` when a share is owed but no beneficiary is set.
 */
export function claimOperatorShareItem(
  tx: Transaction,
  ids: PackageIds,
  args: { poolId: string },
): TransactionResult {
  return tx.moveCall({
    target: `${ids.triex}::multicoin_pool::claim_operator_share`,
    typeArguments: [ids.credCoinType],
    arguments: [
      tx.object(args.poolId),
      tx.object(ids.triexFeePolicy),
      tx.object(ids.triexRegistry),
      tx.object(ids.clock),
    ],
  })
}

/**
 * `multicoin_pool::update_pool_allowed_versions<Quote>(pool, registry)` —
 * permissionless: sync a pool's allowed package versions from the registry
 * after an upgrade (trading aborts `EPackageVersionDisabled` until it is).
 */
export function updatePoolAllowedVersionsItem(
  tx: Transaction,
  ids: PackageIds,
  args: { poolId: string },
): void {
  tx.moveCall({
    target: `${ids.triex}::multicoin_pool::update_pool_allowed_versions`,
    typeArguments: [ids.credCoinType],
    arguments: [tx.object(args.poolId), tx.object(ids.triexRegistry)],
  })
}

import { bcs } from '@mysten/sui/bcs'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import type { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress } from '@mysten/sui/utils'

import { CLOCK_ID } from '../config'
import { TriexClientError, TriexError } from '../errors'
import type { CreatedObject } from '../execute'
import type { OuProposalAction } from './harness'
import { normalizeMoveType } from './governance'

export { normalizeMoveType }

/**
 * Trading as an organization — the cycle-7 `armature_trading` surface.
 *
 * Every operation is the governance-wrapped counterpart of something in the
 * personal trading module: payload → `submit_vote_execute` → a
 * `trading_ops::execute_*` handler. Expressing them as `OuProposalAction`s
 * rather than finished transactions means they route through the same resolver
 * as everything else, and compose with each other in one PTB.
 *
 * **Custody (TRIEX-158).** An organization's `TradingAccount` is owned by a
 * shared `trading_custody::TradingCustody` — the account's `owner` IS the
 * custody's address — and the custody holds the account's Deposit, Withdraw
 * and Trade caps where only `armature_trading` can borrow them. Every handler
 * takes the custody and asserts it belongs to the OU whose board approved the
 * ticket, so an organization trades ONLY through the unit that ran
 * `SetupTradingAccount`. Nothing is borrowed from the CapabilityVault any more.
 *
 * **They are all `single-vote-only`, deliberately** (pool creation excepted).
 * A limit order that becomes a week-long proposal is not a slower order, it is
 * a wrong one — the price it was priced against is long gone. Worse, the
 * composed flows (fund-then-buy, unpark-then-sell) depend on both halves
 * landing in ONE transaction; degraded to proposals they would become two
 * independent votes, and the funding guarantee that makes them safe would
 * quietly vanish. Blocking is the honest outcome, and `TRADING_TYPE_CONFIG`'s
 * quorum of 1 is what normally prevents it.
 */

/** Ids and objects every trading action needs. */
export interface TradingContext {
  armatureTrading: string
  /** The shared `TradingCustody` that owns the account and holds its caps. */
  tradingCustodyId: string
  /** The organization's shared triex `TradingAccount`. */
  tradingAccountId: string
  /** triex's shared `FeePolicy` — the order handlers charge against it. */
  feePolicyId: string
}

/** Order flags shared by the limit-order builders. */
export interface OrderFlags {
  /** TriexBook order type; 0 = no restriction (the default). */
  orderType?: number
  /** Self-matching option; 0 = allow (the default). */
  selfMatchingOption?: number
}

const single = 'single-vote-only' as const

// ─── Proposal type catalog ──────────────────────────────────────────────────

/** `armature::permissions::treasury_withdraw()` (1 << 7). */
const TREASURY_WITHDRAW = 1 << 7

/**
 * One enable-able `armature_trading` proposal type.
 *
 * `typeKey` is the slot's DISPLAY key (unique per OU, carries no authority);
 * `moveType` is the concrete payload type the cycle-7 slot is actually keyed
 * by; `permissions` are the `armature::permissions` bits the handler needs —
 * a type enabled without them aborts with `proposal::EPermissionDenied` when
 * it executes (`trading_permissions.move`). A non-zero mask carries the
 * framework's 80% approval floor, so its config needs `approvalThreshold ≥
 * 8000` (one officer's YES is still 100%).
 */
export interface TradingProposalType {
  typeKey: string
  moveType: string
  permissions: number
}

/**
 * The multicoin-pool (item ↔ coin) trading types, generic ones instantiated
 * at `quoteType` (normally CRED). Display keys are the fully-qualified,
 * generics-free names — the convention `triex-app-api` uses at org creation.
 */
export function tradingProposalTypes(
  armatureTrading: string,
  quoteType: string,
): TradingProposalType[] {
  const generic = (mod: string, struct: string, permissions = 0) => ({
    typeKey: `${armatureTrading}::${mod}::${struct}`,
    moveType: `${armatureTrading}::${mod}::${struct}<${quoteType}>`,
    permissions,
  })
  const plain = (mod: string, struct: string) => ({
    typeKey: `${armatureTrading}::${mod}::${struct}`,
    moveType: `${armatureTrading}::${mod}::${struct}`,
    permissions: 0,
  })
  return [
    generic('place_limit_order', 'PlaceLimitOrder'),
    generic('place_market_order', 'PlaceMarketOrder'),
    generic('cancel_order', 'CancelOrder'),
    generic('deposit_coin_to_book', 'DepositCoinToBook', TREASURY_WITHDRAW),
    generic('sweep_coin_to_treasury', 'SweepCoinToTreasury'),
    plain('setup_trading_account', 'SetupTradingAccount'),
    plain('deposit_from_ou_vault_to_book', 'DepositFromOuVaultToBook'),
    plain('sweep_multicoin_to_ou_vault', 'SweepMulticoinToOuVault'),
  ]
}

/**
 * The coin-pool (`Pool<Base, Quote>`) order types for ONE pair.
 *
 * A cycle-7 slot is keyed by the concrete Move type, so every pair is its own
 * slot. The display key keeps the type arguments, so several pairs coexist on
 * one OU instead of the first one claiming the generics-free name forever.
 * Funding and sweeping a coin pair reuse `DepositCoinToBook<T>` /
 * `SweepCoinToTreasury<T>` at the base and quote coins.
 */
export function coinPairProposalTypes(
  armatureTrading: string,
  baseType: string,
  quoteType: string,
): TradingProposalType[] {
  const pair = (mod: string, struct: string) => {
    const moveType = `${armatureTrading}::${mod}::${struct}<${baseType}, ${quoteType}>`
    return { typeKey: moveType, moveType, permissions: 0 }
  }
  return [
    pair('place_limit_order_coin', 'PlaceLimitOrderCoin'),
    pair('cancel_order_coin', 'CancelOrderCoin'),
  ]
}

/**
 * `CreateMulticoinPool<Quote>` — pays the CRED pool-creation fee out of the
 * treasury, hence `TREASURY_WITHDRAW`.
 */
export function createMulticoinPoolProposalType(
  armatureTrading: string,
  quoteType: string,
): TradingProposalType {
  return {
    typeKey: `${armatureTrading}::create_multicoin_pool::CreateMulticoinPool`,
    moveType: `${armatureTrading}::create_multicoin_pool::CreateMulticoinPool<${quoteType}>`,
    permissions: TREASURY_WITHDRAW,
  }
}

// ─── Actions ────────────────────────────────────────────────────────────────

/**
 * Give the organization a trading account.
 *
 * The handler shares a new `TradingCustody` for the ticket's OU and a
 * `TradingAccount` owned by it, with the caps stored in the same transaction,
 * so the account can trade as soon as this commits. An OU MAY run it more than
 * once (each run is another account), which is why the handle guards against
 * a second call rather than relying on an abort — there is none.
 */
export function setupTradingAccountAction(armature: {
  armatureTrading: string
}): OuProposalAction {
  const pkg = armature.armatureTrading
  const typeKey = `${pkg}::setup_trading_account::SetupTradingAccount`
  return {
    kind: 'setup_trading_account',
    own: {
      typeKey,
      payloadMoveType: typeKey,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::setup_trading_account::new`,
          arguments: [],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_setup_trading_account`,
          arguments: [ticket],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/**
 * Move a coin from the treasury into the trading account — the quote coin to
 * back bids, or a coin pool's base coin to back asks. Needs `TREASURY_WITHDRAW`
 * on the slot.
 */
export function depositCoinToBookAction(
  ctx: TradingContext,
  params: { coinType: string; amount: bigint; treasuryVaultId: string },
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const typeKey = `${pkg}::deposit_coin_to_book::DepositCoinToBook`
  return {
    kind: 'deposit_coin_to_book',
    own: {
      typeKey,
      payloadMoveType: `${typeKey}<${params.coinType}>`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::deposit_coin_to_book::new`,
          typeArguments: [params.coinType],
          arguments: [
            tx.pure.id(ctx.tradingAccountId),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_deposit_coin_to_book`,
          typeArguments: [params.coinType],
          arguments: [
            tx.object(params.treasuryVaultId),
            tx.object(ctx.tradingCustodyId),
            tx.object(ctx.tradingAccountId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/**
 * Move items out of an `OuReceiptVault` (shared storage) into the trading
 * account, so they can back an ask. The executor must satisfy the vault's
 * `withdraw` role with the acting OU as context.
 */
export function depositFromOuVaultToBookAction(
  ctx: TradingContext,
  params: { vaultId: string; assetId: bigint; amount: bigint },
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const typeKey = `${pkg}::deposit_from_ou_vault_to_book::DepositFromOuVaultToBook`
  return {
    kind: 'deposit_from_ou_vault_to_book',
    own: {
      typeKey,
      payloadMoveType: typeKey,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::deposit_from_ou_vault_to_book::new`,
          arguments: [
            tx.pure.id(params.vaultId),
            tx.pure.id(ctx.tradingAccountId),
            tx.pure.u64(params.assetId),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_deposit_from_ou_vault_to_book`,
          arguments: [
            tx.object(params.vaultId),
            tx.object(ownDaoId),
            tx.object(ctx.tradingCustodyId),
            tx.object(ctx.tradingAccountId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/**
 * Create a permissionless `MultiCoinPool<Quote>` for one item, paying the CRED
 * creation fee (`constants::pool_creation_fee()`) from the treasury.
 *
 * Not single-vote-only: nothing about a new market goes stale while a board
 * deliberates, so this may degrade into an ordinary proposal.
 */
export function createMulticoinPoolAction(
  pkgs: {
    armatureTrading: string
    triexRegistryId: string
    feePolicyId: string
  },
  params: {
    quoteType: string
    collectionId: string
    assetId: bigint
    treasuryVaultId: string
  },
): OuProposalAction {
  const pkg = pkgs.armatureTrading
  const typeKey = `${pkg}::create_multicoin_pool::CreateMulticoinPool`
  return {
    kind: 'create_multicoin_pool',
    own: {
      typeKey,
      payloadMoveType: `${typeKey}<${params.quoteType}>`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::create_multicoin_pool::new`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.pure.id(params.collectionId),
            tx.pure.u64(params.assetId),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_create_multicoin_pool`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.object(pkgs.triexRegistryId),
            tx.object(pkgs.feePolicyId),
            tx.object(params.collectionId),
            tx.object(params.treasuryVaultId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}

/** Shared payload fields of the two limit-order payloads. */
interface LimitOrderFields extends OrderFlags {
  poolId: string
  price: bigint
  quantity: bigint
  isBid: boolean
  expireTimestamp: bigint
}

function limitOrderArgs(
  tx: Transaction,
  ctx: TradingContext,
  p: LimitOrderFields,
) {
  return [
    tx.pure.id(ctx.tradingAccountId),
    tx.pure.id(p.poolId),
    tx.pure.u64(p.price),
    tx.pure.u64(p.quantity),
    tx.pure.bool(p.isBid),
    tx.pure.u8(p.orderType ?? 0),
    tx.pure.u8(p.selfMatchingOption ?? 0),
    tx.pure.u64(p.expireTimestamp),
  ]
}

/** Place a limit order on an item (`MultiCoinPool`) market as the organization. */
export function placeLimitOrderAction(
  ctx: TradingContext,
  params: { quoteType: string } & LimitOrderFields,
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const typeKey = `${pkg}::place_limit_order::PlaceLimitOrder`
  return {
    kind: 'place_limit_order',
    own: {
      typeKey,
      payloadMoveType: `${typeKey}<${params.quoteType}>`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::place_limit_order::new`,
          typeArguments: [params.quoteType],
          arguments: limitOrderArgs(tx, ctx, params),
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_place_limit_order`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.object(params.poolId),
            tx.object(ctx.feePolicyId),
            tx.object(ctx.tradingCustodyId),
            tx.object(ctx.tradingAccountId),
            tx.object(CLOCK_ID),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/**
 * Place an immediate-or-cancel market order on an item market. Same as a
 * limit order without price, order type or expiry.
 */
export function placeMarketOrderAction(
  ctx: TradingContext,
  params: {
    quoteType: string
    poolId: string
    quantity: bigint
    isBid: boolean
    selfMatchingOption?: number
  },
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const typeKey = `${pkg}::place_market_order::PlaceMarketOrder`
  return {
    kind: 'place_market_order',
    own: {
      typeKey,
      payloadMoveType: `${typeKey}<${params.quoteType}>`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::place_market_order::new`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.pure.id(ctx.tradingAccountId),
            tx.pure.id(params.poolId),
            tx.pure.u64(params.quantity),
            tx.pure.bool(params.isBid),
            tx.pure.u8(params.selfMatchingOption ?? 0),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_place_market_order`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.object(params.poolId),
            tx.object(ctx.feePolicyId),
            tx.object(ctx.tradingCustodyId),
            tx.object(ctx.tradingAccountId),
            tx.object(CLOCK_ID),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/** Cancel one of the organization's resting orders on an item market. */
export function cancelOrderAction(
  ctx: TradingContext,
  params: { quoteType: string; poolId: string; orderId: bigint },
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const typeKey = `${pkg}::cancel_order::CancelOrder`
  return {
    kind: 'cancel_order',
    own: {
      typeKey,
      payloadMoveType: `${typeKey}<${params.quoteType}>`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::cancel_order::new`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.pure.id(ctx.tradingAccountId),
            tx.pure.id(params.poolId),
            // triex order ids are u128 (price in the high bits).
            tx.pure.u128(params.orderId),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_cancel_order`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.object(params.poolId),
            tx.object(ctx.feePolicyId),
            tx.object(ctx.tradingCustodyId),
            tx.object(ctx.tradingAccountId),
            tx.object(CLOCK_ID),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/** Place a limit order on a coin pool (`Pool<Base, Quote>`) as the organization. */
export function placeLimitOrderCoinAction(
  ctx: TradingContext,
  params: { baseType: string; quoteType: string } & LimitOrderFields,
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const moveType = `${pkg}::place_limit_order_coin::PlaceLimitOrderCoin<${params.baseType}, ${params.quoteType}>`
  return {
    kind: 'place_limit_order_coin',
    own: {
      // Per-pair display key — see `coinPairProposalTypes`.
      typeKey: moveType,
      payloadMoveType: moveType,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::place_limit_order_coin::new`,
          typeArguments: [params.baseType, params.quoteType],
          arguments: limitOrderArgs(tx, ctx, params),
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_place_limit_order_coin`,
          typeArguments: [params.baseType, params.quoteType],
          arguments: [
            tx.object(params.poolId),
            tx.object(ctx.feePolicyId),
            tx.object(ctx.tradingCustodyId),
            tx.object(ctx.tradingAccountId),
            tx.object(CLOCK_ID),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/**
 * Cancel a resting coin-pool order. Unlike the item-market cancel, the
 * handler takes NO `FeePolicy`.
 */
export function cancelOrderCoinAction(
  ctx: TradingContext,
  params: {
    baseType: string
    quoteType: string
    poolId: string
    orderId: bigint
  },
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const moveType = `${pkg}::cancel_order_coin::CancelOrderCoin<${params.baseType}, ${params.quoteType}>`
  return {
    kind: 'cancel_order_coin',
    own: {
      typeKey: moveType,
      payloadMoveType: moveType,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::cancel_order_coin::new`,
          typeArguments: [params.baseType, params.quoteType],
          arguments: [
            tx.pure.id(ctx.tradingAccountId),
            tx.pure.id(params.poolId),
            tx.pure.u128(params.orderId),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_cancel_order_coin`,
          typeArguments: [params.baseType, params.quoteType],
          arguments: [
            tx.object(params.poolId),
            tx.object(ctx.tradingCustodyId),
            tx.object(ctx.tradingAccountId),
            tx.object(CLOCK_ID),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/**
 * Sweep a coin from the trading account back into the treasury — quote
 * proceeds, or a coin pool's base coin. The treasury must be the acting OU's
 * own (`EWrongTreasury` otherwise).
 */
export function sweepCoinToTreasuryAction(
  ctx: TradingContext,
  params: { coinType: string; amount: bigint; treasuryVaultId: string },
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const typeKey = `${pkg}::sweep_coin_to_treasury::SweepCoinToTreasury`
  return {
    kind: 'sweep_coin_to_treasury',
    own: {
      typeKey,
      payloadMoveType: `${typeKey}<${params.coinType}>`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::sweep_coin_to_treasury::new`,
          typeArguments: [params.coinType],
          arguments: [
            tx.pure.id(ctx.tradingAccountId),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_sweep_coin_to_treasury`,
          typeArguments: [params.coinType],
          arguments: [
            tx.object(params.treasuryVaultId),
            tx.object(ctx.tradingCustodyId),
            tx.object(ctx.tradingAccountId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/**
 * Park items from the trading account in shared storage. The executor must
 * satisfy the vault's `deposit` role with the acting OU as context.
 */
export function sweepMulticoinToOuVaultAction(
  ctx: TradingContext,
  params: {
    vaultId: string
    collectionId: string
    assetId: bigint
    amount: bigint
  },
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const typeKey = `${pkg}::sweep_multicoin_to_ou_vault::SweepMulticoinToOuVault`
  return {
    kind: 'sweep_multicoin_to_ou_vault',
    own: {
      typeKey,
      payloadMoveType: typeKey,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::sweep_multicoin_to_ou_vault::new`,
          arguments: [
            tx.pure.id(ctx.tradingAccountId),
            tx.pure.id(params.vaultId),
            tx.pure.id(params.collectionId),
            tx.pure.u64(params.assetId),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_sweep_multicoin_to_ou_vault`,
          arguments: [
            tx.object(params.vaultId),
            tx.object(ownDaoId),
            tx.object(ctx.tradingCustodyId),
            tx.object(ctx.tradingAccountId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

// ─── Permissionless claim fragments ─────────────────────────────────────────

/**
 * Claim an item market's settled balances into the trading account, appended
 * to an existing PTB.
 *
 * NOT governance and NOT an action: `withdraw_settled_amounts_permissionless`
 * only ever moves funds pool → trading account, so it needs no cap and no
 * vote. It belongs in FRONT of a sweep — a resting maker order that filled
 * leaves its proceeds in the pool, not the trading account, so sweeping
 * without claiming first silently moves less than the caller expects.
 */
export function appendClaimSettled(
  tx: Transaction,
  args: {
    triex: string
    quoteType: string
    poolId: string
    tradingAccountId: string
  },
): void {
  tx.moveCall({
    target: `${args.triex}::multicoin_pool::withdraw_settled_amounts_permissionless`,
    typeArguments: [args.quoteType],
    arguments: [tx.object(args.poolId), tx.object(args.tradingAccountId)],
  })
}

/** The coin-pool (`pool::`) counterpart of {@link appendClaimSettled}. */
export function appendClaimSettledCoin(
  tx: Transaction,
  args: {
    triex: string
    baseType: string
    quoteType: string
    poolId: string
    tradingAccountId: string
  },
): void {
  tx.moveCall({
    target: `${args.triex}::pool::withdraw_settled_amounts_permissionless`,
    typeArguments: [args.baseType, args.quoteType],
    arguments: [tx.object(args.poolId), tx.object(args.tradingAccountId)],
  })
}

// ─── Custody discovery ──────────────────────────────────────────────────────

const CUSTODY_SUFFIX = '::trading_custody::TradingCustody'

/** A resolved custody: who it answers to and which account it holds. */
export interface TradingCustodyInfo {
  tradingCustodyId: string
  /** The OU whose board the custody's handlers accept tickets from. */
  ouId: string
  tradingAccountId: string
}

/**
 * Resolve the `TradingCustody` that owns an organization's trading account.
 *
 * No indexer support is needed: a custody-held `TradingAccount`'s `owner`
 * (BCS bytes 32..64, after the UID) is the custody's own address, which is
 * also its object id. Read straight from the fullnode.
 *
 * @throws `TradingAccountNotFound` when the account cannot be read;
 *   `ValidationFailed` when it is not custody-owned (e.g. a player's personal
 *   account) — every `armature_trading` handler needs the custody.
 */
export async function fetchTradingCustody(
  suiClient: ClientWithCoreApi,
  tradingAccountId: string,
): Promise<TradingCustodyInfo> {
  const account = await suiClient.core
    .getObject({ objectId: tradingAccountId, include: { content: true } })
    .catch(() => null)
  const content = account?.object.content
  if (!content || content.length < 64) {
    throw new TriexClientError(
      TriexError.TradingAccountNotFound,
      `Trading account ${tradingAccountId} could not be read.`,
    )
  }
  const owner = bcs.Address.parse(content.slice(32, 64))
  const custody = await suiClient.core
    .getObject({ objectId: owner, include: { json: true } })
    .catch(() => null)
  if (!custody?.object.type?.endsWith(CUSTODY_SUFFIX)) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      `Trading account ${tradingAccountId} is not held by an armature_trading custody (owner ${owner}).`,
    )
  }
  const json = (custody.object.json ?? {}) as Record<string, unknown>
  const inner = (json.fields as Record<string, unknown> | undefined) ?? json
  return {
    tradingCustodyId: normalizeSuiAddress(owner),
    ouId:
      typeof inner.ou_id === 'string' ? normalizeSuiAddress(inner.ou_id) : '',
    tradingAccountId: normalizeSuiAddress(tradingAccountId),
  }
}

/**
 * The custody and account a `SetupTradingAccount` execution created, read
 * from the transaction's created objects. Null when the executor did not
 * surface object types — fall back to the indexer (which lags) in that case.
 */
export function extractCreatedTradingCustody(
  createdObjects: CreatedObject[],
): { tradingCustodyId: string; tradingAccountId: string } | null {
  const find = (suffix: string) =>
    createdObjects.find((o) => o.objectType.endsWith(suffix))?.objectId
  const tradingCustodyId = find(CUSTODY_SUFFIX)
  const tradingAccountId = find('::trading_account::TradingAccount')
  return tradingCustodyId && tradingAccountId
    ? { tradingCustodyId, tradingAccountId }
    : null
}

// ─── Display-key resolution ─────────────────────────────────────────────────

/**
 * Point an action at the display key the OU ACTUALLY enabled its payload type
 * under. A cycle-7 slot is keyed by the Move type; the display key is whatever
 * label the enabler chose, so an action's default key is only a guess. When
 * `bindings` (display key → Move type) names the action's payload type, its
 * key wins; otherwise the action is returned unchanged.
 */
export function withEnabledTypeKey(
  action: OuProposalAction,
  bindings: Map<string, string>,
): OuProposalAction {
  const own = action.own
  if (!own) return action
  const want = normalizeMoveType(own.payloadMoveType)
  for (const [key, type] of bindings) {
    if (normalizeMoveType(type) === want) {
      return key === own.typeKey
        ? action
        : { ...action, own: { ...own, typeKey: key } }
    }
  }
  return action
}

import type { Transaction } from '@mysten/sui/transactions'

import { CLOCK_ID } from '../config'
import type { OuProposalAction } from './harness'

/**
 * Trading as an organization — the `armature_trading` surface.
 *
 * Every operation is the governance-wrapped counterpart of something in the
 * personal trading module: payload → `submit_vote_execute` → a
 * `trading_ops::execute_*` handler. Expressing them as `OuProposalAction`s
 * rather than finished transactions means they route through the same resolver
 * as everything else, and compose with each other in one PTB.
 *
 * **They are all `single-vote-only`, deliberately.** A limit order that becomes
 * a week-long proposal is not a slower order, it is a wrong one — the price it
 * was priced against is long gone. Worse, the composed flows (fund-then-buy,
 * unpark-then-sell) depend on both halves landing in ONE transaction; degraded
 * to proposals they would become two independent votes, and the funding
 * guarantee that makes them safe would quietly vanish. Blocking is the honest
 * outcome, and `TRADING_TYPE_CONFIG`'s quorum of 1 is what normally prevents it.
 */

/** Ids and objects every trading action needs from the acting unit. */
export interface TradingContext {
  armatureTrading: string
  /** The unit's CapabilityVault — holds the TradeCap the handlers borrow. */
  capVaultId: string
  /** The organization's shared TradingAccount. */
  tradingAccountId: string
}

/** Order flags shared by the limit-order builders. */
export interface OrderFlags {
  /** TriexBook order type; 0 = no restriction (the default). */
  orderType?: number
  /** Self-matching option; 0 = allow (the default). */
  selfMatchingOption?: number
}

const single = 'single-vote-only' as const

/**
 * Give the organization a trading account (a shared `TradingAccount`).
 *
 * Idempotent only in the sense that a second call aborts on-chain — check
 * `orgs.tradingAccount()` first rather than relying on the abort.
 */
export function setupTradingAccountAction(
  armature: { armatureTrading: string },
  capVaultId: string,
): OuProposalAction {
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
          arguments: [tx.object(capVaultId), ticket],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/** Move quote coin (CRED) from the treasury into the trading account. */
export function depositCoinToBookAction(
  ctx: TradingContext,
  params: { quoteType: string; amount: bigint; treasuryVaultId: string },
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const typeKey = `${pkg}::deposit_coin_to_book::DepositCoinToBook`
  return {
    kind: 'deposit_coin_to_book',
    own: {
      typeKey,
      payloadMoveType: `${typeKey}<${params.quoteType}>`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::deposit_coin_to_book::new`,
          typeArguments: [params.quoteType],
          arguments: [tx.pure.u64(params.amount)],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_deposit_coin_to_book`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.object(params.treasuryVaultId),
            tx.object(ctx.tradingAccountId),
            tx.object(ctx.capVaultId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/**
 * Move items out of a `DaoReceiptVault` (shared storage) into the balance
 * manager, so they can back an ask.
 *
 * `daoVaultId` is the vault registered for THIS unit at the hub. Resolving it
 * from a storage-unit id is Phase D; until then, pass it explicitly or read it
 * from `orgs.vaultsAtHub()`.
 */
export function depositFromDaoVaultToBookAction(
  ctx: TradingContext,
  params: { daoVaultId: string; assetId: bigint; amount: bigint },
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const typeKey = `${pkg}::deposit_from_dao_vault_to_book::DepositFromDaoVaultToBook`
  return {
    kind: 'deposit_from_dao_vault_to_book',
    own: {
      typeKey,
      payloadMoveType: typeKey,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::deposit_from_dao_vault_to_book::new`,
          arguments: [
            tx.pure.id(params.daoVaultId),
            tx.pure.u64(params.assetId),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_deposit_from_dao_vault_to_book`,
          arguments: [
            tx.object(params.daoVaultId),
            tx.object(ctx.tradingAccountId),
            tx.object(ctx.capVaultId),
            tx.object(ownDaoId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/** Place a limit order on an item (multicoin) pool as the organization. */
export function placeLimitOrderAction(
  ctx: TradingContext,
  params: {
    quoteType: string
    poolId: string
    price: bigint
    quantity: bigint
    isBid: boolean
    expireTimestamp: bigint
  } & OrderFlags,
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
          arguments: [
            tx.pure.id(ctx.tradingAccountId),
            tx.pure.id(params.poolId),
            tx.pure.u64(params.price),
            tx.pure.u64(params.quantity),
            tx.pure.bool(params.isBid),
            tx.pure.u8(params.orderType ?? 0),
            tx.pure.u8(params.selfMatchingOption ?? 0),
            tx.pure.u64(params.expireTimestamp),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_place_limit_order`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.object(params.poolId),
            tx.object(ctx.tradingAccountId),
            tx.object(ctx.capVaultId),
            tx.object(CLOCK_ID),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/** Cancel one of the organization's resting orders. */
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
            tx.pure.u64(params.orderId),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_cancel_order`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.object(params.poolId),
            tx.object(ctx.tradingAccountId),
            tx.object(ctx.capVaultId),
            tx.object(CLOCK_ID),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/** Sweep quote coin (CRED) from the trading account back into the treasury. */
export function sweepCoinToTreasuryAction(
  ctx: TradingContext,
  params: { quoteType: string; amount: bigint; treasuryVaultId: string },
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const typeKey = `${pkg}::sweep_coin_to_treasury::SweepCoinToTreasury`
  return {
    kind: 'sweep_coin_to_treasury',
    own: {
      typeKey,
      payloadMoveType: `${typeKey}<${params.quoteType}>`,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::sweep_coin_to_treasury::new`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.pure.id(ctx.tradingAccountId),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_sweep_coin_to_treasury`,
          typeArguments: [params.quoteType],
          arguments: [
            tx.object(params.treasuryVaultId),
            tx.object(ctx.tradingAccountId),
            tx.object(ctx.capVaultId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/** Park items from the trading account into shared storage. */
export function sweepMulticoinToDaoVaultAction(
  ctx: TradingContext,
  params: {
    daoVaultId: string
    collectionId: string
    assetId: bigint
    amount: bigint
  },
): OuProposalAction {
  const pkg = ctx.armatureTrading
  const typeKey = `${pkg}::sweep_multicoin_to_dao_vault::SweepMulticoinToDaoVault`
  return {
    kind: 'sweep_multicoin_to_dao_vault',
    own: {
      typeKey,
      payloadMoveType: typeKey,
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${pkg}::sweep_multicoin_to_dao_vault::new`,
          arguments: [
            tx.pure.id(ctx.tradingAccountId),
            tx.pure.id(params.daoVaultId),
            tx.pure.id(params.collectionId),
            tx.pure.u64(params.assetId),
            tx.pure.u64(params.amount),
          ],
        }),
      buildExecute: (tx, ticket, ownDaoId) => {
        tx.moveCall({
          target: `${pkg}::trading_ops::execute_sweep_multicoin_to_dao_vault`,
          arguments: [
            tx.object(params.daoVaultId),
            tx.object(ctx.tradingAccountId),
            tx.object(ctx.capVaultId),
            tx.object(ownDaoId),
            ticket,
          ],
        })
      },
    },
    fallbackPolicy: single,
  }
}

/**
 * Claim a pool's settled balances into the trading account, appended to an
 * existing PTB.
 *
 * NOT governance and NOT an action: `withdraw_settled_amounts_permissionless`
 * only ever moves funds pool → trading account, so it needs no `TradeCap` and
 * no vote. It exists as a fragment because it belongs in FRONT of a sweep — a
 * resting maker order that filled leaves its proceeds in the pool, not the
 * trading account, so sweeping without claiming first silently moves less than
 * the caller expects.
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

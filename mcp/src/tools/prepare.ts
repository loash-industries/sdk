import { z } from 'zod'
import { NothingToPrepare, captureTransaction } from '../capture.js'
import { toPrepared } from '../prepare.js'
import type { PreparedIntent, WorstCaseSpend } from '../prepare.js'
import type { RequestContext } from '../context.js'
import { ok } from '../result.js'
import type { ToolResponse } from '../result.js'
import {
  big,
  bigOpt,
  hubAssetShape,
  objectId,
  orderSide,
  senderShape,
  u64,
} from '../schemas.js'
import type { ToolDef } from './types.js'

/**
 * Run an SDK write call with the capture executor and serialize the built
 * transaction. Nothing is signed and nothing is submitted.
 */
async function prepared(
  ctx: RequestContext,
  sender: string,
  intent: Omit<PreparedIntent, 'targets'>,
  run: () => Promise<unknown>,
): Promise<ToolResponse> {
  try {
    const tx = await captureTransaction(run)
    return ok(await toPrepared(tx, sender, ctx.suiClient(), intent))
  } catch (e) {
    if (e instanceof NothingToPrepare) {
      return ok({
        prepared: false,
        reason:
          'No transaction is needed for this action in its current state.',
        detail: e.result ?? null,
      })
    }
    throw e
  }
}

const spend = (
  asset: string,
  amount: string,
  kind: WorstCaseSpend['kind'] = 'currency',
): WorstCaseSpend => ({ asset, amount, kind })

const PREPARE_SUFFIX =
  ' Returns unsigned transaction bytes — this server never signs or submits. Verify the returned intent against the bytes, then sponsor, sign and submit with your own key.'

export const prepareTools: ToolDef[] = [
  {
    name: 'prepare_create_account',
    title: 'Prepare: create trading account',
    description:
      'Build the transaction that creates a BalanceManager (trading account) for an address. Returns prepared:false when one already exists.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'account.ensure',
    inputShape: { ...senderShape },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        { action: 'create_account', params: { sender: args.sender } },
        () => ctx.writeClient(args.sender).account.ensure(),
      ),
  },
  {
    name: 'prepare_deposit_currency',
    title: 'Prepare: deposit CRED',
    description:
      'Build a deposit of CRED from the wallet into the trading account.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'account.depositCurrency',
    inputShape: {
      ...senderShape,
      amount: u64.describe('CRED in base units (6 decimals).'),
    },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'deposit_currency',
          params: { amount: args.amount },
          worstCaseSpend: spend('CRED', args.amount),
        },
        () =>
          ctx
            .writeClient(args.sender)
            .account.depositCurrency({ amount: big(args.amount) }),
      ),
  },
  {
    name: 'prepare_deposit_items',
    title: 'Prepare: deposit items',
    description:
      'Build a deposit of EVE Frontier items from receipts or the hangar into the trading account as warehouse receipts.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'account.depositItems',
    inputShape: {
      ...senderShape,
      storageUnitId: objectId,
      items: z
        .array(z.object({ assetId: z.string(), amount: u64 }))
        .min(1)
        .describe('Items to deposit, by asset id and whole-unit amount.'),
    },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'deposit_items',
          params: { storageUnitId: args.storageUnitId, items: args.items },
        },
        () =>
          ctx.writeClient(args.sender).account.depositItems({
            storageUnitId: args.storageUnitId,
            items: args.items.map((i: { assetId: string; amount: string }) => ({
              assetId: i.assetId,
              amount: big(i.amount),
            })),
          }),
      ),
  },
  {
    name: 'prepare_withdraw_currency',
    title: 'Prepare: withdraw CRED',
    description:
      'Build a withdrawal of CRED from the trading account back to the wallet. Omit amount to withdraw the full balance.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'account.withdrawCurrency',
    inputShape: { ...senderShape, amount: u64.optional() },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'withdraw_currency',
          params: { amount: args.amount ?? 'full balance' },
        },
        () =>
          ctx
            .writeClient(args.sender)
            .account.withdrawCurrency({ amount: bigOpt(args.amount) }),
      ),
  },
  {
    name: 'prepare_withdraw_items',
    title: 'Prepare: withdraw items',
    description:
      'Build a full withdrawal of the listed items from the trading account, redeeming them into the hangar at the hub.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'account.withdrawItems',
    inputShape: {
      ...senderShape,
      storageUnitId: objectId,
      items: z.array(z.object({ assetId: z.string() })).min(1),
      characterId: objectId.optional(),
    },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'withdraw_items',
          params: { storageUnitId: args.storageUnitId, items: args.items },
        },
        () =>
          ctx.writeClient(args.sender).account.withdrawItems({
            storageUnitId: args.storageUnitId,
            items: args.items,
            ...(args.characterId ? { characterId: args.characterId } : {}),
          }),
      ),
  },
  {
    name: 'prepare_claim_settled',
    title: 'Prepare: claim proceeds',
    description:
      'Build a claim of unclaimed proceeds from filled orders. Defaults to every pool the sweepable read reports.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'account.claimSettled',
    inputShape: {
      ...senderShape,
      poolIds: z.array(objectId).optional(),
    },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        { action: 'claim_settled', params: { poolIds: args.poolIds ?? 'all' } },
        () =>
          ctx
            .writeClient(args.sender)
            .account.claimSettled(
              args.poolIds ? { poolIds: args.poolIds } : undefined,
            ),
      ),
  },
  {
    name: 'prepare_limit_order',
    title: 'Prepare: limit order',
    description:
      'Build a limit order: creates the trading account if missing, deposits only the deficit, and places the order — one atomic transaction.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'orders.limit',
    inputShape: {
      ...senderShape,
      ...hubAssetShape,
      side: orderSide,
      price: u64.describe('CRED base units per item.'),
      quantity: u64.describe(
        'Whole item units; must be a multiple of lot size.',
      ),
      expireAt: u64
        .optional()
        .describe('Unix ms; omit for good-til-cancelled.'),
      orderType: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe('0=LIMIT, 1=IOC, 2=FOK, 3=POST_ONLY.'),
      selfMatchingOption: z.number().int().min(0).max(2).optional(),
      quoteDeposit: u64
        .optional()
        .describe('Override the computed CRED deposit for a bid.'),
    },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'limit_order',
          params: {
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            side: args.side,
            price: args.price,
            quantity: args.quantity,
            expireAt: args.expireAt ?? 'good-til-cancelled',
          },
          ...(args.side === 'buy'
            ? {
                worstCaseSpend: spend(
                  'CRED',
                  args.quoteDeposit ??
                    (big(args.price) * big(args.quantity)).toString(),
                ),
              }
            : {
                worstCaseSpend: spend(args.assetId, args.quantity, 'item'),
              }),
        },
        () =>
          ctx.writeClient(args.sender).orders.limit({
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            side: args.side,
            price: big(args.price),
            quantity: big(args.quantity),
            ...(args.expireAt ? { expireAt: big(args.expireAt) } : {}),
            ...(args.orderType !== undefined
              ? { orderType: args.orderType }
              : {}),
            ...(args.selfMatchingOption !== undefined
              ? { selfMatchingOption: args.selfMatchingOption }
              : {}),
            ...(args.quoteDeposit
              ? { quoteDeposit: big(args.quoteDeposit) }
              : {}),
          }),
      ),
  },
  {
    name: 'prepare_market_order',
    title: 'Prepare: market order',
    description:
      'Build a market order. Buys require quoteBudget — the worst-case CRED cost including fees; derive it from market_orderbook.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'orders.market',
    inputShape: {
      ...senderShape,
      ...hubAssetShape,
      side: orderSide,
      quantity: u64,
      quoteBudget: u64
        .optional()
        .describe('Required for buys: worst-case CRED spend including fees.'),
      selfMatchingOption: z.number().int().min(0).max(2).optional(),
    },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'market_order',
          params: {
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            side: args.side,
            quantity: args.quantity,
          },
          ...(args.side === 'buy'
            ? args.quoteBudget
              ? { worstCaseSpend: spend('CRED', args.quoteBudget) }
              : {}
            : { worstCaseSpend: spend(args.assetId, args.quantity, 'item') }),
        },
        () =>
          ctx.writeClient(args.sender).orders.market({
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            side: args.side,
            quantity: big(args.quantity),
            ...(args.quoteBudget ? { quoteBudget: big(args.quoteBudget) } : {}),
            ...(args.selfMatchingOption !== undefined
              ? { selfMatchingOption: args.selfMatchingOption }
              : {}),
          }),
      ),
  },
  {
    name: 'prepare_cancel_order',
    title: 'Prepare: cancel order',
    description: 'Build a cancellation of one resting order.' + PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'orders.cancel',
    inputShape: { ...senderShape, ...hubAssetShape, orderId: z.string() },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        { action: 'cancel_order', params: { orderId: args.orderId } },
        () =>
          ctx.writeClient(args.sender).orders.cancel({
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            orderId: args.orderId,
          }),
      ),
  },
  {
    name: 'prepare_cancel_all_orders',
    title: 'Prepare: cancel all orders',
    description:
      'Build a cancellation of every resting order for one item at one hub.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'orders.cancelAll',
    inputShape: { ...senderShape, ...hubAssetShape },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'cancel_all_orders',
          params: {
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
          },
        },
        () =>
          ctx.writeClient(args.sender).orders.cancelAll({
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
          }),
      ),
  },
  {
    name: 'prepare_modify_order',
    title: 'Prepare: resize order',
    description:
      'Build a resize of a resting order. The new quantity must be below the original and above the filled amount.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'orders.modify',
    inputShape: {
      ...senderShape,
      ...hubAssetShape,
      orderId: z.string(),
      newQuantity: u64,
    },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'modify_order',
          params: { orderId: args.orderId, newQuantity: args.newQuantity },
        },
        () =>
          ctx.writeClient(args.sender).orders.modify({
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            orderId: args.orderId,
            newQuantity: big(args.newQuantity),
          }),
      ),
  },
]

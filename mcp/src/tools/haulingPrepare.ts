import { z } from 'zod'
import { big, objectId, senderShape, suiAddress, u64 } from '../schemas.js'
import { PREPARE_SUFFIX, prepared, spend } from './prepare.js'
import type { ToolDef } from './types.js'

/**
 * Prepare tools for hauling-agreement writes. Like every prepare tool they
 * build unsigned bytes for `sender` and never sign or submit. Coins and item
 * balances come from the sender's wallet (and hangar), and whatever the
 * contract hands back goes to the sender.
 */

const agreementShape = {
  ...senderShape,
  agreementId: objectId.describe('The hauling agreement object id.'),
}

const item = z.object({
  assetId: z.string().describe('Item asset id, e.g. "78437".'),
  quantity: u64.describe('Units, as a decimal string.'),
})

const principal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('player'), address: suiAddress }),
  z.object({ kind: z.literal('machine'), address: suiAddress }),
  z.object({ kind: z.literal('ou'), orgId: objectId }),
])

const AFTER_READ =
  ' Reads the agreement first (status, currency, amounts, cap and proceeds ids) and refuses before building when its status rules the action out.'

export const haulingPrepareTools: ToolDef[] = [
  {
    name: 'prepare_hauling_post',
    title: 'Prepare: post a hauling agreement',
    description:
      'Build a new hauling agreement: escrow cargo from the pickup hub and a reward, set what must be delivered to the destination hub, the collateral a hauler locks, how long it can be accepted and how long the hauler has to deliver, and optionally who may accept (a claim gate of players, machine keys or organizations). Cargo comes from the sender’s wallet-held receipts in the pickup hub’s collection, then from their hangar there (useHangar, default true). The config’s posting fee is paid too. The sender keeps the lister cap, which cancels the agreement and collects its proceeds. Amounts are raw base units as decimal strings.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'hauling.post',
    inputShape: {
      ...senderShape,
      pickupStorageUnitId: z
        .string()
        .describe('The hub (storage unit id) the cargo is at.'),
      cargo: z
        .array(item)
        .min(1)
        .describe('What to escrow, one entry per item.'),
      destinationStorageUnitId: z
        .string()
        .describe('The hub the wanted items must reach.'),
      want: z
        .array(item)
        .min(1)
        .optional()
        .describe(
          'What must be handed in at the destination; default: the cargo.',
        ),
      currency: z
        .string()
        .optional()
        .describe(
          'Reward and collateral coin type; default CRED. See hauling_config.',
        ),
      reward: u64.describe('Escrowed reward, raw base units.'),
      collateral: u64.describe(
        'Collateral a hauler locks on accept, raw base units.',
      ),
      acceptWindowMs: z
        .number()
        .int()
        .positive()
        .describe('How long the agreement can be accepted, ms from posting.'),
      haulDurationMs: z
        .number()
        .int()
        .positive()
        .describe('How long a hauler has to deliver once they accept, ms.'),
      beneficiary: suiAddress
        .optional()
        .describe(
          'Paid on delivery or default; omitted pays whoever holds the lister cap.',
        ),
      principals: z
        .array(principal)
        .max(32)
        .optional()
        .describe('Who may accept; omitted: anyone.'),
      useHangar: z.boolean().optional(),
    },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'hauling_post',
          worstCaseSpend: spend(args.currency ?? 'CRED', args.reward),
          params: args,
        },
        () =>
          ctx.writeClient(args.sender).hauling.post({
            pickupStorageUnitId: args.pickupStorageUnitId,
            cargo: args.cargo.map((c: any) => ({
              assetId: c.assetId,
              quantity: big(c.quantity),
            })),
            destinationStorageUnitId: args.destinationStorageUnitId,
            want: args.want?.map((w: any) => ({
              assetId: w.assetId,
              quantity: big(w.quantity),
            })),
            currency: args.currency,
            reward: big(args.reward),
            collateral: big(args.collateral),
            acceptWindowMs: args.acceptWindowMs,
            haulDurationMs: args.haulDurationMs,
            beneficiary: args.beneficiary,
            principals: args.principals,
            useHangar: args.useHangar,
          }),
      ),
  },
  {
    name: 'prepare_hauling_accept',
    title: 'Prepare: accept a hauling agreement',
    description:
      'Build an accept of an open hauling agreement: lock its collateral from the sender’s wallet and take the cargo. Claim gates are satisfied as the gateway’s claim plan for the sender says — directly, or through an organization whose board they sit on. Refuses when the sender is not on the claim list. Check hauling_claimable first.' +
      AFTER_READ +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'hauling.accept',
    inputShape: agreementShape,
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        { action: 'hauling_accept', params: { agreementId: args.agreementId } },
        () =>
          ctx
            .writeClient(args.sender)
            .hauling.accept({ agreementId: args.agreementId }),
      ),
  },
  {
    name: 'prepare_hauling_deliver',
    title: 'Prepare: deliver a hauling agreement',
    description:
      'Build the delivery of an accepted hauling agreement before its deadline: hand in exactly the wanted items, from the sender’s wallet-held receipts in each item’s collection, then from their hangar at the destination hub (useHangar, default true). The hauler is paid the reward minus the delivery fee and gets the collateral back.' +
      AFTER_READ +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'hauling.deliver',
    inputShape: { ...agreementShape, useHangar: z.boolean().optional() },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'hauling_deliver',
          params: { agreementId: args.agreementId },
        },
        () =>
          ctx.writeClient(args.sender).hauling.deliver({
            agreementId: args.agreementId,
            useHangar: args.useHangar,
          }),
      ),
  },
  {
    name: 'prepare_hauling_cancel',
    title: 'Prepare: cancel a hauling agreement',
    description:
      'Build the cancellation of an open (or lapsed) hauling agreement by its lister: the cargo and reward come back to the sender, who must hold the lister cap.' +
      AFTER_READ +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'hauling.cancel',
    inputShape: agreementShape,
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        { action: 'hauling_cancel', params: { agreementId: args.agreementId } },
        () =>
          ctx
            .writeClient(args.sender)
            .hauling.cancel({ agreementId: args.agreementId }),
      ),
  },
  {
    name: 'prepare_hauling_default',
    title: 'Prepare: default an overdue hauling agreement',
    description:
      'Build a default of an accepted hauling agreement past its delivery deadline. Permissionless: the reward and the hauler’s collateral go to whoever the terms pay.' +
      AFTER_READ +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'hauling.default',
    inputShape: agreementShape,
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'hauling_default',
          params: { agreementId: args.agreementId },
        },
        () =>
          ctx
            .writeClient(args.sender)
            .hauling.default({ agreementId: args.agreementId }),
      ),
  },
  {
    name: 'prepare_hauling_forfeit',
    title: 'Prepare: forfeit a hauling agreement',
    description:
      'Build a forfeit by the hauler of an accepted agreement before its deadline: the same payout as a default (reward and collateral to whoever the terms pay), now instead of later. Only the hauler can forfeit.' +
      AFTER_READ +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'hauling.forfeit',
    inputShape: agreementShape,
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'hauling_forfeit',
          params: { agreementId: args.agreementId },
        },
        () =>
          ctx
            .writeClient(args.sender)
            .hauling.forfeit({ agreementId: args.agreementId }),
      ),
  },
  {
    name: 'prepare_hauling_collect',
    title: 'Prepare: collect hauling proceeds',
    description:
      'Build the collection of what an ended agreement sent to its lister cap: the wanted items after a delivery, the reward and collateral after a default or forfeit, the cargo and reward after a lapse. The sender must hold the lister cap. hauling_actions lists proceeds waiting to be collected.' +
      AFTER_READ +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'hauling.collect',
    inputShape: agreementShape,
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'hauling_collect',
          params: { agreementId: args.agreementId },
        },
        () =>
          ctx
            .writeClient(args.sender)
            .hauling.collect({ agreementId: args.agreementId }),
      ),
  },
  {
    name: 'prepare_hauling_delete_cap',
    title: 'Prepare: delete a spent lister cap',
    description:
      'Build the deletion of a lister cap that doesn’t receive proceeds (its agreement pays a fixed beneficiary). Refuses a cap that receives proceeds — collect those instead.' +
      AFTER_READ +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'hauling.deleteCap',
    inputShape: agreementShape,
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'hauling_delete_cap',
          params: { agreementId: args.agreementId },
        },
        () =>
          ctx
            .writeClient(args.sender)
            .hauling.deleteCap({ agreementId: args.agreementId }),
      ),
  },
]

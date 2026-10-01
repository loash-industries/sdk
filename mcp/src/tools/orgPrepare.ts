import { z } from 'zod'
import { NothingToPrepare, captureTransaction } from '../capture.js'
import { toPrepared } from '../prepare.js'
import type { PreparedIntent } from '../prepare.js'
import type { RequestContext } from '../context.js'
import { ok } from '../result.js'
import type { ToolResponse } from '../result.js'
import {
  big,
  bigOpt,
  objectId,
  orderSide,
  suiAddress,
  u64,
} from '../schemas.js'
import type { ToolDef } from './types.js'

/**
 * Armature governance writes, prepared unsigned.
 *
 * These differ from the trading `prepare_*` tools in one way that matters to a
 * caller: a governance action does not have a fixed outcome. The SAME call
 * executes in one transaction for an officer whose lone vote clears quorum, and
 * creates a proposal for someone whose does not — and for a third caller it is
 * refused outright because they hold no seat. The prepared bytes therefore
 * carry an `outcome` field saying which of those happened, and a `blocked`
 * result returns `prepared: false` with the reason rather than an error.
 *
 * Check `intent.outcome` before assuming a transaction did what you asked. A
 * `proposed` result means the board still has to vote.
 */

const PREPARE_SUFFIX =
  ' Returns unsigned transaction bytes — this server never signs or submits. Verify the returned intent against the bytes, then sponsor, sign and submit with your own key.'

const GOVERNANCE_NOTE =
  'Governance actions resolve per caller: intent.outcome is "executed" when your single vote passes it now, or "proposed" when the board must vote first. prepared:false means no path was available and the reason says why.'

const actingShape = {
  orgId: objectId.describe(
    'Organization object id — the root or any unit in its tree.',
  ),
  sender: suiAddress.describe(
    'Sui address the transaction is built for; only this address can sign it. Also the address whose board seat is resolved.',
  ),
  seat: objectId
    .optional()
    .describe(
      'Unit id to act through. Defaults to the caller’s highest-authority seat.',
    ),
}

const ACTING_SYNTHETIC = {
  orgId:
    'Names the organization whose handle is opened; the SDK reads it from client.org(id).',
  sender:
    'The address a prepared transaction is built for, and whose seat is resolved; per-request because this server is keyless and multi-tenant.',
  seat: 'Which unit to act through; the SDK takes it from the handle.',
}

/**
 * Run a governance write with the capture executor and serialize the result.
 *
 * The SDK returns `RunOutcome` rather than throwing on a refusal, so a blocked
 * action produces no transaction at all — reported as `prepared: false`, the
 * same shape the trading tools use for "nothing to do".
 */
async function preparedGovernance(
  ctx: RequestContext,
  sender: string,
  action: string,
  params: Record<string, unknown>,
  run: () => Promise<{ status: string; code?: string; reason?: string }>,
): Promise<ToolResponse> {
  let outcome: { status: string; code?: string; reason?: string } | undefined
  try {
    const tx = await captureTransaction(async () => {
      outcome = await run()
      return outcome
    })
    const intent: Omit<PreparedIntent, 'targets'> = {
      action,
      params: { ...params, outcome: outcome?.status ?? 'executed' },
    }
    return ok(
      await toPrepared(tx, sender, ctx.suiClient(), intent, [GOVERNANCE_NOTE]),
    )
  } catch (e) {
    if (e instanceof NothingToPrepare) {
      // A blocked resolution never reaches the executor, so there is nothing to
      // capture — surface the resolver's reason, which is the useful answer.
      const blocked = outcome as
        { status: string; code?: string; reason?: string } | undefined
      return ok({
        prepared: false,
        reason:
          blocked?.status === 'blocked'
            ? blocked.reason
            : 'No transaction is needed for this action in its current state.',
        code: blocked?.code ?? null,
        detail: e.result ?? null,
      })
    }
    throw e
  }
}

const org = (
  ctx: RequestContext,
  args: { orgId: string; sender: string; seat?: string },
) => ctx.writeClient(args.sender).org(args.orgId, { seat: args.seat })

export const orgPrepareTools: ToolDef[] = [
  // ─── membership ────────────────────────────────────────────────────────────
  {
    name: 'prepare_org_add_members',
    title: 'Prepare: seat members on a unit',
    description:
      'Add addresses to a unit’s board. Sub-DAOs are deny-by-default for board changes, so this normally travels the parent unit’s control capability rather than the unit’s own governance.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.members.add',
    inputShape: {
      ...actingShape,
      addresses: z.array(suiAddress).min(1),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_add_members',
        { orgId: args.orgId, addresses: args.addresses },
        async () => (await org(ctx, args)).members.add(args.addresses),
      ),
  },
  {
    name: 'prepare_org_remove_members',
    title: 'Prepare: remove members from a unit',
    description:
      'Remove addresses from a sub-unit’s board. Control-only on-chain, so it needs a parent unit — on a ROOT unit this is refused and prepare_org_set_board with the remaining members is the way.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.members.remove',
    inputShape: { ...actingShape, addresses: z.array(suiAddress).min(1) },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_remove_members',
        { orgId: args.orgId, addresses: args.addresses },
        async () => (await org(ctx, args)).members.remove(args.addresses),
      ),
  },
  {
    name: 'prepare_org_set_board',
    title: 'Prepare: replace a unit’s board',
    description:
      'Replace a unit’s board wholesale with the given addresses. This is the removal path on a root unit, which has no parent to act through.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.members.setBoard',
    inputShape: { ...actingShape, addresses: z.array(suiAddress).min(1) },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_set_board',
        { orgId: args.orgId, addresses: args.addresses },
        async () => (await org(ctx, args)).members.setBoard(args.addresses),
      ),
  },
  {
    name: 'prepare_org_update_metadata',
    title: 'Prepare: update an organization’s metadata',
    description:
      'Point a unit’s charter at a new metadata document. The URI must already be uploaded — this server does not host metadata.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.metadata.update',
    inputShape: {
      ...actingShape,
      metadataUri: z.string().min(1),
      charterId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_update_metadata',
        { orgId: args.orgId, metadataUri: args.metadataUri },
        async () =>
          (await org(ctx, args)).metadata.update({
            metadataUri: args.metadataUri,
            charterId: args.charterId,
          }),
      ),
  },

  // ─── proposal-type administration ──────────────────────────────────────────
  {
    name: 'prepare_org_enable_type',
    title: 'Prepare: enable a proposal type',
    description:
      'Enable an arbitrary proposal type on a unit with the given voting rules. Quorum and approval are basis points (10000 = 100%); a lone vote can pass a type only when boardSize × quorum ≤ 10000 and executionDelayMs is 0.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.enable',
    inputShape: {
      ...actingShape,
      typeKey: z
        .string()
        .min(1)
        .describe('Bare on-chain type key, e.g. "SetBoard".'),
      moveType: z
        .string()
        .min(1)
        .describe('Fully-qualified Move payload type.'),
      quorum: z.number().int().min(0).max(10000),
      approvalThreshold: z.number().int().min(0).max(10000),
      proposeThreshold: z.number().int().min(0).default(0),
      expiryMs: z.number().int().min(0),
      executionDelayMs: z.number().int().min(0).default(0),
      cooldownMs: z.number().int().min(0).default(0),
      composableAllowed: z.boolean().optional(),
    },
    syntheticParams: {
      ...ACTING_SYNTHETIC,
      // The SDK takes one nested `config` object. A flat schema is materially
      // easier for a tool caller to get right than a nested one, so the tool
      // flattens it and reassembles below.
      quorum: 'Flattened into the SDK’s nested `config`.',
      approvalThreshold: 'Flattened into the SDK’s nested `config`.',
      proposeThreshold: 'Flattened into the SDK’s nested `config`.',
      expiryMs: 'Flattened into the SDK’s nested `config`.',
      executionDelayMs: 'Flattened into the SDK’s nested `config`.',
      cooldownMs: 'Flattened into the SDK’s nested `config`.',
    },
    derivedParams: {
      config: 'Assembled from the flat quorum / threshold / timing inputs.',
    },
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_type',
        { orgId: args.orgId, typeKey: args.typeKey },
        async () =>
          (await org(ctx, args)).types.enable({
            typeKey: args.typeKey,
            moveType: args.moveType,
            config: {
              quorum: args.quorum,
              approvalThreshold: args.approvalThreshold,
              proposeThreshold: args.proposeThreshold ?? 0,
              expiryMs: args.expiryMs,
              executionDelayMs: args.executionDelayMs ?? 0,
              cooldownMs: args.cooldownMs ?? 0,
            },
            composableAllowed: args.composableAllowed,
          }),
      ),
  },
  {
    name: 'prepare_org_update_type_config',
    title: 'Prepare: change a proposal type’s rules',
    description:
      'Change the voting rules of an already-enabled type. Every field is optional and anything omitted keeps its current value.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.updateConfig',
    inputShape: {
      ...actingShape,
      typeKey: z.string().min(1),
      quorum: z.number().int().min(0).max(10000).optional(),
      approvalThreshold: z.number().int().min(0).max(10000).optional(),
      proposeThreshold: z.number().int().min(0).optional(),
      expiryMs: z.number().int().min(0).optional(),
      executionDelayMs: z.number().int().min(0).optional(),
      cooldownMs: z.number().int().min(0).optional(),
      composableAllowed: z.boolean().optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_update_type_config',
        { orgId: args.orgId, typeKey: args.typeKey },
        async () =>
          (await org(ctx, args)).types.updateConfig(args.typeKey, {
            quorum: args.quorum,
            approvalThreshold: args.approvalThreshold,
            proposeThreshold: args.proposeThreshold,
            expiryMs: args.expiryMs,
            executionDelayMs: args.executionDelayMs,
            cooldownMs: args.cooldownMs,
            composableAllowed: args.composableAllowed,
          }),
      ),
  },
  {
    name: 'prepare_org_enable_composite',
    title: 'Prepare: enable composite proposals',
    description:
      'Enable the Composite type so several actions can be bundled into one proposal the board votes on once.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.enableComposite',
    inputShape: { ...actingShape },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_composite',
        { orgId: args.orgId },
        async () => (await org(ctx, args)).types.enableComposite(),
      ),
  },
  {
    name: 'prepare_org_enable_send_coin',
    title: 'Prepare: enable treasury withdrawals of a coin',
    description:
      'Register the per-coin SendCoin type so the unit can pay that coin out of its treasury. Per-coin by necessity: a DAO binds exactly one Move type per key, so each coin needs its own.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.enableSendCoin',
    inputShape: {
      ...actingShape,
      coinType: z.string().optional().describe('Defaults to CRED.'),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_send_coin',
        { orgId: args.orgId, coinType: args.coinType ?? 'CRED' },
        async () => (await org(ctx, args)).types.enableSendCoin(args.coinType),
      ),
  },
  {
    name: 'prepare_org_enable_trading',
    title: 'Prepare: enable organization trading',
    description:
      'Enable every armature_trading proposal type the unit is missing, in one transaction — the prerequisite for any prepare_org_*order* tool. ' +
      'bindToBaseType is IRREVERSIBLE: it enables the coin-pool order types bound to that ONE base coin, permanently, after which the unit can trade only that base through governance. Organizations created normally already carry the unbound keys and trade any base freely — leave it unset.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.enableTrading',
    inputShape: {
      ...actingShape,
      quoteType: z.string().optional().describe('Defaults to CRED.'),
      bindToBaseType: z
        .string()
        .optional()
        .describe(
          'IRREVERSIBLE — binds coin-order types to this one base coin.',
        ),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_trading',
        { orgId: args.orgId, bindToBaseType: args.bindToBaseType ?? null },
        async () =>
          (await org(ctx, args)).types.enableTrading({
            quoteType: args.quoteType,
            bindToBaseType: args.bindToBaseType,
          }),
      ),
  },

  // ─── voting and execution ──────────────────────────────────────────────────
  {
    name: 'prepare_org_vote',
    title: 'Prepare: vote on a proposal',
    description:
      'Cast a vote on an open proposal. payloadType is looked up from the indexer when omitted, which costs a request and cannot see a proposal created seconds ago — pass it to skip both.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.governance.vote',
    inputShape: {
      ...actingShape,
      proposalId: objectId,
      approve: z.boolean(),
      payloadType: z.string().optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vote',
        { proposalId: args.proposalId, approve: args.approve },
        async () => {
          await (
            await org(ctx, args)
          ).governance.vote({
            proposalId: args.proposalId,
            approve: args.approve,
            payloadType: args.payloadType,
          })
          return { status: 'executed' }
        },
      ),
  },
  {
    name: 'prepare_org_execute_proposal',
    title: 'Prepare: execute a passed proposal',
    description:
      'Execute a proposal the board already passed, dispatching to the same handler the single-vote path would have used. A composite runs its whole frame pipeline in one transaction, and is refused outright if any step has no wired executor — declining beats running half a pipeline.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.governance.execute',
    inputShape: { ...actingShape, proposalId: objectId },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_execute_proposal',
        { proposalId: args.proposalId },
        async () => {
          await (await org(ctx, args)).governance.execute(args.proposalId)
          return { status: 'executed' }
        },
      ),
  },
  {
    name: 'prepare_org_expire_proposal',
    title: 'Prepare: retire a lapsed proposal',
    description:
      'Retire a proposal whose voting window has lapsed. Permissionless. The indexer reports such proposals as "pending" until someone calls this, so pending and still-votable are not the same thing.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.governance.tryExpire',
    inputShape: {
      ...actingShape,
      proposalId: objectId,
      payloadType: z.string().optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_expire_proposal',
        { proposalId: args.proposalId },
        async () => {
          await (
            await org(ctx, args)
          ).governance.tryExpire({
            proposalId: args.proposalId,
            payloadType: args.payloadType,
          })
          return { status: 'executed' }
        },
      ),
  },

  // ─── treasury ──────────────────────────────────────────────────────────────
  {
    name: 'prepare_org_treasury_deposit',
    title: 'Prepare: fund an organization treasury',
    description:
      'Deposit a coin from the wallet into an organization’s treasury. PERMISSIONLESS — no board seat and no vote; anyone can fund an organization. This is the one org write that works with no seat at all.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.treasury.deposit',
    inputShape: {
      ...actingShape,
      amount: u64,
      coinType: z.string().optional().describe('Defaults to CRED.'),
      treasuryVaultId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_treasury_deposit',
        { orgId: args.orgId, amount: args.amount },
        async () => {
          await (
            await org(ctx, args)
          ).treasury.deposit({
            amount: big(args.amount),
            coinType: args.coinType,
            treasuryVaultId: args.treasuryVaultId,
          })
          return { status: 'executed' }
        },
      ),
  },
  {
    name: 'prepare_org_treasury_send',
    title: 'Prepare: pay out of an organization treasury',
    description:
      'Pay a coin from the unit’s treasury to a wallet address. Governance-sensitive: on a real board this resolves to a PROPOSAL rather than an immediate payment — check intent.outcome. Requires the coin’s SendCoin type to be enabled first.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.treasury.send',
    inputShape: {
      ...actingShape,
      recipient: suiAddress,
      amount: u64,
      coinType: z.string().optional(),
      treasuryVaultId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_treasury_send',
        { recipient: args.recipient, amount: args.amount },
        async () =>
          (await org(ctx, args)).treasury.send({
            recipient: args.recipient,
            amount: big(args.amount),
            coinType: args.coinType,
            treasuryVaultId: args.treasuryVaultId,
          }),
      ),
  },
  {
    name: 'prepare_org_treasury_send_to_org',
    title: 'Prepare: pay another organization',
    description:
      'Move funds from this unit’s treasury into ANOTHER organization’s treasury. recipientTreasuryId is that organization’s TreasuryVault object id — not its org id and not a wallet; passing either aborts on-chain.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.treasury.sendToOrg',
    inputShape: {
      ...actingShape,
      recipientTreasuryId: objectId,
      amount: u64,
      coinType: z.string().optional(),
      treasuryVaultId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_treasury_send_to_org',
        { recipientTreasuryId: args.recipientTreasuryId, amount: args.amount },
        async () =>
          (await org(ctx, args)).treasury.sendToOrg({
            recipientTreasuryId: args.recipientTreasuryId,
            amount: big(args.amount),
            coinType: args.coinType,
            treasuryVaultId: args.treasuryVaultId,
          }),
      ),
  },

  // ─── trading as the organization ───────────────────────────────────────────
  {
    name: 'prepare_org_setup_trading',
    title: 'Prepare: give an organization a trading account',
    description:
      'Create the organization’s shared TradingAccount. Refused when one already exists — check org_trading_account first.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.ensureAccount',
    inputShape: { ...actingShape },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_setup_trading',
        { orgId: args.orgId },
        async () => (await org(ctx, args)).orders.ensureAccount(),
      ),
  },
  {
    name: 'prepare_org_limit_order',
    title: 'Prepare: place an organization limit order',
    description:
      'Place a limit order using funds ALREADY in the organization’s trading account. To fund it from the treasury or from shared storage in the same transaction, use prepare_org_buy_from_treasury or prepare_org_sell_from_vault instead. Trading actions never degrade into proposals — if a single vote cannot pass it, the result is prepared:false.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.limit',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      assetId: z.string(),
      side: orderSide,
      price: u64,
      quantity: u64,
      expireAt: u64
        .optional()
        .describe('Epoch ms; defaults to good-til-cancelled.'),
      quoteType: z.string().optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_limit_order',
        {
          assetId: args.assetId,
          side: args.side,
          price: args.price,
          quantity: args.quantity,
        },
        async () =>
          (await org(ctx, args)).orders.limit({
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            side: args.side,
            price: big(args.price),
            quantity: big(args.quantity),
            expireAt: bigOpt(args.expireAt),
            quoteType: args.quoteType,
          }),
      ),
  },
  {
    name: 'prepare_org_cancel_order',
    title: 'Prepare: cancel an organization order',
    description:
      'Cancel one of the organization’s resting orders.' + PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.cancel',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      assetId: z.string(),
      orderId: u64,
      quoteType: z.string().optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_cancel_order',
        { assetId: args.assetId, orderId: args.orderId },
        async () =>
          (await org(ctx, args)).orders.cancel({
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            orderId: big(args.orderId),
            quoteType: args.quoteType,
          }),
      ),
  },
  {
    name: 'prepare_org_buy_from_treasury',
    title: 'Prepare: fund a bid from the treasury and place it',
    description:
      'Move quote coin from the treasury into the trading account and place the bid, ATOMICALLY — if the order aborts the deposit rolls back. depositAmount defaults to the full cost including fees, NOT to a shortfall: pass the deficit yourself when the trading account already holds some quote. Over-depositing is safe; under-depositing aborts the whole transaction.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.buyFromTreasury',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      assetId: z.string(),
      price: u64,
      quantity: u64,
      depositAmount: u64.optional(),
      expireAt: u64.optional(),
      quoteType: z.string().optional(),
      treasuryVaultId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    derivedParams: { side: 'Always "buy" — this tool funds a bid.' },
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_buy_from_treasury',
        { assetId: args.assetId, price: args.price, quantity: args.quantity },
        async () =>
          (await org(ctx, args)).orders.buyFromTreasury({
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            side: 'buy',
            price: big(args.price),
            quantity: big(args.quantity),
            depositAmount: bigOpt(args.depositAmount),
            expireAt: bigOpt(args.expireAt),
            quoteType: args.quoteType,
            treasuryVaultId: args.treasuryVaultId,
          }),
      ),
  },
  {
    name: 'prepare_org_sell_from_vault',
    title: 'Prepare: unpark from shared storage and sell',
    description:
      'Take items out of the organization’s shared storage and place the ask, ATOMICALLY. vaultQuantity is how much to pull from the vault, which is not always the order quantity — the trading account may already hold part of the stack. The vault is resolved from the storage unit and this organization.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.sellFromDaoVault',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      assetId: z.string(),
      price: u64,
      quantity: u64,
      vaultQuantity: u64.optional(),
      daoVaultId: objectId.optional(),
      expireAt: u64.optional(),
      quoteType: z.string().optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    derivedParams: { side: 'Always "sell" — this tool places an ask.' },
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_sell_from_vault',
        { assetId: args.assetId, price: args.price, quantity: args.quantity },
        async () =>
          (await org(ctx, args)).orders.sellFromDaoVault({
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            side: 'sell',
            price: big(args.price),
            quantity: big(args.quantity),
            vaultQuantity: bigOpt(args.vaultQuantity),
            daoVaultId: args.daoVaultId,
            expireAt: bigOpt(args.expireAt),
            quoteType: args.quoteType,
          }),
      ),
  },
  {
    name: 'prepare_org_sweep_coin',
    title: 'Prepare: sweep quote coin to the treasury',
    description:
      'Move quote coin out of the trading account back into the treasury. claimFromPool first claims that pool’s settled balances in the same transaction — a resting maker order that filled leaves its proceeds IN the pool, so sweeping without claiming quietly moves less than expected.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.sweepCoin',
    inputShape: {
      ...actingShape,
      amount: u64,
      quoteType: z.string().optional(),
      treasuryVaultId: objectId.optional(),
      claimFromPool: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_sweep_coin',
        { amount: args.amount },
        async () =>
          (await org(ctx, args)).orders.sweepCoin({
            amount: big(args.amount),
            quoteType: args.quoteType,
            treasuryVaultId: args.treasuryVaultId,
            claimFromPool: args.claimFromPool,
          }),
      ),
  },
  {
    name: 'prepare_org_sweep_items',
    title: 'Prepare: park items in shared storage',
    description:
      'Move an item stack out of the trading account into the organization’s shared storage at a hub. As with the coin sweep, claimFromPool claims settled balances first so the amount may include them.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.sweepItems',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      assetId: u64,
      amount: u64,
      daoVaultId: objectId.optional(),
      collectionId: objectId.optional(),
      claimFromPool: objectId.optional(),
      quoteType: z.string().optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_sweep_items',
        { assetId: args.assetId, amount: args.amount },
        async () =>
          (await org(ctx, args)).orders.sweepItems({
            storageUnitId: args.storageUnitId,
            assetId: big(args.assetId),
            amount: big(args.amount),
            daoVaultId: args.daoVaultId,
            collectionId: args.collectionId,
            claimFromPool: args.claimFromPool,
            quoteType: args.quoteType,
          }),
      ),
  },
  {
    name: 'prepare_org_sweep_all',
    title: 'Prepare: park everything the organization is idly holding',
    description:
      'One signature: claim every pool’s settled proceeds, park each item stack in its shared storage, and send the aggregate quote coin to the treasury. Item stacks with no resolvable vault are REPORTED in intent.params.skipped, not silently dropped. The manifest lags chain head by seconds, so a very recent fill may be missed — run it again rather than widening amounts by hand.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.sweepAll',
    inputShape: {
      ...actingShape,
      quoteType: z.string().optional(),
      treasuryVaultId: objectId.optional(),
      includeCurrency: z.boolean().optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_sweep_all',
        { orgId: args.orgId },
        async () => {
          const res = await (
            await org(ctx, args)
          ).orders.sweepAll({
            quoteType: args.quoteType,
            treasuryVaultId: args.treasuryVaultId,
            includeCurrency: args.includeCurrency,
          })
          return { ...res, skipped: res.skipped } as never
        },
      ),
  },

  // ─── shared storage ────────────────────────────────────────────────────────
  {
    name: 'prepare_org_vault_init',
    title: 'Prepare: open shared storage for an organization',
    description:
      'Register a receipt vault for the acting unit at a storage unit. Deposit and withdraw default to the acting unit; EDIT defaults to its PARENT, because a unit that governs its own access control can quietly widen it. At least one editor must be an organization — an all-wallet edit set is rejected on-chain, since a vault whose only editors were bare keys could be bricked beyond recovery.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.vault.init',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      vaultConfigId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    derivedParams: {
      depositPrincipals: 'Defaults to the acting unit.',
      withdrawPrincipals: 'Defaults to the acting unit.',
      editPrincipals:
        'Defaults to the acting unit’s parent (itself at the root).',
    },
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_init',
        { orgId: args.orgId, storageUnitId: args.storageUnitId },
        async () => {
          await (
            await org(ctx, args)
          ).vault.init({
            storageUnitId: args.storageUnitId,
            vaultConfigId: args.vaultConfigId,
          })
          return { status: 'executed' }
        },
      ),
  },
  {
    name: 'prepare_org_vault_deposit',
    title: 'Prepare: move wallet items into shared storage',
    description:
      'Deposit items from the CALLER’S WALLET receipts into the organization’s shared storage. Not governance — the vault’s deposit role is checked against the caller directly. To move items out of the organization’s trading account instead, use prepare_org_sweep_items.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.vault.deposit',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      items: z
        .array(z.object({ assetId: u64, amount: u64 }))
        .min(1)
        .describe('Asset ids and amounts, as decimal strings.'),
      registrantOrgId: objectId.optional(),
      daoVaultId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_deposit',
        { storageUnitId: args.storageUnitId, items: args.items },
        async () => {
          await (
            await org(ctx, args)
          ).vault.deposit({
            storageUnitId: args.storageUnitId,
            items: args.items.map((i: { assetId: string; amount: string }) => ({
              assetId: big(i.assetId),
              amount: big(i.amount),
            })),
            registrantOrgId: args.registrantOrgId,
            daoVaultId: args.daoVaultId,
          })
          return { status: 'executed' }
        },
      ),
  },
  {
    name: 'prepare_org_vault_withdraw',
    title: 'Prepare: take items out of shared storage',
    description:
      'Withdraw items from the organization’s shared storage. "wallet" (the default) transfers the receipt objects to the caller; "hangar" redeems them into the storage unit’s inventory instead and needs a characterId.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.vault.withdraw',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      items: z.array(z.object({ assetId: u64, amount: u64 })).min(1),
      to: z.enum(['wallet', 'hangar']).optional(),
      characterId: objectId.optional(),
      registrantOrgId: objectId.optional(),
      daoVaultId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_withdraw',
        { storageUnitId: args.storageUnitId, to: args.to ?? 'wallet' },
        async () => {
          await (
            await org(ctx, args)
          ).vault.withdraw({
            storageUnitId: args.storageUnitId,
            items: args.items.map((i: { assetId: string; amount: string }) => ({
              assetId: big(i.assetId),
              amount: big(i.amount),
            })),
            to: args.to,
            characterId: args.characterId,
            registrantOrgId: args.registrantOrgId,
            daoVaultId: args.daoVaultId,
          })
          return { status: 'executed' }
        },
      ),
  },
  {
    name: 'prepare_org_vault_grant',
    title: 'Prepare: grant shared-storage access',
    description:
      'Grant (role, principal) pairs on a vault. A principal is either a wallet ("player") or an organization ("ou"). Granting EDIT to an organization goes through a witnessed path that requires a live DAO — the only route the chain allows, so a mistyped org id cannot become an unsatisfiable editor.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.vault.grant',
    inputShape: {
      ...actingShape,
      vaultId: objectId,
      grants: z
        .array(
          z.object({
            role: z.enum(['deposit', 'withdraw', 'edit']),
            kind: z.enum(['player', 'ou']),
            value: suiAddress.describe(
              'Wallet address, or organization id for "ou".',
            ),
          }),
        )
        .min(1),
      editorDaoId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_grant',
        { vaultId: args.vaultId, grants: args.grants },
        async () => {
          await (
            await org(ctx, args)
          ).vault.grant({
            vaultId: args.vaultId,
            grants: args.grants.map(
              (g: { role: string; kind: string; value: string }) => ({
                role: g.role as never,
                principal: { kind: g.kind as never, value: g.value },
              }),
            ),
            editorDaoId: args.editorDaoId,
          })
          return { status: 'executed' }
        },
      ),
  },
  {
    name: 'prepare_org_vault_revoke',
    title: 'Prepare: revoke shared-storage access',
    description:
      'Revoke (role, principal) pairs. A batch that removes NOTHING aborts on-chain rather than succeeding quietly, so you cannot come away believing access was cut when it was not — the usual cause is naming the wrong principal kind for an address.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.vault.revoke',
    inputShape: {
      ...actingShape,
      vaultId: objectId,
      revocations: z
        .array(
          z.object({
            role: z.enum(['deposit', 'withdraw', 'edit']),
            kind: z.enum(['player', 'ou']),
            value: suiAddress,
          }),
        )
        .min(1),
      editorDaoId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_revoke',
        { vaultId: args.vaultId, revocations: args.revocations },
        async () => {
          await (
            await org(ctx, args)
          ).vault.revoke({
            vaultId: args.vaultId,
            revocations: args.revocations.map(
              (r: { role: string; kind: string; value: string }) => ({
                role: r.role as never,
                principal: { kind: r.kind as never, value: r.value },
              }),
            ),
            editorDaoId: args.editorDaoId,
          })
          return { status: 'executed' }
        },
      ),
  },
  {
    name: 'prepare_org_vault_deinit',
    title: 'Prepare: retire shared storage',
    description:
      'Retire an EMPTY vault and free its registry slot. Aborts on-chain if the vault still holds anything.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.vault.deinit',
    inputShape: {
      ...actingShape,
      vaultId: objectId,
      editorDaoId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_deinit',
        { vaultId: args.vaultId },
        async () => {
          await (
            await org(ctx, args)
          ).vault.deinit({
            vaultId: args.vaultId,
            editorDaoId: args.editorDaoId,
          })
          return { status: 'executed' }
        },
      ),
  },
]

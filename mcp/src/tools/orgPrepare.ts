import { z } from 'zod'
import type { RequestContext } from '../context.js'
import {
  big,
  bigOpt,
  coinType,
  objectId,
  orderSide,
  suiAddress,
  u128,
  u64,
} from '../schemas.js'
import {
  ACTING_SYNTHETIC,
  FLAT_CONFIG_SYNTHETIC,
  PREPARE_SUFFIX,
  actingShape,
  assembleConfig,
  flatConfigShape,
  openOrg as org,
  preparedGovernance,
  proposalConfig,
  runOptions,
  runOptionsShape,
  vaultPrincipal,
} from './orgCommon.js'
import type { ToolDef } from './types.js'

/**
 * Armature governance writes, prepared unsigned: membership, proposal-type
 * administration, voting and execution, treasury, trading as the organization,
 * and shared storage. The cycle-7 groups (currency, sub-unit lifecycle, freeze,
 * encrypted entries, upgrades, capabilities, creation) live in
 * `orgLifecycle.ts`.
 *
 * Check `intent.outcome` before assuming a transaction did what you asked. A
 * `proposed` result means the board still has to vote.
 */

const orderFlagsShape = {
  orderType: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('TriexBook order type; 0 (the default) = no restriction.'),
  selfMatchingOption: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Self-matching option; 0 (the default) = allow.'),
}

type ItemsArg = { assetId: string; amount: string }[]
const itemsOf = (items: ItemsArg) =>
  items.map((i) => ({ assetId: big(i.assetId), amount: big(i.amount) }))

type PrincipalArg = { kind: string; value: string }
type RoleArg = { role: string; kind: string; value: string }
const principalsOf = (ps?: PrincipalArg[]) =>
  ps?.map((p) => ({ kind: p.kind as never, value: p.value }))
const rolePairsOf = (rs: RoleArg[]) =>
  rs.map((r) => ({
    role: r.role as never,
    principal: { kind: r.kind as never, value: r.value },
  }))

const roleGrant = z.object({
  role: z.enum(['deposit', 'withdraw', 'edit']),
  ...vaultPrincipal.shape,
})

const addressList = z.array(suiAddress)

/**
 * The item stacks `orders.sweepAll` will skip, computed the way it computes
 * them. The SDK returns `skipped` beside its `RunOutcome`, but under the
 * capture executor the call never returns, so the list is rebuilt here from
 * the same manifest and the same vault lookup before the build runs.
 */
async function predictSweepSkips(ctx: RequestContext, h: any) {
  const seatId: string | undefined = h.seat?.daoId?.toLowerCase()
  const nodes: any[] = h.nodes ?? []
  const seated = new Set(
    (h.seats ?? []).map((s: any) => String(s.daoId).toLowerCase()),
  )
  const account =
    nodes.find((n) => n.tradingAccountId && n.daoId.toLowerCase() === seatId) ??
    nodes.find(
      (n) => n.tradingAccountId && seated.has(n.daoId.toLowerCase()),
    ) ??
    nodes.find((n) => n.tradingAccountId)
  if (!account) return []
  const manifest = await ctx.readClient().sweepable(account.tradingAccountId)
  const skipped: {
    storageUnitId: string
    assetId: string
    amount: unknown
    reason: 'no-vault' | 'unlinked'
  }[] = []
  for (const item of manifest.items) {
    const base = {
      storageUnitId: item.storageUnitId,
      assetId: String(item.assetId),
      amount: item.amount,
    }
    if (!item.storageUnitId) {
      skipped.push({ ...base, reason: 'unlinked' })
    } else if (
      !(await h.vault.resolve({ storageUnitId: item.storageUnitId }))
    ) {
      skipped.push({ ...base, reason: 'no-vault' })
    }
  }
  return skipped
}

export const orgPrepareTools: ToolDef[] = [
  // ─── membership ────────────────────────────────────────────────────────────
  {
    name: 'prepare_org_add_members',
    title: 'Prepare: seat members on a unit',
    description:
      'Add addresses to a unit’s board (default: the acting seat; unitId targets another unit). Routes through the unit’s own BatchAddMembers or its parent’s ControllerBatchAddMembers, whichever the caller can carry fastest.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.members.add',
    inputShape: {
      ...actingShape,
      addresses: z.array(suiAddress).min(1),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_add_members',
        { orgId: args.orgId, addresses: args.addresses },
        async () =>
          (await org(ctx, args)).members.add(args.addresses, runOptions(args)),
      ),
  },
  {
    name: 'prepare_org_remove_members',
    title: 'Prepare: remove members from a unit',
    description:
      'Remove addresses from a unit’s board. Every unit, the root included, has its own BatchRemoveMembers since cycle 7; a parent can also act through ControllerBatchRemoveMembers. Removing a member rotates the unit’s encryption epoch, marking its encrypted entries stale.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.members.remove',
    inputShape: {
      ...actingShape,
      addresses: z.array(suiAddress).min(1),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_remove_members',
        { orgId: args.orgId, addresses: args.addresses },
        async () =>
          (await org(ctx, args)).members.remove(
            args.addresses,
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_set_board',
    title: 'Prepare: apply a board diff',
    description:
      'Apply one board DIFF (SetBoard { to_add, to_remove }) in a single action. A board cannot be replaced wholesale since cycle 7 — the roster is an unenumerable table — so name who joins and who leaves. Give at least one of add / remove.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.members.setBoard',
    inputShape: {
      ...actingShape,
      add: addressList.optional().describe('Addresses to seat.'),
      remove: addressList.optional().describe('Addresses to unseat.'),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_set_board',
        { orgId: args.orgId, add: args.add ?? [], remove: args.remove ?? [] },
        async () =>
          (await org(ctx, args)).members.setBoard(
            { add: args.add, remove: args.remove },
            runOptions(args),
          ),
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
      ...runOptionsShape,
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
            ...runOptions(args),
          }),
      ),
  },

  // ─── proposal-type administration ──────────────────────────────────────────
  {
    name: 'prepare_org_enable_type',
    title: 'Prepare: enable a proposal type',
    description:
      'Enable an arbitrary proposal type on a unit with the given voting rules. Quorum and approval are basis points (10000 = 100%); a lone vote can pass a type only when boardSize × quorum ≤ 10000 and executionDelayMs is 0. permissions grants the armature::permissions bits its handler needs — any high-impact bit needs approvalThreshold ≥ 8000.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.enable',
    inputShape: {
      ...actingShape,
      typeKey: z
        .string()
        .min(1)
        .describe('Display key for the slot, e.g. "SetBoard".'),
      moveType: z
        .string()
        .min(1)
        .describe('Fully-qualified Move payload type.'),
      ...flatConfigShape,
      composableAllowed: z.boolean().optional(),
      ...runOptionsShape,
    },
    syntheticParams: { ...ACTING_SYNTHETIC, ...FLAT_CONFIG_SYNTHETIC },
    derivedParams: {
      config:
        'Assembled from the flat quorum / threshold / timing / permission inputs.',
    },
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_type',
        { orgId: args.orgId, typeKey: args.typeKey },
        async () =>
          (await org(ctx, args)).types.enable(
            {
              typeKey: args.typeKey,
              moveType: args.moveType,
              config: assembleConfig(args),
              composableAllowed: args.composableAllowed,
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_disable_type',
    title: 'Prepare: disable a proposal type',
    description:
      'Disable a proposal type by display key. The governance meta-types (enable / disable / update config) cannot be disabled.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.disable',
    inputShape: {
      ...actingShape,
      typeKey: z.string().min(1),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_disable_type',
        { orgId: args.orgId, typeKey: args.typeKey },
        async () =>
          (await org(ctx, args)).types.disable(args.typeKey, runOptions(args)),
      ),
  },
  {
    name: 'prepare_org_update_type_config',
    title: 'Prepare: change a proposal type’s rules',
    description:
      'Change the voting rules of an already-enabled type. Every field is optional and anything omitted keeps its current value. permissions / borrowScope REPLACE the current set and count as a grant — only a standalone proposal may make one, and framework types’ bits are fixed.' +
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
      permissions: z.number().int().min(0).optional(),
      borrowScope: z.array(z.string()).optional(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_update_type_config',
        { orgId: args.orgId, typeKey: args.typeKey },
        async () =>
          (await org(ctx, args)).types.updateConfig(
            args.typeKey,
            {
              quorum: args.quorum,
              approvalThreshold: args.approvalThreshold,
              proposeThreshold: args.proposeThreshold,
              expiryMs: args.expiryMs,
              executionDelayMs: args.executionDelayMs,
              cooldownMs: args.cooldownMs,
              composableAllowed: args.composableAllowed,
              permissions: args.permissions,
              borrowScope: args.borrowScope,
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_enable_composite',
    title: 'Prepare: re-enable composite proposals',
    description:
      'Enable the Composite type. It is a DEFAULT slot on every cycle-7 unit, so this is only for a unit that disabled it — it is refused when Composite is already enabled (use prepare_org_update_type_config to change its rules).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.enableComposite',
    inputShape: { ...actingShape, ...runOptionsShape },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_composite',
        { orgId: args.orgId },
        async () =>
          (await org(ctx, args)).types.enableComposite(runOptions(args)),
      ),
  },
  {
    name: 'prepare_org_enable_send_coin',
    title: 'Prepare: enable treasury withdrawals of a coin',
    description:
      'Register SendCoin<T> so the unit can pay that coin out of its treasury to a wallet (80% approval, TREASURY_WITHDRAW). Per-coin: each coin is its own slot.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.enableSendCoin',
    inputShape: {
      ...actingShape,
      coinType: z.string().optional().describe('Defaults to CRED.'),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_send_coin',
        { orgId: args.orgId, coinType: args.coinType ?? 'CRED' },
        async () =>
          (await org(ctx, args)).types.enableSendCoin(
            args.coinType,
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_enable_send_coin_to_org',
    title: 'Prepare: enable treasury-to-treasury sends of a coin',
    description:
      'Register SendCoinToOU<T> so the unit can pay that coin into ANOTHER organization’s treasury — the prerequisite for prepare_org_treasury_send_to_org.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.enableSendCoinToOrg',
    inputShape: {
      ...actingShape,
      coinType: z.string().optional().describe('Defaults to CRED.'),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_send_coin_to_org',
        { orgId: args.orgId, coinType: args.coinType ?? 'CRED' },
        async () =>
          (await org(ctx, args)).types.enableSendCoinToOrg(
            args.coinType,
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_enable_send_small_payment',
    title: 'Prepare: enable rate-limited small payments',
    description:
      'Register SendSmallPayment<T>: single-vote payouts capped on-chain at 1% of the treasury’s balance per 24h epoch — the cap is what makes one officer’s signature acceptable. Default config is quorum 1 / 80% approval with TREASURY_WITHDRAW; pass config to override.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.enableSendSmallPayment',
    inputShape: {
      ...actingShape,
      coinType: z.string().optional().describe('Defaults to CRED.'),
      config: proposalConfig.optional(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_send_small_payment',
        { orgId: args.orgId, coinType: args.coinType ?? 'CRED' },
        async () =>
          (await org(ctx, args)).types.enableSendSmallPayment(
            { coinType: args.coinType, config: args.config },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_enable_trading',
    title: 'Prepare: enable organization trading',
    description:
      'Enable every armature_trading proposal type the unit is missing, in one transaction — the prerequisite for the prepare_org_*order* tools on item markets. Coin-pool pairs are per-pair slots since cycle 7: enable each with prepare_org_enable_coin_pair. Refused when everything is already enabled (organizations created normally already are).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.types.enableTrading',
    inputShape: {
      ...actingShape,
      quoteType: z.string().optional().describe('Defaults to CRED.'),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_trading',
        { orgId: args.orgId, quoteType: args.quoteType ?? 'CRED' },
        async () =>
          (await org(ctx, args)).types.enableTrading(
            { quoteType: args.quoteType },
            runOptions(args),
          ),
      ),
  },

  // ─── voting and execution ──────────────────────────────────────────────────
  {
    name: 'prepare_org_vote',
    title: 'Prepare: vote on a proposal',
    description:
      'Cast a vote on an open proposal. The voter must have been on the board when the proposal was CREATED; voting closes at created + expiry. payloadType and unitId are read from the live proposal when omitted — pass both to skip the read.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.governance.vote',
    inputShape: {
      ...actingShape,
      proposalId: objectId,
      approve: z.boolean(),
      payloadType: z.string().optional(),
      unitId: objectId.optional().describe('The unit the proposal belongs to.'),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vote',
        { proposalId: args.proposalId, approve: args.approve },
        async () =>
          (await org(ctx, args)).governance.vote({
            proposalId: args.proposalId,
            approve: args.approve,
            payloadType: args.payloadType,
            unitId: args.unitId,
          }),
      ),
  },
  {
    name: 'prepare_org_execute_proposal',
    title: 'Prepare: execute a passed proposal',
    description:
      'Execute a proposal the board already passed, dispatching on its payload type to the handler a single-vote run would have used; the proposal is deleted in the same call. A composite runs its whole frame pipeline in one transaction and is refused if any step has no wired executor. Some handlers need an object only the caller can supply: freezeAdminCapId for TransferFreezeAdmin, treasuryCapId for AdoptCurrency, upgrade (the compiled package) for ProposeUpgrade.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.governance.execute',
    inputShape: {
      ...actingShape,
      proposalId: objectId,
      freezeAdminCapId: objectId
        .optional()
        .describe('TransferFreezeAdmin: the unit’s FreezeAdminCap you own.'),
      treasuryCapId: objectId
        .optional()
        .describe('AdoptCurrency<T>: the TreasuryCap<T> you own.'),
      upgrade: z
        .object({
          modules: z
            .array(z.string())
            .min(1)
            .describe('Base64 module bytecode.'),
          dependencies: z.array(objectId),
        })
        .optional()
        .describe(
          'ProposeUpgrade: the compiled package, as `sui move build --dump-bytecode-as-base64` prints it.',
        ),
      deleteFrame: z
        .boolean()
        .optional()
        .describe(
          'Composites: also delete the exhausted frame (storage rebate to the gas payer).',
        ),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_execute_proposal',
        { proposalId: args.proposalId },
        async () =>
          (await org(ctx, args)).governance.execute(args.proposalId, {
            freezeAdminCapId: args.freezeAdminCapId,
            treasuryCapId: args.treasuryCapId,
            upgrade: args.upgrade,
            deleteFrame: args.deleteFrame,
          }),
      ),
  },
  {
    name: 'prepare_org_delete_expired_proposals',
    title: 'Prepare: delete proposals that can no longer execute',
    description:
      'Delete proposals past their window — an Active one past its voting deadline, or a Passed one whose execution window closed (proposal::delete_expired_proposal). PERMISSIONLESS; the storage rebate goes to the gas payer. Several ids clean up in one transaction, but any one not yet expired aborts the whole batch — list candidates with org_expired_proposals first. The indexer reports a lapsed proposal as "pending" until someone does this.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.governance.deleteExpired',
    inputShape: {
      ...actingShape,
      proposalIds: z.array(objectId).min(1),
      payloadTypes: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Payload Move type by proposal id; read from the live objects when omitted.',
        ),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_delete_expired_proposals',
        { proposalIds: args.proposalIds },
        async () =>
          (await org(ctx, args)).governance.deleteExpired({
            proposalIds: args.proposalIds,
            payloadTypes: args.payloadTypes,
          }),
      ),
  },
  {
    name: 'prepare_org_delete_exhausted_frame',
    title: 'Prepare: delete a finished composite frame',
    description:
      'Delete a composite’s frame once every step has run (composite::delete_exhausted_frame). Permissionless; rebate to the gas payer. prepare_org_execute_proposal with deleteFrame does the same in the executing transaction.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.governance.deleteExhaustedFrame',
    inputShape: { ...actingShape, frameId: objectId },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_delete_exhausted_frame',
        { frameId: args.frameId },
        async () =>
          (await org(ctx, args)).governance.deleteExhaustedFrame(args.frameId),
      ),
  },

  // ─── treasury ──────────────────────────────────────────────────────────────
  {
    name: 'prepare_org_treasury_deposit',
    title: 'Prepare: fund an organization treasury',
    description:
      'Deposit a coin from the wallet into an organization’s treasury. PERMISSIONLESS — no board seat and no vote; anyone can fund an organization.' +
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
        async () =>
          (await org(ctx, args)).treasury.deposit({
            amount: big(args.amount),
            coinType: args.coinType,
            treasuryVaultId: args.treasuryVaultId,
          }),
      ),
  },
  {
    name: 'prepare_org_treasury_claim',
    title: 'Prepare: claim coins sent to a treasury’s address',
    description:
      'Pull coin objects that were transferred to the treasury’s ADDRESS into its balance (treasury_vault::claim_coin). Coins sent that way sit outside the balance until claimed. PERMISSIONLESS, like a deposit.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.treasury.claim',
    inputShape: {
      ...actingShape,
      coinObjectIds: z.array(objectId).min(1),
      coinType: z.string().optional().describe('Defaults to CRED.'),
      treasuryVaultId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_treasury_claim',
        { orgId: args.orgId, coinObjectIds: args.coinObjectIds },
        async () =>
          (await org(ctx, args)).treasury.claim({
            coinObjectIds: args.coinObjectIds,
            coinType: args.coinType,
            treasuryVaultId: args.treasuryVaultId,
          }),
      ),
  },
  {
    name: 'prepare_org_treasury_send',
    title: 'Prepare: pay out of an organization treasury',
    description:
      'Pay a coin from the unit’s treasury to a wallet address. Governance-sensitive (80% approval, TREASURY_WITHDRAW): on a real board this resolves to a PROPOSAL rather than an immediate payment — check intent.outcome. Requires the coin’s SendCoin type (prepare_org_enable_send_coin).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.treasury.send',
    inputShape: {
      ...actingShape,
      recipient: suiAddress,
      amount: u64,
      coinType: z.string().optional(),
      treasuryVaultId: objectId.optional(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_treasury_send',
        { recipient: args.recipient, amount: args.amount },
        async () =>
          (await org(ctx, args)).treasury.send(
            {
              recipient: args.recipient,
              amount: big(args.amount),
              coinType: args.coinType,
              treasuryVaultId: args.treasuryVaultId,
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_treasury_send_small',
    title: 'Prepare: a rate-limited small payment',
    description:
      'Pay a small amount from the treasury to a wallet through SendSmallPayment<T>: at most 1% of the treasury’s balance per 24h epoch, tracked on-chain, which is why a single officer’s vote can carry it. An amount over the remaining allowance aborts on-chain. Requires prepare_org_enable_send_small_payment first.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.treasury.sendSmall',
    inputShape: {
      ...actingShape,
      recipient: suiAddress,
      amount: u64,
      coinType: z.string().optional(),
      treasuryVaultId: objectId.optional(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_treasury_send_small',
        { recipient: args.recipient, amount: args.amount },
        async () =>
          (await org(ctx, args)).treasury.sendSmall(
            {
              recipient: args.recipient,
              amount: big(args.amount),
              coinType: args.coinType,
              treasuryVaultId: args.treasuryVaultId,
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_treasury_send_to_org',
    title: 'Prepare: pay another organization',
    description:
      'Move funds from this unit’s treasury into ANOTHER organization’s treasury. recipientTreasuryId is that organization’s TreasuryVault object id — not its org id and not a wallet; passing either aborts on-chain. Requires SendCoinToOU<T> (prepare_org_enable_send_coin_to_org).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.treasury.sendToOrg',
    inputShape: {
      ...actingShape,
      recipientTreasuryId: objectId,
      amount: u64,
      coinType: z.string().optional(),
      treasuryVaultId: objectId.optional(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_treasury_send_to_org',
        { recipientTreasuryId: args.recipientTreasuryId, amount: args.amount },
        async () =>
          (await org(ctx, args)).treasury.sendToOrg(
            {
              recipientTreasuryId: args.recipientTreasuryId,
              amount: big(args.amount),
              coinType: args.coinType,
              treasuryVaultId: args.treasuryVaultId,
            },
            runOptions(args),
          ),
      ),
  },

  // ─── trading as the organization ───────────────────────────────────────────
  {
    name: 'prepare_org_setup_trading',
    title: 'Prepare: give an organization a trading account',
    description:
      'Create the organization’s shared TradingAccount, owned by a TradingCustody on the ACTING unit — only that unit’s board can trade through it afterwards. Refused when one already exists — check org_trading_account first.' +
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
      'Place a limit order on an item market using funds ALREADY in the organization’s trading account. To fund it from the treasury or from shared storage in the same transaction, use prepare_org_buy_from_treasury or prepare_org_sell_from_vault instead. Trading actions never degrade into proposals — if a single vote cannot pass it, the result is prepared:false.' +
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
      ...orderFlagsShape,
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
            orderType: args.orderType,
            selfMatchingOption: args.selfMatchingOption,
          }),
      ),
  },
  {
    name: 'prepare_org_market_order',
    title: 'Prepare: place an organization market order',
    description:
      'Place an immediate-or-cancel market order on an item market, using funds already in the trading account. Whatever does not fill at once is cancelled, never left resting.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.market',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      assetId: z.string(),
      side: orderSide,
      quantity: u64,
      quoteType: z.string().optional(),
      selfMatchingOption: orderFlagsShape.selfMatchingOption,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_market_order',
        { assetId: args.assetId, side: args.side, quantity: args.quantity },
        async () =>
          (await org(ctx, args)).orders.market({
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            side: args.side,
            quantity: big(args.quantity),
            quoteType: args.quoteType,
            selfMatchingOption: args.selfMatchingOption,
          }),
      ),
  },
  {
    name: 'prepare_org_cancel_order',
    title: 'Prepare: cancel an organization order',
    description:
      'Cancel one of the organization’s resting orders on an item market.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.cancel',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      assetId: z.string(),
      orderId: u128.describe('Order id (u128) as a decimal string.'),
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
      'Move quote coin from the treasury into the trading account and place the bid, ATOMICALLY — if the order aborts the deposit rolls back. depositAmount defaults to the full cost including fees (sized from the pool’s on-chain bid-escrow fee rate, or bidFeeRate when given), NOT to a shortfall: pass the deficit yourself when the trading account already holds some quote. Over-depositing is safe; under-depositing aborts the whole transaction.' +
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
      bidFeeRate: u64
        .optional()
        .describe('1e9-scaled fee rate the default deposit is sized with.'),
      expireAt: u64.optional(),
      quoteType: z.string().optional(),
      treasuryVaultId: objectId.optional(),
      ...orderFlagsShape,
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
            bidFeeRate: bigOpt(args.bidFeeRate),
            expireAt: bigOpt(args.expireAt),
            quoteType: args.quoteType,
            treasuryVaultId: args.treasuryVaultId,
            orderType: args.orderType,
            selfMatchingOption: args.selfMatchingOption,
          }),
      ),
  },
  {
    name: 'prepare_org_sell_from_vault',
    title: 'Prepare: unpark from shared storage and sell',
    description:
      'Take items out of the organization’s shared storage and place the ask, ATOMICALLY. vaultQuantity is how much to pull from the vault, which is not always the order quantity — the trading account may already hold part of the stack. The vault is resolved from the storage unit and this organization unless vaultId is given; the trading unit’s board must satisfy its withdraw role.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.sellFromVault',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      assetId: z.string(),
      price: u64,
      quantity: u64,
      vaultQuantity: u64.optional(),
      vaultId: objectId.optional(),
      registrantOrgId: objectId
        .optional()
        .describe('Pin the unit that registered the vault.'),
      expireAt: u64.optional(),
      quoteType: z.string().optional(),
      ...orderFlagsShape,
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
          (await org(ctx, args)).orders.sellFromVault({
            storageUnitId: args.storageUnitId,
            assetId: args.assetId,
            side: 'sell',
            price: big(args.price),
            quantity: big(args.quantity),
            vaultQuantity: bigOpt(args.vaultQuantity),
            vaultId: args.vaultId,
            registrantOrgId: args.registrantOrgId,
            expireAt: bigOpt(args.expireAt),
            quoteType: args.quoteType,
            orderType: args.orderType,
            selfMatchingOption: args.selfMatchingOption,
          }),
      ),
  },
  {
    name: 'prepare_org_deposit_to_trading',
    title: 'Prepare: move treasury coin into the trading account',
    description:
      'Move a coin from the treasury into the organization’s trading account on its own — e.g. a coin pool’s BASE coin ahead of an ask. Bids on item markets are better served by prepare_org_buy_from_treasury, which funds and places at once. Requires DepositCoinToBook<T> for that coin.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.deposit',
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
        'org_deposit_to_trading',
        { amount: args.amount, coinType: args.coinType ?? 'CRED' },
        async () =>
          (await org(ctx, args)).orders.deposit({
            amount: big(args.amount),
            coinType: args.coinType,
            treasuryVaultId: args.treasuryVaultId,
          }),
      ),
  },
  {
    name: 'prepare_org_enable_coin_pair',
    title: 'Prepare: enable trading of one coin pair',
    description:
      'Register PlaceLimitOrderCoin<Base, Quote> and CancelOrderCoin<Base, Quote> on the acting unit under per-pair keys, so further pairs can be added later. The prerequisite for prepare_org_coin_limit_order / prepare_org_coin_cancel_order on that pair. Refused when the pair is already enabled.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.enableCoinPair',
    inputShape: {
      ...actingShape,
      baseType: coinType,
      quoteType: coinType.optional().describe('Defaults to CRED.'),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_coin_pair',
        { baseType: args.baseType, quoteType: args.quoteType ?? 'CRED' },
        async () =>
          (await org(ctx, args)).orders.enableCoinPair({
            baseType: args.baseType,
            quoteType: args.quoteType,
          }),
      ),
  },
  {
    name: 'prepare_org_coin_limit_order',
    title: 'Prepare: place an organization coin-pool limit order',
    description:
      'Place a limit order on a COIN pool (Pool<Base, Quote>) as the organization. Coin units: amounts are raw base units and price is 1e9-scaled. With depositAmount the order is funded from the treasury in the same transaction — quote for a bid, base for an ask (which then also needs DepositCoinToBook<Base>). Requires the pair enabled (prepare_org_enable_coin_pair).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.limitCoin',
    inputShape: {
      ...actingShape,
      poolId: objectId,
      baseType: coinType,
      quoteType: coinType.optional().describe('Defaults to CRED.'),
      side: orderSide,
      price: u64.describe('1e9-scaled price.'),
      quantity: u64.describe('Raw base units.'),
      expireAt: u64
        .optional()
        .describe('Epoch ms; defaults to good-til-cancelled.'),
      depositAmount: u64.optional(),
      treasuryVaultId: objectId.optional(),
      ...orderFlagsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_coin_limit_order',
        {
          poolId: args.poolId,
          side: args.side,
          price: args.price,
          quantity: args.quantity,
        },
        async () =>
          (await org(ctx, args)).orders.limitCoin({
            poolId: args.poolId,
            baseType: args.baseType,
            quoteType: args.quoteType,
            side: args.side,
            price: big(args.price),
            quantity: big(args.quantity),
            expireAt: bigOpt(args.expireAt),
            depositAmount: bigOpt(args.depositAmount),
            treasuryVaultId: args.treasuryVaultId,
            orderType: args.orderType,
            selfMatchingOption: args.selfMatchingOption,
          }),
      ),
  },
  {
    name: 'prepare_org_coin_cancel_order',
    title: 'Prepare: cancel an organization coin-pool order',
    description:
      'Cancel one of the organization’s resting orders on a coin pool.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.cancelCoin',
    inputShape: {
      ...actingShape,
      poolId: objectId,
      baseType: coinType,
      quoteType: coinType.optional().describe('Defaults to CRED.'),
      orderId: u128.describe('Order id (u128) as a decimal string.'),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_coin_cancel_order',
        { poolId: args.poolId, orderId: args.orderId },
        async () =>
          (await org(ctx, args)).orders.cancelCoin({
            poolId: args.poolId,
            baseType: args.baseType,
            quoteType: args.quoteType,
            orderId: big(args.orderId),
          }),
      ),
  },
  {
    name: 'prepare_org_create_pool',
    title: 'Prepare: open a new item market as the organization',
    description:
      'Open a permissionless MultiCoinPool<Quote> for one asset of a hub’s collection, paying the CRED creation fee from the ACTING unit’s treasury. Give storageUnitId (the collection is looked up) or collectionId. Requires CreateMulticoinPool<Quote> with TREASURY_WITHDRAW. May resolve to a PROPOSAL — a new market does not go stale while a board votes — so check intent.outcome.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.createPool',
    inputShape: {
      ...actingShape,
      assetId: u64.describe('Item asset id as a decimal string.'),
      storageUnitId: objectId.optional(),
      collectionId: objectId.optional(),
      quoteType: z.string().optional().describe('Defaults to CRED.'),
      treasuryVaultId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_create_pool',
        { assetId: args.assetId },
        async () =>
          (await org(ctx, args)).orders.createPool({
            assetId: big(args.assetId),
            storageUnitId: args.storageUnitId,
            collectionId: args.collectionId,
            quoteType: args.quoteType,
            treasuryVaultId: args.treasuryVaultId,
          }),
      ),
  },
  {
    name: 'prepare_org_sweep_coin',
    title: 'Prepare: sweep a coin to the treasury',
    description:
      'Move a coin out of the trading account back into the treasury — quote proceeds, or a coin pool’s base coin (coinType, default CRED). claimFromPool (an item market) / claimFromCoinPool (a coin pool) first claim that pool’s settled balances in the same transaction — a resting maker order that filled leaves its proceeds IN the pool, so sweeping without claiming quietly moves less than expected.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.sweepCoin',
    inputShape: {
      ...actingShape,
      amount: u64,
      coinType: z.string().optional().describe('Defaults to CRED.'),
      treasuryVaultId: objectId.optional(),
      claimFromPool: objectId
        .optional()
        .describe('An item market (MultiCoinPool<coinType>) to claim from.'),
      claimFromCoinPool: z
        .object({
          poolId: objectId,
          baseType: coinType,
          quoteType: coinType.optional(),
        })
        .optional()
        .describe('A coin pool to claim from.'),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_sweep_coin',
        { amount: args.amount, coinType: args.coinType ?? 'CRED' },
        async () =>
          (await org(ctx, args)).orders.sweepCoin({
            amount: big(args.amount),
            coinType: args.coinType,
            treasuryVaultId: args.treasuryVaultId,
            claimFromPool: args.claimFromPool,
            claimFromCoinPool: args.claimFromCoinPool,
          }),
      ),
  },
  {
    name: 'prepare_org_sweep_items',
    title: 'Prepare: park items in shared storage',
    description:
      'Move an item stack out of the trading account into the organization’s shared storage at a hub. The trading unit’s board must satisfy the vault’s deposit role. As with the coin sweep, claimFromPool claims settled balances first so the amount may include them.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.orders.sweepItems',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      assetId: u64,
      amount: u64,
      vaultId: objectId.optional(),
      registrantOrgId: objectId.optional(),
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
            vaultId: args.vaultId,
            registrantOrgId: args.registrantOrgId,
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
    handler: async (ctx, args) => {
      const h = await org(ctx, args)
      const skipped = await predictSweepSkips(ctx, h)
      return preparedGovernance(
        ctx,
        args.sender,
        'org_sweep_all',
        { orgId: args.orgId, skipped },
        () =>
          h.orders.sweepAll({
            quoteType: args.quoteType,
            treasuryVaultId: args.treasuryVaultId,
            includeCurrency: args.includeCurrency,
          }),
      )
    },
  },

  // ─── shared storage ────────────────────────────────────────────────────────
  {
    name: 'prepare_org_vault_init',
    title: 'Prepare: open shared storage for an organization',
    description:
      'Register a receipt vault for the acting unit at a storage unit. Any board member of the acting unit may do this. Deposit and withdraw default to the acting unit; EDIT defaults to its PARENT, because a unit that governs its own access control can quietly widen it. At least one editor is required.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.vault.init',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      vaultConfigId: objectId.optional(),
      depositPrincipals: z
        .array(vaultPrincipal)
        .optional()
        .describe('Defaults to the acting unit.'),
      withdrawPrincipals: z
        .array(vaultPrincipal)
        .optional()
        .describe('Defaults to the acting unit.'),
      editPrincipals: z
        .array(vaultPrincipal)
        .min(1)
        .optional()
        .describe('Defaults to the acting unit’s parent (itself at the root).'),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_init',
        { orgId: args.orgId, storageUnitId: args.storageUnitId },
        async () =>
          (await org(ctx, args)).vault.init({
            storageUnitId: args.storageUnitId,
            vaultConfigId: args.vaultConfigId,
            depositPrincipals: principalsOf(args.depositPrincipals),
            withdrawPrincipals: principalsOf(args.withdrawPrincipals),
            editPrincipals: principalsOf(args.editPrincipals),
          }),
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
      vaultId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_deposit',
        { storageUnitId: args.storageUnitId, items: args.items },
        async () =>
          (await org(ctx, args)).vault.deposit({
            storageUnitId: args.storageUnitId,
            items: itemsOf(args.items),
            registrantOrgId: args.registrantOrgId,
            vaultId: args.vaultId,
          }),
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
      vaultId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_withdraw',
        { storageUnitId: args.storageUnitId, to: args.to ?? 'wallet' },
        async () =>
          (await org(ctx, args)).vault.withdraw({
            storageUnitId: args.storageUnitId,
            items: itemsOf(args.items),
            to: args.to,
            characterId: args.characterId,
            registrantOrgId: args.registrantOrgId,
            vaultId: args.vaultId,
          }),
      ),
  },
  {
    name: 'prepare_org_vault_grant',
    title: 'Prepare: grant shared-storage access',
    description:
      'Grant (role, principal) pairs on a vault. The caller must satisfy the edit role through editorOuId (default: the acting seat). A principal is a wallet ("player"), a bot/service key ("machine"), or an organization unit ("ou"). Granting EDIT to an organization goes through a witnessed path that requires a live OU, so a mistyped org id cannot become an unsatisfiable editor.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.vault.grant',
    inputShape: {
      ...actingShape,
      vaultId: objectId,
      grants: z.array(roleGrant).min(1),
      editorOuId: objectId
        .optional()
        .describe('The unit whose board satisfies edit; defaults to the seat.'),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_grant',
        { vaultId: args.vaultId, grants: args.grants },
        async () =>
          (await org(ctx, args)).vault.grant({
            vaultId: args.vaultId,
            grants: rolePairsOf(args.grants),
            editorOuId: args.editorOuId,
          }),
      ),
  },
  {
    name: 'prepare_org_vault_revoke',
    title: 'Prepare: revoke shared-storage access',
    description:
      'Revoke (role, principal) pairs. Aborts rather than leave edit empty or the caller unable to administer the vault through editorOuId. Pairs not present are skipped — and player(A) and machine(A) are DISTINCT principals for the same address, so name the kind that was granted.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.vault.revoke',
    inputShape: {
      ...actingShape,
      vaultId: objectId,
      revocations: z.array(roleGrant).min(1),
      editorOuId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_revoke',
        { vaultId: args.vaultId, revocations: args.revocations },
        async () =>
          (await org(ctx, args)).vault.revoke({
            vaultId: args.vaultId,
            revocations: rolePairsOf(args.revocations),
            editorOuId: args.editorOuId,
          }),
      ),
  },
  {
    name: 'prepare_org_vault_rekey',
    title: 'Prepare: file shared storage under another unit',
    description:
      'File a vault under a different registrant organization — after migrating to a new unit, so lookups by (storage unit, organization) find it there. The ACL is untouched; grant the new unit access separately. Requires edit through editorOuId (default: the acting seat).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.vault.rekey',
    inputShape: {
      ...actingShape,
      vaultId: objectId,
      newRegistrantOrgId: objectId,
      editorOuId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_rekey',
        {
          vaultId: args.vaultId,
          newRegistrantOrgId: args.newRegistrantOrgId,
        },
        async () =>
          (await org(ctx, args)).vault.rekey({
            vaultId: args.vaultId,
            newRegistrantOrgId: args.newRegistrantOrgId,
            editorOuId: args.editorOuId,
          }),
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
      editorOuId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_vault_deinit',
        { vaultId: args.vaultId },
        async () =>
          (await org(ctx, args)).vault.deinit({
            vaultId: args.vaultId,
            editorOuId: args.editorOuId,
          }),
      ),
  },
]

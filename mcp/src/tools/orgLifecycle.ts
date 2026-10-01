import { z } from 'zod'
import { big, bigOpt, objectId, suiAddress, u64 } from '../schemas.js'
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
} from './orgCommon.js'
import type { ToolDef } from './types.js'

/**
 * The cycle-7 Armature groups, prepared unsigned: the organization's own coin,
 * sub-unit lifecycle and parent→child control, the emergency freeze, encrypted
 * entries, governed upgrades, bypass execution, and creating organizations.
 *
 * The return type of each SDK method is its authorization model, and the tools
 * inherit it: a `RunOutcome` method is resolved per caller and may come back
 * `proposed` (check `intent.outcome`), while a cap-holder, member-gated or
 * permissionless method builds one direct call and always reports `executed`.
 */

const coinTypeIn = z
  .string()
  .min(1)
  .describe('Fully-qualified Move coin type of the organization’s currency.')
const treasuryCapId = objectId.describe(
  'The TreasuryCap<T> object id (held in the unit’s capability vault).',
)
const moveTypeIn = z
  .string()
  .min(1)
  .describe(
    'Fully-qualified payload Move type, e.g. "0x…::send_coin::SendCoin<0x…::cred::CRED>".',
  )
const unitTarget = objectId.describe(
  'The CHILD unit to act on; its parent’s board decides.',
)

const typeInit = z.object({
  moveType: z.string().min(1),
  displayKey: z.string().min(1),
  config: proposalConfig,
})

export const orgLifecycleTools: ToolDef[] = [
  // ─── creating organizations ────────────────────────────────────────────────
  {
    name: 'prepare_org_create',
    title: 'Prepare: create an organization',
    description:
      'Create a three-tier organization in one transaction (tribe_setup::create_tribe_configured): a root unit plus officers and members units, controls wired and the controller types enabled. The sender sits on all three boards and receives the root’s FreezeAdminCap; the sub-units’ caps go to freezeAdmin (default: the sender). The trading types are enabled on the officers unit unless enableTrading is false. Metadata URIs must already be uploaded. The new unit ids are created objects in the effects once submitted.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'orgs.create',
    inputShape: {
      sender: actingShape.sender,
      name: z.string().min(1),
      metadataUri: z.string().min(1),
      board: z
        .array(suiAddress)
        .optional()
        .describe('Root board; defaults to [sender].'),
      officers: z
        .array(suiAddress)
        .optional()
        .describe('Officers (the sender is always added).'),
      members: z
        .array(suiAddress)
        .optional()
        .describe('Line members (the sender is always added).'),
      officerName: z.string().optional(),
      memberName: z.string().optional(),
      officerMetadataUri: z.string().optional(),
      memberMetadataUri: z.string().optional(),
      freezeAdmin: suiAddress.optional(),
      enableTrading: z.boolean().optional().describe('Default true.'),
      quoteType: z
        .string()
        .optional()
        .describe('Quote coin the trading types are instantiated at; CRED.'),
      overrides: z
        .object({
          org: z.array(typeInit).optional(),
          officers: z.array(typeInit).optional(),
          members: z.array(typeInit).optional(),
        })
        .optional()
        .describe('Extra ou::ProposalTypeInit entries per tier.'),
    },
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_create',
        { name: args.name },
        () =>
          ctx.writeClient(args.sender).orgs.create({
            name: args.name,
            metadataUri: args.metadataUri,
            board: args.board,
            officers: args.officers,
            members: args.members,
            officerName: args.officerName,
            memberName: args.memberName,
            officerMetadataUri: args.officerMetadataUri,
            memberMetadataUri: args.memberMetadataUri,
            freezeAdmin: args.freezeAdmin,
            enableTrading: args.enableTrading,
            quoteType: args.quoteType,
            overrides: args.overrides,
          }),
      ),
  },
  {
    name: 'prepare_org_create_standalone',
    title: 'Prepare: create a standalone unit',
    description:
      'Create a single standalone OU (ou::create) — default slots, no parent, no children. The board defaults to [sender]. Its id is a created object in the effects once submitted.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'orgs.createStandalone',
    inputShape: {
      sender: actingShape.sender,
      name: z.string().min(1),
      metadataUri: z.string().min(1),
      board: z.array(suiAddress).optional(),
    },
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_create_standalone',
        { name: args.name },
        () =>
          ctx.writeClient(args.sender).orgs.createStandalone({
            name: args.name,
            metadataUri: args.metadataUri,
            board: args.board,
          }),
      ),
  },

  // ─── currency ──────────────────────────────────────────────────────────────
  {
    name: 'prepare_org_currency_enable',
    title: 'Prepare: enable the currency types for a coin',
    description:
      'Enable AdoptCurrency, MintCoin, BurnCoin, ReturnCurrencyCap and ConfigureMintAllowance for one coin, each with the bits and TreasuryCap<T> scope its handler needs, in one transaction. config is the base (default 50% quorum); bit-holding types are lifted to 80% approval automatically. Refused when every type is already enabled.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.currency.enable',
    inputShape: {
      ...actingShape,
      coinType: coinTypeIn,
      config: proposalConfig.optional(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_currency_enable',
        { coinType: args.coinType },
        async () =>
          (await org(ctx, args)).currency.enable(
            { coinType: args.coinType, config: args.config },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_currency_adopt',
    title: 'Prepare: hand a coin’s TreasuryCap to the organization',
    description:
      'Move a TreasuryCap<T> the EXECUTOR owns into the unit’s capability vault (AdoptCurrency<T>). On a slow path the proposal is executed later with prepare_org_execute_proposal + treasuryCapId, by whoever holds the cap.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.currency.adopt',
    inputShape: {
      ...actingShape,
      coinType: coinTypeIn,
      treasuryCapId: objectId.describe('The TreasuryCap<T> you own.'),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_currency_adopt',
        { coinType: args.coinType, treasuryCapId: args.treasuryCapId },
        async () =>
          (await org(ctx, args)).currency.adopt(
            { coinType: args.coinType, treasuryCapId: args.treasuryCapId },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_currency_mint',
    title: 'Prepare: mint the organization’s coin by vote',
    description:
      'Mint into the unit’s treasury, or to recipient, through MintCoin<T> (VAULT_BORROW on TreasuryCap<T>). Typically a proposal — check intent.outcome.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.currency.mint',
    inputShape: {
      ...actingShape,
      coinType: coinTypeIn,
      treasuryCapId,
      amount: u64,
      recipient: suiAddress
        .optional()
        .describe('Mint to this address instead of the treasury.'),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_currency_mint',
        { coinType: args.coinType, amount: args.amount },
        async () =>
          (await org(ctx, args)).currency.mint(
            {
              coinType: args.coinType,
              treasuryCapId: args.treasuryCapId,
              amount: big(args.amount),
              recipient: args.recipient,
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_currency_mint_allowance',
    title: 'Prepare: mint through MintAllowance by vote',
    description:
      'MintAllowance<T> by vote — the same mechanics as prepare_org_currency_mint under the allowance type. For minting WITHOUT a vote as an allowlisted minter, use prepare_org_currency_mint_with_allowance.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.currency.mintAllowance',
    inputShape: {
      ...actingShape,
      coinType: coinTypeIn,
      treasuryCapId,
      amount: u64,
      recipient: suiAddress.optional(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_currency_mint_allowance',
        { coinType: args.coinType, amount: args.amount },
        async () =>
          (await org(ctx, args)).currency.mintAllowance(
            {
              coinType: args.coinType,
              treasuryCapId: args.treasuryCapId,
              amount: big(args.amount),
              recipient: args.recipient,
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_currency_configure_allowance',
    title: 'Prepare: configure the mint allowance',
    description:
      'Set who may mint through the MintAllowance<T> bypass and how much per call (ConfigureMintAllowance<T>, by vote).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.currency.configureAllowance',
    inputShape: {
      ...actingShape,
      coinType: coinTypeIn,
      addMinters: z.array(suiAddress).optional(),
      removeMinters: z.array(suiAddress).optional(),
      maxPerCall: u64.optional().describe('Upper bound on one bypass mint.'),
      enabled: z.boolean().optional(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_currency_configure_allowance',
        { coinType: args.coinType },
        async () =>
          (await org(ctx, args)).currency.configureAllowance(
            {
              coinType: args.coinType,
              addMinters: args.addMinters,
              removeMinters: args.removeMinters,
              maxPerCall: bigOpt(args.maxPerCall),
              enabled: args.enabled,
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_currency_mint_with_allowance',
    title: 'Prepare: mint as an allowlisted minter (no vote)',
    description:
      'Mint WITHOUT a vote through the MintAllowance<T> bypass (currency_ops::mint_allowance_bypass). Not governance: the SENDER must be an allowlisted minter and amount ≤ max_per_call, or it aborts on-chain. bypassCapId defaults to the vault’s ExternalExecutionCap<MintAllowance<T>> — enable bypass first (prepare_org_enable_bypass).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.currency.mintWithAllowance',
    inputShape: {
      ...actingShape,
      coinType: coinTypeIn,
      treasuryCapId,
      amount: u64,
      recipient: suiAddress.optional(),
      bypassCapId: objectId.optional(),
      unitId: objectId
        .optional()
        .describe('The unit that holds the TreasuryCap; default the seat.'),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_currency_mint_with_allowance',
        { coinType: args.coinType, amount: args.amount },
        async () =>
          (await org(ctx, args)).currency.mintWithAllowance({
            coinType: args.coinType,
            treasuryCapId: args.treasuryCapId,
            amount: big(args.amount),
            recipient: args.recipient,
            bypassCapId: args.bypassCapId,
            unitId: args.unitId,
          }),
      ),
  },
  {
    name: 'prepare_org_currency_burn',
    title: 'Prepare: burn the organization’s coin',
    description:
      'Withdraw an amount from the treasury and burn it (BurnCoin<T>: TREASURY_WITHDRAW + VAULT_BORROW).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.currency.burn',
    inputShape: {
      ...actingShape,
      coinType: coinTypeIn,
      treasuryCapId,
      amount: u64,
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_currency_burn',
        { coinType: args.coinType, amount: args.amount },
        async () =>
          (await org(ctx, args)).currency.burn(
            {
              coinType: args.coinType,
              treasuryCapId: args.treasuryCapId,
              amount: big(args.amount),
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_currency_return_cap',
    title: 'Prepare: give a coin’s TreasuryCap back',
    description:
      'Extract the TreasuryCap<T> from the unit’s vault and transfer it to recipient (ReturnCurrencyCap<T>, VAULT_EXTRACT). The organization loses control of the coin’s supply.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.currency.returnCap',
    inputShape: {
      ...actingShape,
      coinType: coinTypeIn,
      treasuryCapId,
      recipient: suiAddress,
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_currency_return_cap',
        { coinType: args.coinType, recipient: args.recipient },
        async () =>
          (await org(ctx, args)).currency.returnCap(
            {
              coinType: args.coinType,
              treasuryCapId: args.treasuryCapId,
              recipient: args.recipient,
            },
            runOptions(args),
          ),
      ),
  },

  // ─── sub-units: lifecycle & control ────────────────────────────────────────
  {
    name: 'prepare_org_unit_create',
    title: 'Prepare: create a child unit',
    description:
      'Create a child unit under the acting unit (or unitId) via CreateSubOU, wired to its parent’s control. Not a default slot: enable it at ≥80% approval first; blocked on controlled sub-units.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.units.create',
    inputShape: {
      ...actingShape,
      name: z.string().min(1),
      board: z.array(suiAddress).min(1),
      metadataUri: z.string().min(1),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_unit_create',
        { name: args.name, board: args.board },
        async () =>
          (await org(ctx, args)).units.create(
            {
              name: args.name,
              board: args.board,
              metadataUri: args.metadataUri,
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_unit_pause',
    title: 'Prepare: pause a child unit',
    description:
      'Pause a child unit’s own executions (PauseSubOUExecution through the parent’s SubOUControl — the parent’s board decides). Refused on the root.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.units.pause',
    inputShape: {
      ...actingShape,
      unitId: unitTarget,
      metadataIpfs: runOptionsShape.metadataIpfs,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_unit_pause',
        { unitId: args.unitId },
        async () =>
          (await org(ctx, args)).units.pause(
            { unitId: args.unitId },
            { metadataIpfs: args.metadataIpfs },
          ),
      ),
  },
  {
    name: 'prepare_org_unit_unpause',
    title: 'Prepare: resume a paused child unit',
    description:
      'Lift a parent’s pause on a child unit (UnpauseSubOUExecution).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.units.unpause',
    inputShape: {
      ...actingShape,
      unitId: unitTarget,
      metadataIpfs: runOptionsShape.metadataIpfs,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_unit_unpause',
        { unitId: args.unitId },
        async () =>
          (await org(ctx, args)).units.unpause(
            { unitId: args.unitId },
            { metadataIpfs: args.metadataIpfs },
          ),
      ),
  },
  {
    name: 'prepare_org_unit_transfer_cap',
    title: 'Prepare: move a capability down to a child unit',
    description:
      'Move a capability from the parent’s vault into a child’s (TransferCapToSubOU, VAULT_EXTRACT). capType is read from the parent’s vault when omitted.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.units.transferCap',
    inputShape: {
      ...actingShape,
      unitId: unitTarget,
      capId: objectId,
      capType: z.string().optional(),
      metadataIpfs: runOptionsShape.metadataIpfs,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_unit_transfer_cap',
        { unitId: args.unitId, capId: args.capId },
        async () =>
          (await org(ctx, args)).units.transferCap(
            { unitId: args.unitId, capId: args.capId, capType: args.capType },
            { metadataIpfs: args.metadataIpfs },
          ),
      ),
  },
  {
    name: 'prepare_org_unit_reclaim_cap',
    title: 'Prepare: pull a capability back from a child unit',
    description:
      'Pull a capability out of a child’s vault back into the parent’s (ReclaimCapFromSubOU). capType is read from the child’s vault when omitted.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.units.reclaimCap',
    inputShape: {
      ...actingShape,
      unitId: unitTarget,
      capId: objectId,
      capType: z.string().optional(),
      metadataIpfs: runOptionsShape.metadataIpfs,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_unit_reclaim_cap',
        { unitId: args.unitId, capId: args.capId },
        async () =>
          (await org(ctx, args)).units.reclaimCap(
            { unitId: args.unitId, capId: args.capId, capType: args.capType },
            { metadataIpfs: args.metadataIpfs },
          ),
      ),
  },
  {
    name: 'prepare_org_unit_spin_out',
    title: 'Prepare: release a child unit (IRREVERSIBLE)',
    description:
      'Release a child from its parent (SpinOutSubOU) — IRREVERSIBLE: the parent loses all control. The parent’s vault must hold the child’s FreezeAdminCap (true for units made by prepare_org_unit_create, not for tribe units); it is looked up when exactly one is held, otherwise pass freezeAdminCapId. configs sets the freed unit’s hierarchy-type rules.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.units.spinOut',
    inputShape: {
      ...actingShape,
      unitId: unitTarget,
      freezeAdminCapId: objectId.optional(),
      configs: z
        .object({
          spawnOu: proposalConfig.optional(),
          spinOutSubOu: proposalConfig.optional(),
          createSubOu: proposalConfig.optional(),
        })
        .optional(),
      metadataIpfs: runOptionsShape.metadataIpfs,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_unit_spin_out',
        { unitId: args.unitId },
        async () =>
          (await org(ctx, args)).units.spinOut(
            {
              unitId: args.unitId,
              freezeAdminCapId: args.freezeAdminCapId,
              configs: args.configs,
            },
            { metadataIpfs: args.metadataIpfs },
          ),
      ),
  },
  {
    name: 'prepare_org_spawn_successor',
    title: 'Prepare: spawn a successor unit (IRREVERSIBLE)',
    description:
      'Spawn a successor OU and put the acting unit (or unitId) into Migrating (SpawnOU) — IRREVERSIBLE: afterwards only prepare_org_transfer_assets runs on it, and once empty anyone can delete it (prepare_org_unit_destroy).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.units.spawnSuccessor',
    inputShape: {
      ...actingShape,
      name: z.string().min(1),
      board: z.array(suiAddress).min(1),
      metadataUri: z.string().min(1),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_spawn_successor',
        { name: args.name, board: args.board },
        async () =>
          (await org(ctx, args)).units.spawnSuccessor(
            {
              name: args.name,
              board: args.board,
              metadataUri: args.metadataUri,
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_transfer_assets',
    title: 'Prepare: move a unit’s assets to another unit',
    description:
      'Move full coin balances and capabilities to another OU (TransferAssets). Defaults to EVERYTHING the unit holds: every treasury coin and every vault capability. The target’s treasury and vault are read from its OU object.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.units.transferAssets',
    inputShape: {
      ...actingShape,
      targetOuId: objectId,
      coinTypes: z
        .array(z.string())
        .optional()
        .describe('Default: every coin in the treasury.'),
      capIds: z
        .array(objectId)
        .optional()
        .describe('Default: every capability in the vault.'),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_transfer_assets',
        { targetOuId: args.targetOuId },
        async () =>
          (await org(ctx, args)).units.transferAssets(
            {
              targetOuId: args.targetOuId,
              coinTypes: args.coinTypes,
              capIds: args.capIds,
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_unit_destroy',
    title: 'Prepare: delete an emptied, migrating unit',
    description:
      'Delete a MIGRATING unit and its four companion objects once its treasury and vault are empty (ou::destroy). PERMISSIONLESS cleanup; aborts on-chain otherwise.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.units.destroy',
    inputShape: { ...actingShape, unitId: objectId },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_unit_destroy',
        { unitId: args.unitId },
        async () =>
          (await org(ctx, args)).units.destroy({ unitId: args.unitId }),
      ),
  },

  // ─── emergency freeze ──────────────────────────────────────────────────────
  {
    name: 'prepare_org_freeze_type',
    title: 'Prepare: freeze a proposal type (cap holder)',
    description:
      'Freeze one payload Move type on a unit for its max freeze duration (emergency::freeze_type). The SENDER must own the unit’s FreezeAdminCap; no vote. Generic payloads freeze per instantiation (SendCoin<CRED>, not every SendCoin). Freeze-exempt types abort.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.freeze.freezeType',
    inputShape: {
      ...actingShape,
      moveType: moveTypeIn,
      freezeAdminCapId: objectId,
      unitId: objectId.optional().describe('Default: the acting seat.'),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_freeze_type',
        { moveType: args.moveType },
        async () =>
          (await org(ctx, args)).freeze.freezeType({
            moveType: args.moveType,
            freezeAdminCapId: args.freezeAdminCapId,
            unitId: args.unitId,
          }),
      ),
  },
  {
    name: 'prepare_org_unfreeze_type',
    title: 'Prepare: lift a freeze early (cap holder)',
    description:
      'Lift a freeze before it lapses with the FreezeAdminCap (emergency::unfreeze_type); no vote. Without the cap, use prepare_org_unfreeze.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.freeze.unfreezeType',
    inputShape: {
      ...actingShape,
      moveType: moveTypeIn,
      freezeAdminCapId: objectId,
      unitId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_unfreeze_type',
        { moveType: args.moveType },
        async () =>
          (await org(ctx, args)).freeze.unfreezeType({
            moveType: args.moveType,
            freezeAdminCapId: args.freezeAdminCapId,
            unitId: args.unitId,
          }),
      ),
  },
  {
    name: 'prepare_org_unfreeze',
    title: 'Prepare: lift a freeze by vote',
    description:
      'Lift a freeze by board vote (UnfreezeProposalType) — no cap needed. Always freeze-exempt, so it works while the freeze is in force.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.freeze.unfreeze',
    inputShape: { ...actingShape, moveType: moveTypeIn, ...runOptionsShape },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_unfreeze',
        { moveType: args.moveType },
        async () =>
          (await org(ctx, args)).freeze.unfreeze(
            { moveType: args.moveType },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_freeze_set_max_duration',
    title: 'Prepare: change the freeze duration',
    description:
      'Change how long a freeze lasts (UpdateFreezeConfig, by vote; enable the type first).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.freeze.setMaxDuration',
    inputShape: {
      ...actingShape,
      maxFreezeDurationMs: z.number().int().positive(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_freeze_set_max_duration',
        { maxFreezeDurationMs: args.maxFreezeDurationMs },
        async () =>
          (await org(ctx, args)).freeze.setMaxDuration(
            { maxFreezeDurationMs: args.maxFreezeDurationMs },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_freeze_update_exempt',
    title: 'Prepare: edit the freeze-exempt set',
    description:
      'Add or remove Move types from the set that can never be frozen (UpdateFreezeExemptTypes, by vote; enable the type first).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.freeze.updateExempt',
    inputShape: {
      ...actingShape,
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_freeze_update_exempt',
        { add: args.add ?? [], remove: args.remove ?? [] },
        async () =>
          (await org(ctx, args)).freeze.updateExempt(
            { add: args.add, remove: args.remove },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_freeze_transfer_admin',
    title: 'Prepare: hand the FreezeAdminCap to a new admin',
    description:
      'Transfer the unit’s FreezeAdminCap to newAdmin by vote (TransferFreezeAdmin), unfreezing everything. The EXECUTOR must own the cap — on a slow path, the cap holder executes later with prepare_org_execute_proposal + freezeAdminCapId.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.freeze.transferAdmin',
    inputShape: {
      ...actingShape,
      newAdmin: suiAddress,
      freezeAdminCapId: objectId,
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_freeze_transfer_admin',
        { newAdmin: args.newAdmin },
        async () =>
          (await org(ctx, args)).freeze.transferAdmin(
            {
              newAdmin: args.newAdmin,
              freezeAdminCapId: args.freezeAdminCapId,
            },
            runOptions(args),
          ),
      ),
  },

  // ─── encrypted entries (member-gated, no vote) ─────────────────────────────
  //
  // These index ciphertext that already exists somewhere else. Encrypting it —
  // and decrypting it — needs a wallet-signed Seal session and lives in
  // `@trinaryex/keyspace`, which this keyless server cannot do. What remains is
  // plain object bookkeeping any current board member may perform.
  {
    name: 'prepare_org_entry_publish',
    title: 'Prepare: index an encrypted entry',
    description:
      'Index an already-encrypted blob on a unit (encrypted_entry::publish_entry, max 32 per unit). MEMBER-GATED: any current board member, no vote. This server does not encrypt or upload — encrypt with @trinaryex/keyspace under the unit’s current epoch, upload the ciphertext, then pass where it lives.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.entries.publish',
    inputShape: {
      ...actingShape,
      location: z
        .string()
        .min(1)
        .describe('Where the ciphertext lives, e.g. a Walrus blob id.'),
      description: z.string(),
      unitId: objectId.optional().describe('Default: the acting seat.'),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_entry_publish',
        { location: args.location },
        async () =>
          (await org(ctx, args)).entries.publish({
            location: args.location,
            description: args.description,
            unitId: args.unitId,
          }),
      ),
  },
  {
    name: 'prepare_org_entry_update',
    title: 'Prepare: re-point a stale entry',
    description:
      'Re-point a STALE entry at its re-encrypted blob, stamping the current epoch (encrypted_entry::update_entry). Member-gated.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.entries.update',
    inputShape: {
      ...actingShape,
      entryId: objectId,
      location: z.string().min(1),
      unitId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_entry_update',
        { entryId: args.entryId, location: args.location },
        async () =>
          (await org(ctx, args)).entries.update({
            entryId: args.entryId,
            location: args.location,
            unitId: args.unitId,
          }),
      ),
  },
  {
    name: 'prepare_org_entry_edit',
    title: 'Prepare: move an entry’s blob',
    description:
      'Point an entry at a new location within the SAME epoch — no re-key (encrypted_entry::edit_entry). Member-gated.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.entries.edit',
    inputShape: {
      ...actingShape,
      entryId: objectId,
      location: z.string().min(1),
      unitId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_entry_edit',
        { entryId: args.entryId, location: args.location },
        async () =>
          (await org(ctx, args)).entries.edit({
            entryId: args.entryId,
            location: args.location,
            unitId: args.unitId,
          }),
      ),
  },
  {
    name: 'prepare_org_entries_rotate_epoch',
    title: 'Prepare: rotate a unit’s encryption epoch',
    description:
      'Advance the unit’s encryption epoch, marking every entry stale until it is re-encrypted and updated (encrypted_entry::rotate_encryption_epoch). Member-gated.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.entries.rotateEpoch',
    inputShape: { ...actingShape, unitId: objectId.optional() },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_entries_rotate_epoch',
        { unitId: args.unitId ?? null },
        async () =>
          (await org(ctx, args)).entries.rotateEpoch({ unitId: args.unitId }),
      ),
  },
  {
    name: 'prepare_org_entry_remove',
    title: 'Prepare: delete an encrypted entry',
    description:
      'Unindex and delete an entry (encrypted_entry::remove_entry). The ciphertext itself is not touched. Member-gated.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.entries.remove',
    inputShape: {
      ...actingShape,
      entryId: objectId,
      unitId: objectId.optional(),
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_entry_remove',
        { entryId: args.entryId },
        async () =>
          (await org(ctx, args)).entries.remove({
            entryId: args.entryId,
            unitId: args.unitId,
          }),
      ),
  },

  // ─── upgrades ──────────────────────────────────────────────────────────────
  {
    name: 'prepare_org_upgrade_propose',
    title: 'Prepare: upgrade a package the unit custodies',
    description:
      'Propose — and on a single-vote path, perform — an upgrade of a package whose UpgradeCap sits in the unit’s vault (ProposeUpgrade, VAULT_BORROW). digest, modules and dependencies are exactly what `sui move build --dump-bytecode-as-base64` prints. build is needed only to EXECUTE: omit it when you expect a proposal, and pass it to prepare_org_execute_proposal (as upgrade) once passed.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.upgrade.propose',
    inputShape: {
      ...actingShape,
      capId: objectId.describe('The UpgradeCap id in the unit’s vault.'),
      packageId: objectId.describe('The package being upgraded.'),
      digest: z
        .array(z.number().int().min(0).max(255))
        .length(32)
        .describe('The new package digest, 32 bytes.'),
      policy: z
        .union([z.literal(0), z.literal(128), z.literal(192)])
        .optional()
        .describe('0 compatible (default), 128 additive, 192 dep-only.'),
      build: z
        .object({
          modules: z
            .array(z.string())
            .min(1)
            .describe('Base64 module bytecode.'),
          dependencies: z.array(objectId),
        })
        .optional(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_upgrade_propose',
        { packageId: args.packageId, capId: args.capId },
        async () =>
          (await org(ctx, args)).upgrade.propose(
            {
              capId: args.capId,
              packageId: args.packageId,
              digest: args.digest,
              policy: args.policy,
              build: args.build,
            },
            runOptions(args),
          ),
      ),
  },

  // ─── bypass execution ──────────────────────────────────────────────────────
  {
    name: 'prepare_org_enable_bypass',
    title: 'Prepare: opt a type into bypass execution',
    description:
      'Opt a unit into BYPASS execution for one type (EnableBypassType): the type’s own package may then mint tickets without a vote. Needs 80% of the WHOLE board voting yes; never on a controlled sub-unit. Quorum and approval are basis points.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.capabilities.enableBypass',
    inputShape: {
      ...actingShape,
      typeKey: z.string().min(1),
      moveType: moveTypeIn,
      ...flatConfigShape,
      composableAllowed: z.boolean().optional(),
      ...runOptionsShape,
    },
    syntheticParams: {
      ...ACTING_SYNTHETIC,
      ...FLAT_CONFIG_SYNTHETIC,
      composableAllowed: 'Flattened into the SDK’s nested `config`.',
    },
    derivedParams: {
      config:
        'Assembled from the flat quorum / threshold / timing / permission inputs.',
    },
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_enable_bypass',
        { typeKey: args.typeKey, moveType: args.moveType },
        async () =>
          (await org(ctx, args)).capabilities.enableBypass(
            {
              typeKey: args.typeKey,
              moveType: args.moveType,
              config: {
                ...assembleConfig(args),
                ...(args.composableAllowed !== undefined
                  ? { composableAllowed: args.composableAllowed }
                  : {}),
              },
            },
            runOptions(args),
          ),
      ),
  },
  {
    name: 'prepare_org_disable_bypass',
    title: 'Prepare: opt a type out of bypass execution',
    description:
      'Opt out of bypass execution (DisableBypassType). capId defaults to the vault’s ExternalExecutionCap<moveType>; typeKey to the slot’s label.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'org.capabilities.disableBypass',
    inputShape: {
      ...actingShape,
      moveType: moveTypeIn,
      typeKey: z.string().optional(),
      capId: objectId.optional(),
      ...runOptionsShape,
    },
    syntheticParams: ACTING_SYNTHETIC,
    handler: (ctx, args) =>
      preparedGovernance(
        ctx,
        args.sender,
        'org_disable_bypass',
        { moveType: args.moveType },
        async () =>
          (await org(ctx, args)).capabilities.disableBypass(
            {
              moveType: args.moveType,
              typeKey: args.typeKey,
              capId: args.capId,
            },
            runOptions(args),
          ),
      ),
  },
]

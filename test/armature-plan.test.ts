import type { Transaction } from '@mysten/sui/transactions'

import {
  addMembersAction,
  disableBypassTypeAction,
  disableProposalTypeAction,
  enableBypassTypeAction,
  enableSendCoinAction,
  enableTradingActions,
  removeMembersAction,
  sendCoinTypeKey,
  setBoardAction,
  subOuControlType,
  tradingTypeEntries,
  TRADING_TYPE_CONFIG,
  updateMetadataAction,
  updateProposalConfigAction,
} from '../src/armature/actions'
import { createTribeTx, tradingTypeInits } from '../src/armature/create'
import {
  adoptCurrencyAction,
  currencyTypeEntries,
  mintAllowanceBypassTx,
  mintCoinAction,
} from '../src/armature/currency'
import {
  compositeStepExecutor,
  executorForPayload,
  passedProposalAction,
  splitMoveType,
} from '../src/armature/executors'
import { PERMISSIONS } from '../src/armature/governance'
import {
  createSubOuAction,
  pauseSubOuAction,
  reclaimCapFromSubOuAction,
  spawnOuAction,
  spinOutSubOuAction,
  transferAssetsAction,
  transferCapToSubOuAction,
  transferFreezeAdminAction,
  unfreezeProposalTypeAction,
  updateFreezeExemptTypesAction,
} from '../src/armature/lifecycle'
import {
  buildBatchPlanTx,
  buildCompositeSubmitTx,
  buildExecuteCompositeTx,
  buildExecutePassedTx,
  buildPlanTx,
  extractCreatedProposalId,
  resolveExecutionPlan,
} from '../src/armature/plan'
import {
  createOuTx,
  deleteExhaustedFrameTx,
  deleteExpiredProposalTx,
  freezeTypeTx,
  publishEntryTx,
  voteTx,
} from '../src/armature/transactions'
import {
  claimTreasuryCoinsTx,
  sendSmallPaymentAction,
} from '../src/armature/treasury'
import type { OuExecContext } from '../src/armature/types'
import { proposeUpgradeAction } from '../src/armature/upgrade'
import { TriexError } from '../src/errors'
import { baseConfig } from './helpers/ouChain'

// `tx.object()` and `tx.pure.address()` validate their inputs, so every id here
// has to be real hex — a readable placeholder like `0xchild` throws at build
// time, not at assert time.
const hex = (pair: string) => `0x${pair.repeat(32)}`

const ARMATURE = hex('a1')
const PROPOSALS = hex('b2')
const TRADING = hex('71')
const PKGS = { armature: ARMATURE, armatureProposals: PROPOSALS }

const ALICE = hex('11')
const CAROL = hex('33')
const NEWBIE = hex('44')
const STRANGER = hex('99')

const CHILD = hex('c3')
const CHILD_FREEZE = hex('c4')
const CHILD_CAPS = hex('c5')
const PARENT = hex('d5')
const PARENT_FREEZE = hex('d6')
const PARENT_CAPS = hex('d7')
const CONTROL_CAP = hex('d8')
const CHARTER = hex('e9')
const TREASURY = hex('ea')
const PROPOSAL = hex('f1')
const FRAME = hex('f2')
const CAP = hex('f3')

const CRED = `${hex('c0')}::cred::CRED`
const BASE = `${hex('b0')}::base::BASE`

const ctx: OuExecContext = {
  daoId: CHILD,
  board: [ALICE],
  emergencyFreezeId: CHILD_FREEZE,
  parent: {
    daoId: PARENT,
    board: [CAROL],
    emergencyFreezeId: PARENT_FREEZE,
    capVaultId: PARENT_CAPS,
    controlCapId: CONTROL_CAP,
  },
}

/** Compact command list: 'module::function' for MoveCalls, '$kind' otherwise. */
function commandNames(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.map((c: any) =>
      c.$kind === 'MoveCall'
        ? `${c.MoveCall.module}::${c.MoveCall.function}`
        : c.$kind,
    )
}

/** Type arguments of each MoveCall, in order. */
function typeArgs(tx: Transaction): string[][] {
  return tx
    .getData()
    .commands.filter((c: any) => c.$kind === 'MoveCall')
    .map((c: any) => c.MoveCall.typeArguments)
}

/** Package id of each MoveCall, in order. */
function packages(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.filter((c: any) => c.$kind === 'MoveCall')
    .map((c: any) => c.MoveCall.package)
}

/** Number of arguments of the MoveCall at `index` (of MoveCalls only). */
function argCount(tx: Transaction, index: number): number {
  const calls = tx.getData().commands.filter((c: any) => c.$kind === 'MoveCall')
  return (calls[index] as any).MoveCall.arguments.length
}

function objectInputs(tx: Transaction): string[] {
  return (tx.getData().inputs as any[])
    .map(
      (i) =>
        i?.UnresolvedObject?.objectId ?? i?.Object?.ImmOrOwnedObject?.objectId,
    )
    .filter(Boolean)
}

describe('buildPlanTx — one action per strategy (cycle 7)', () => {
  const action = addMembersAction(PKGS, [ALICE])

  it('own-execute: framework payload → submit_vote_execute (no type_key) → handler', () => {
    const tx = buildPlanTx('own-execute', action, ctx, PKGS.armature)
    expect(commandNames(tx)).toEqual([
      'batch_add_members::new',
      'board_voting::submit_vote_execute',
      'member_ops::execute_batch_add_members',
    ])
    expect(typeArgs(tx)[1]).toEqual([
      `${ARMATURE}::batch_add_members::BatchAddMembers`,
    ])
    // BatchAddMembers moved INTO the framework in cycle 7.
    expect(packages(tx)).toEqual([ARMATURE, ARMATURE, ARMATURE])
    // (ou, metadata_ipfs, payload, freeze, clock) — the type_key is gone.
    expect(argCount(tx, 1)).toBe(5)
  })

  it('own-execute with readonly picks submit_vote_execute_readonly', () => {
    const tx = buildPlanTx('own-execute', action, ctx, PKGS.armature, {
      readonly: true,
    })
    expect(commandNames(tx)[1]).toBe(
      'board_voting::submit_vote_execute_readonly',
    )
  })

  it('own-propose: payload → submit_proposal (4 args), and no execute', () => {
    const tx = buildPlanTx('own-propose', action, ctx, PKGS.armature)
    expect(commandNames(tx)).toEqual([
      'batch_add_members::new',
      'board_voting::submit_proposal',
    ])
    expect(argCount(tx, 1)).toBe(4)
  })

  it('control-execute: control payload → parent vote → subou execute (no clock)', () => {
    const tx = buildPlanTx('control-execute', action, ctx, PKGS.armature)
    expect(commandNames(tx)).toEqual([
      'controller_batch_add_members::new',
      'board_voting::submit_vote_execute',
      'subou_ops::execute_controller_batch_add_members',
    ])
    // (controller_vault, members_ou, ticket) — cycle 7 dropped the clock.
    expect(argCount(tx, 2)).toBe(3)
    expect(packages(tx)).toEqual([PROPOSALS, ARMATURE, PROPOSALS])
  })

  it('control-propose: control payload → parent proposal', () => {
    const tx = buildPlanTx('control-propose', action, ctx, PKGS.armature)
    expect(commandNames(tx)).toEqual([
      'controller_batch_add_members::new',
      'board_voting::submit_proposal',
    ])
  })

  it('refuses a strategy the action cannot carry, with a typed error', () => {
    const ownOnly = setBoardAction(PKGS, { add: [ALICE] })
    expect(() =>
      buildPlanTx('control-execute', ownOnly, ctx, PKGS.armature),
    ).toThrow(expect.objectContaining({ code: TriexError.ValidationFailed }))
    const controlOnly = pauseSubOuAction(PKGS)
    expect(() =>
      buildPlanTx('own-execute', controlOnly, ctx, PKGS.armature),
    ).toThrow(expect.objectContaining({ code: TriexError.ValidationFailed }))
  })

  it('refuses a control strategy when there is no parent linkage', () => {
    const rootCtx: OuExecContext = {
      daoId: hex('07'),
      board: [ALICE],
      emergencyFreezeId: hex('0f'),
    }
    expect(() =>
      buildPlanTx('control-execute', action, rootCtx, PKGS.armature),
    ).toThrow(expect.objectContaining({ code: TriexError.ValidationFailed }))
  })
})

describe('buildBatchPlanTx', () => {
  it('applies N actions under one strategy in one transaction', () => {
    const actions = enableTradingActions(PKGS, {
      armatureTrading: TRADING,
      quoteType: CRED,
    })
    expect(actions).toHaveLength(tradingTypeEntries(TRADING, CRED).length)
    const tx = buildBatchPlanTx('own-execute', actions, ctx, PKGS.armature)
    // SetupTradingAccount: type_name_of, new_config, new, submit, execute.
    expect(commandNames(tx).slice(0, 5)).toEqual([
      'ou::type_name_of',
      'proposal::new_config',
      'enable_proposal_type::new',
      'board_voting::submit_vote_execute',
      'admin_ops::execute_enable_proposal_type',
    ])
    // The treasury-withdrawing DepositCoinToBook carries its bit.
    expect(commandNames(tx)).toContain('proposal::with_permissions')
  })
})

describe('buildCompositeSubmitTx', () => {
  it('routes EnableProposalType / UpdateProposalConfig through the typed add_* entry points', () => {
    const tx = buildCompositeSubmitTx(
      [
        updateProposalConfigAction(PKGS, 'SetBoard', { quorum: 1 }),
        setBoardAction(PKGS, { add: [NEWBIE] }),
      ],
      ctx,
      PKGS.armature,
    )
    expect(commandNames(tx)).toEqual([
      'composite::new_frame',
      'update_proposal_config::new',
      'composite::add_update_proposal_config_step',
      'set_board::new',
      'composite::add_step',
      'composite::submit_composite',
    ])
    // The typed step takes no type argument; add_step<P> does.
    expect(typeArgs(tx)[2]).toEqual([])
    expect(typeArgs(tx)[4]).toEqual([`${ARMATURE}::set_board::SetBoard`])
  })

  it('refuses a step that grants permission bits (EGrantInComposite)', () => {
    expect(() =>
      buildCompositeSubmitTx(
        [
          setBoardAction(PKGS, { add: [NEWBIE] }),
          updateProposalConfigAction(PKGS, 'SendCoin', { permissions: 128 }),
        ],
        ctx,
        PKGS.armature,
      ),
    ).toThrow(expect.objectContaining({ code: TriexError.ValidationFailed }))
  })

  it('refuses a control-only action — composites run the own pipeline', () => {
    expect(() =>
      buildCompositeSubmitTx(
        [setBoardAction(PKGS, { add: [NEWBIE] }), pauseSubOuAction(PKGS)],
        ctx,
        PKGS.armature,
      ),
    ).toThrow(expect.objectContaining({ code: TriexError.ValidationFailed }))
  })
})

describe('buildExecutePassedTx', () => {
  it('takes the ticket from the recorded vote (proposal by value), then runs the handler', () => {
    const tx = buildExecutePassedTx({
      action: setBoardAction(PKGS, {}),
      armature: PKGS.armature,
      daoId: CHILD,
      proposalId: PROPOSAL,
      emergencyFreezeId: CHILD_FREEZE,
    })
    expect(commandNames(tx)).toEqual([
      'board_voting::ticket_from_vote',
      'board_ops::execute_set_board',
    ])
    expect(typeArgs(tx)[0]).toEqual([`${ARMATURE}::set_board::SetBoard`])
  })

  it('uses ticket_from_vote_readonly when asked', () => {
    const tx = buildExecutePassedTx({
      action: setBoardAction(PKGS, {}),
      armature: PKGS.armature,
      daoId: CHILD,
      proposalId: PROPOSAL,
      emergencyFreezeId: CHILD_FREEZE,
      readonly: true,
    })
    expect(commandNames(tx)[0]).toBe('board_voting::ticket_from_vote_readonly')
  })

  it('refuses an action with no own adapter', () => {
    expect(() =>
      buildExecutePassedTx({
        action: pauseSubOuAction(PKGS),
        armature: PKGS.armature,
        daoId: CHILD,
        proposalId: PROPOSAL,
        emergencyFreezeId: hex('0f'),
      }),
    ).toThrow(expect.objectContaining({ code: TriexError.ValidationFailed }))
  })
})

describe('buildExecuteCompositeTx', () => {
  it('threads the pipeline potato through every step and finalizes once', () => {
    const step = compositeStepExecutor(PKGS, 'UpdateProposalConfig')!
    expect(step).toBeTruthy()
    const tx = buildExecuteCompositeTx({
      armature: PKGS.armature,
      daoId: CHILD,
      proposalId: PROPOSAL,
      emergencyFreezeId: CHILD_FREEZE,
      frameId: FRAME,
      steps: [step, step],
    })
    expect(commandNames(tx)).toEqual([
      'board_voting::ticket_from_vote',
      'composite::begin_pipeline',
      'composite::advance_step',
      'admin_ops::execute_update_proposal_config',
      'composite::advance_step',
      'admin_ops::execute_update_proposal_config',
      'composite::finalize_pipeline',
    ])
    // Cycle 7: CompositePayload lives in its own leaf module.
    expect(typeArgs(tx)[0]).toEqual([
      `${ARMATURE}::composite_payload::CompositePayload`,
    ])
  })

  it('can reclaim the exhausted frame in the same transaction', () => {
    const step = compositeStepExecutor(PKGS, 'SetBoard')!
    const tx = buildExecuteCompositeTx({
      armature: PKGS.armature,
      daoId: CHILD,
      proposalId: PROPOSAL,
      emergencyFreezeId: CHILD_FREEZE,
      frameId: FRAME,
      steps: [step],
      deleteFrame: true,
    })
    expect(commandNames(tx).at(-1)).toBe('composite::delete_exhausted_frame')
  })

  it('refuses an empty pipeline', () => {
    expect(() =>
      buildExecuteCompositeTx({
        armature: PKGS.armature,
        daoId: CHILD,
        proposalId: PROPOSAL,
        emergencyFreezeId: CHILD_FREEZE,
        frameId: FRAME,
        steps: [],
      }),
    ).toThrow(expect.objectContaining({ code: TriexError.ValidationFailed }))
  })

  it('has no executor for an unmapped step type', () => {
    expect(compositeStepExecutor(PKGS, 'SomeUnwiredType')).toBeNull()
  })
})

describe('resolveExecutionPlan', () => {
  it('attaches a lazy builder that matches the chosen strategy — readonly for cooldown 0', () => {
    const plan = resolveExecutionPlan(
      addMembersAction(PKGS, [ALICE]),
      ctx,
      { ownConfig: baseConfig(), controlConfig: null },
      ALICE,
      PKGS.armature,
    )
    expect(plan.blocked).toBe(false)
    if (plan.blocked) return
    expect(plan.strategy).toBe('own-execute')
    expect(plan.readonly).toBe(true)
    expect(commandNames(plan.buildTx())).toContain(
      'board_voting::submit_vote_execute_readonly',
    )
  })

  it('uses the &mut entry point for a type with a cooldown', () => {
    const plan = resolveExecutionPlan(
      addMembersAction(PKGS, [ALICE]),
      ctx,
      { ownConfig: baseConfig({ cooldownMs: 1 }), controlConfig: null },
      ALICE,
      PKGS.armature,
    )
    if (plan.blocked) throw new Error('blocked')
    expect(commandNames(plan.buildTx())).toContain(
      'board_voting::submit_vote_execute',
    )
  })

  it('passes a blocked decision straight through, with no builder', () => {
    const plan = resolveExecutionPlan(
      addMembersAction(PKGS, [ALICE]),
      ctx,
      { ownConfig: null, controlConfig: null },
      STRANGER,
      PKGS.armature,
    )
    expect(plan).toEqual({
      blocked: true,
      code: 'not-member',
      reason: expect.any(String),
    })
  })
})

describe('extractCreatedProposalId', () => {
  it('finds the created Proposal from effects', () => {
    expect(
      extractCreatedProposalId({
        digest: 'd',
        raw: {},
        createdObjects: [
          { objectId: '0xa', objectType: '0x2::coin::Coin<0x2::sui::SUI>' },
          {
            objectId: '0xprop-id',
            objectType: `${ARMATURE}::proposal::Proposal<${ARMATURE}::set_board::SetBoard>`,
          },
        ],
      }),
    ).toBe('0xprop-id')
  })

  it('is undefined for a single-PTB execution — cycle 7 creates no Proposal', () => {
    expect(
      extractCreatedProposalId({ digest: 'd', raw: {}, createdObjects: [] }),
    ).toBeUndefined()
  })
})

describe('framework primitives', () => {
  it('votes through board_voting::vote, passing the OU', () => {
    const tx = voteTx({
      armature: ARMATURE,
      proposalId: PROPOSAL,
      ouId: CHILD,
      payloadMoveType: `${ARMATURE}::set_board::SetBoard`,
      approve: true,
    })
    expect(commandNames(tx)).toEqual(['board_voting::vote'])
    expect(objectInputs(tx)).toEqual(expect.arrayContaining([PROPOSAL, CHILD]))
  })

  it('cleans expired proposals with delete_expired_proposal, batched', () => {
    const tx = deleteExpiredProposalTx({
      armature: ARMATURE,
      proposals: [
        {
          proposalId: PROPOSAL,
          payloadMoveType: `${ARMATURE}::set_board::SetBoard`,
        },
        {
          proposalId: FRAME,
          payloadMoveType: `${ARMATURE}::add_member::AddMember`,
        },
      ],
    })
    expect(commandNames(tx)).toEqual([
      'proposal::delete_expired_proposal',
      'proposal::delete_expired_proposal',
    ])
  })

  it('reclaims a frame, freezes a type, publishes an entry, creates an OU', () => {
    expect(
      commandNames(
        deleteExhaustedFrameTx({ armature: ARMATURE, frameId: FRAME }),
      ),
    ).toEqual(['composite::delete_exhausted_frame'])
    const fz = freezeTypeTx({
      armature: ARMATURE,
      emergencyFreezeId: CHILD_FREEZE,
      freezeAdminCapId: CAP,
      moveType: `${PROPOSALS}::send_coin::SendCoin<${CRED}>`,
    })
    expect(commandNames(fz)).toEqual(['emergency::freeze_type'])
    expect(typeArgs(fz)[0]).toEqual([
      `${PROPOSALS}::send_coin::SendCoin<${CRED}>`,
    ])
    expect(
      commandNames(
        publishEntryTx({
          armature: ARMATURE,
          ouId: CHILD,
          location: 'walrus://x',
          description: 'd',
        }),
      ),
    ).toEqual(['encrypted_entry::publish_entry'])
    expect(
      commandNames(
        createOuTx({
          armature: ARMATURE,
          board: [ALICE],
          name: 'n',
          metadataUri: 'u',
        }),
      ),
    ).toEqual(['governance::init_board', 'ou::create'])
  })
})

describe('action catalog details', () => {
  it('keys treasury withdrawals per coin and grants TREASURY_WITHDRAW at 80%', () => {
    expect(sendCoinTypeKey(CRED)).toBe(`SendCoin<${CRED}>`)
    const a = enableSendCoinAction(PKGS, CRED)
    const tx = buildPlanTx('own-propose', a, ctx, PKGS.armature)
    expect(commandNames(tx)).toEqual([
      'ou::type_name_of',
      'proposal::new_config',
      'proposal::with_permissions',
      'enable_proposal_type::new',
      'board_voting::submit_proposal',
    ])
    // The approved type is pinned IN the payload (cycle 7).
    expect(typeArgs(tx)[0]).toEqual([
      `${PROPOSALS}::send_coin::SendCoin<${CRED}>`,
    ])
    expect(a.grantsPermissions).toBe(true)
  })

  it('adds coin-pool order types per base coin, keyed by the full type', () => {
    const withoutBase = tradingTypeEntries(TRADING, CRED)
    expect(withoutBase.some((e) => e.typeKey.includes('_coin::'))).toBe(false)
    const withBase = tradingTypeEntries(TRADING, CRED, [BASE])
    const coinOrder = withBase.find((e) =>
      e.moveType.includes('place_limit_order_coin::PlaceLimitOrderCoin'),
    )
    expect(coinOrder?.typeKey).toBe(coinOrder?.moveType)
    expect(coinOrder?.moveType).toBe(
      `${TRADING}::place_limit_order_coin::PlaceLimitOrderCoin<${BASE}, ${CRED}>`,
    )
    // Cycle-7 trading module set, with the treasury-withdraw bit where needed.
    const bits = Object.fromEntries(
      withoutBase.map((e) => [e.typeKey.split('::').at(-1), e.permissions]),
    )
    expect(bits).toEqual({
      SetupTradingAccount: 0,
      DepositCoinToBook: PERMISSIONS.TREASURY_WITHDRAW,
      DepositFromOuVaultToBook: 0,
      PlaceLimitOrder: 0,
      PlaceMarketOrder: 0,
      CancelOrder: 0,
      CreateMulticoinPool: PERMISSIONS.TREASURY_WITHDRAW,
      SweepCoinToTreasury: 0,
      SweepMulticoinToOuVault: 0,
    })
  })

  it('skips types the unit already has enabled (display key OR Move type)', () => {
    const all = tradingTypeEntries(TRADING, CRED)
    const actions = enableTradingActions(PKGS, {
      armatureTrading: TRADING,
      quoteType: CRED,
      alreadyEnabled: new Set([all[0].typeKey, all[1].moveType]),
    })
    expect(actions).toHaveLength(all.length - 2)
  })

  it('SetBoard is a diff', () => {
    const tx = buildPlanTx(
      'own-propose',
      setBoardAction(PKGS, { add: [NEWBIE], remove: [CAROL] }),
      ctx,
      PKGS.armature,
    )
    expect(commandNames(tx)[0]).toBe('set_board::new')
    expect(argCount(tx, 0)).toBe(2)
  })

  it('removal has an own path now (BatchRemoveMembers is a default slot)', () => {
    const a = removeMembersAction(PKGS, [CAROL])
    expect(a.own?.payloadMoveType).toBe(
      `${ARMATURE}::batch_remove_members::BatchRemoveMembers`,
    )
    expect(a.control?.requiredPermissions).toBe(PERMISSIONS.VAULT_BORROW)
    expect(a.control?.requiredBorrowScope).toEqual([subOuControlType(ARMATURE)])
  })

  it('metadata execute targets the Charter, not the OU', () => {
    const tx = buildPlanTx(
      'own-execute',
      updateMetadataAction(PKGS, 'ipfs://x', CHARTER),
      ctx,
      PKGS.armature,
    )
    expect(commandNames(tx)).toEqual([
      'update_metadata::new',
      'board_voting::submit_vote_execute',
      'admin_ops::execute_update_metadata',
    ])
    expect(objectInputs(tx)).toContain(CHARTER)
  })

  it('config patches carry permissions and borrow scope as grants', () => {
    const a = updateProposalConfigAction(PKGS, 'MintCoin<X>', {
      permissions: PERMISSIONS.VAULT_BORROW,
      borrowScope: ['0x2::coin::TreasuryCap<0x2::sui::SUI>'],
    })
    const tx = buildPlanTx('own-propose', a, ctx, PKGS.armature)
    expect(commandNames(tx)).toEqual([
      'update_proposal_config::new',
      'update_proposal_config::with_permissions',
      'ou::type_name_of',
      'MakeMoveVec',
      'update_proposal_config::with_borrow_scope',
      'board_voting::submit_proposal',
    ])
    expect(a.grantsPermissions).toBe(true)
  })

  it('disable / bypass enable / bypass disable build their framework calls', () => {
    expect(
      commandNames(
        buildPlanTx(
          'own-execute',
          disableProposalTypeAction(PKGS, 'X'),
          ctx,
          ARMATURE,
        ),
      ),
    ).toEqual([
      'disable_proposal_type::new',
      'board_voting::submit_vote_execute',
      'admin_ops::execute_disable_proposal_type',
    ])
    const moveType = `${PROPOSALS}::mint_allowance::MintAllowance<${CRED}>`
    const en = buildPlanTx(
      'own-execute',
      enableBypassTypeAction(PKGS, {
        typeKey: 'MintAllowance',
        moveType,
        config: TRADING_TYPE_CONFIG,
        capabilityVaultId: CHILD_CAPS,
      }),
      ctx,
      ARMATURE,
    )
    expect(commandNames(en).at(-1)).toBe(
      'external_execution::execute_enable_bypass_type',
    )
    expect(typeArgs(en).at(-1)).toEqual([moveType])
    const dis = buildPlanTx(
      'own-execute',
      disableBypassTypeAction(PKGS, {
        typeKey: 'MintAllowance',
        moveType,
        capId: CAP,
        capabilityVaultId: CHILD_CAPS,
      }),
      ctx,
      ARMATURE,
    )
    expect(commandNames(dis).at(-1)).toBe(
      'external_execution::execute_disable_bypass_type',
    )
  })
})

describe('lifecycle, control, freeze, currency, upgrade builders', () => {
  it('pause / reclaim / transfer-cap / spin-out are parent→child control adapters', () => {
    const pause = buildPlanTx(
      'control-execute',
      pauseSubOuAction(PKGS),
      ctx,
      ARMATURE,
    )
    expect(commandNames(pause)).toEqual([
      'pause_execution::new_pause',
      'board_voting::submit_vote_execute',
      'subou_ops::execute_pause_subou_execution',
    ])
    const params = {
      subOuId: CHILD,
      subOuCapabilityVaultId: CHILD_CAPS,
      capId: CAP,
      capType: '0x2::package::UpgradeCap',
    }
    expect(
      commandNames(
        buildPlanTx(
          'control-execute',
          reclaimCapFromSubOuAction(PKGS, params),
          ctx,
          ARMATURE,
        ),
      ).at(-1),
    ).toBe('subou_ops::execute_reclaim_cap')
    expect(
      commandNames(
        buildPlanTx(
          'control-execute',
          transferCapToSubOuAction(PKGS, params),
          ctx,
          ARMATURE,
        ),
      ).at(-1),
    ).toBe('subou_ops::execute_transfer_cap')
    const spin = buildPlanTx(
      'control-propose',
      spinOutSubOuAction(PKGS, {
        subOuId: CHILD,
        subOuCapabilityVaultId: CHILD_CAPS,
        freezeAdminCapId: CAP,
      }),
      ctx,
      ARMATURE,
    )
    expect(
      commandNames(spin).filter((c) => c === 'proposal::new_config'),
    ).toHaveLength(3)
  })

  it('create / spawn / transfer-assets are own lifecycle actions', () => {
    expect(
      commandNames(
        buildPlanTx(
          'own-execute',
          createSubOuAction(PKGS, {
            name: 'n',
            board: [ALICE],
            metadataUri: 'u',
            capabilityVaultId: CHILD_CAPS,
          }),
          ctx,
          ARMATURE,
        ),
      ).at(-1),
    ).toBe('lifecycle_ops::execute_create_subou')
    expect(
      commandNames(
        buildPlanTx(
          'own-propose',
          spawnOuAction(PKGS, { board: [ALICE], name: 'n', metadataUri: 'u' }),
          ctx,
          ARMATURE,
        ),
      ),
    ).toEqual([
      'governance::init_board',
      'spawn_ou::new',
      'board_voting::submit_proposal',
    ])
    const ta = buildPlanTx(
      'own-execute',
      transferAssetsAction(PKGS, {
        targetOuId: PARENT,
        targetTreasuryId: hex('aa'),
        targetCapabilityVaultId: hex('ab'),
        coinTypes: [CRED],
        caps: [{ id: CAP, type: '0x2::package::UpgradeCap' }],
        treasuryVaultId: TREASURY,
        capabilityVaultId: CHILD_CAPS,
      }),
      ctx,
      ARMATURE,
    )
    expect(commandNames(ta).slice(-4)).toEqual([
      'lifecycle_ops::begin_transfer_assets',
      'lifecycle_ops::transfer_coin',
      'lifecycle_ops::transfer_cap',
      'lifecycle_ops::finish_transfer_assets',
    ])
  })

  it('freeze governance actions target the EmergencyFreeze', () => {
    const t = buildPlanTx(
      'own-execute',
      transferFreezeAdminAction(PKGS, {
        newAdmin: ALICE,
        freezeAdminCapId: CAP,
        emergencyFreezeId: CHILD_FREEZE,
      }),
      ctx,
      ARMATURE,
    )
    expect(commandNames(t).at(-1)).toBe(
      'freeze_ops::execute_transfer_freeze_admin',
    )
    expect(objectInputs(t)).toEqual(expect.arrayContaining([CAP, CHILD_FREEZE]))
    const u = buildPlanTx(
      'own-propose',
      unfreezeProposalTypeAction(PKGS, {
        moveType: `${ARMATURE}::set_board::SetBoard`,
        emergencyFreezeId: CHILD_FREEZE,
      }),
      ctx,
      ARMATURE,
    )
    expect(typeArgs(u)[0]).toEqual([`${ARMATURE}::set_board::SetBoard`])
    const ex = buildPlanTx(
      'own-propose',
      updateFreezeExemptTypesAction(PKGS, {
        add: [CRED],
        remove: [BASE],
        emergencyFreezeId: CHILD_FREEZE,
      }),
      ctx,
      ARMATURE,
    )
    expect(commandNames(ex).slice(0, 3)).toEqual([
      'update_freeze_exempt_types::new',
      'update_freeze_exempt_types::add_type',
      'update_freeze_exempt_types::remove_type',
    ])
  })

  it('currency types carry their bits and TreasuryCap scope', () => {
    const entries = currencyTypeEntries(PROPOSALS, CRED, TRADING_TYPE_CONFIG)
    const mint = entries.find((e) => e.typeKey === `MintCoin<${CRED}>`)!
    expect(mint.config).toMatchObject({
      approvalThreshold: 8000,
      permissions: PERMISSIONS.VAULT_BORROW,
      borrowScope: [`0x2::coin::TreasuryCap<${CRED}>`],
    })
    const adopt = buildPlanTx(
      'own-execute',
      adoptCurrencyAction(PKGS, {
        coinType: CRED,
        treasuryCapId: CAP,
        capabilityVaultId: CHILD_CAPS,
      }),
      ctx,
      ARMATURE,
    )
    expect(objectInputs(adopt)).toContain(CAP)
    const m = mintCoinAction(PKGS, {
      coinType: CRED,
      treasuryCapId: CAP,
      amount: 5n,
      capabilityVaultId: CHILD_CAPS,
      treasuryVaultId: TREASURY,
    })
    expect(m.own?.requiredBorrowScope).toEqual([
      `0x2::coin::TreasuryCap<${CRED}>`,
    ])
    const bypass = mintAllowanceBypassTx({
      armatureProposals: PROPOSALS,
      coinType: CRED,
      ouId: CHILD,
      capabilityVaultId: CHILD_CAPS,
      treasuryVaultId: TREASURY,
      emergencyFreezeId: CHILD_FREEZE,
      bypassCapId: CAP,
      treasuryCapId: hex('cc'),
      amount: 1n,
    })
    expect(commandNames(bypass)).toEqual([
      'currency_ops::mint_allowance_bypass',
    ])
  })

  it('small payments and claims build their treasury calls', () => {
    const sp = buildPlanTx(
      'own-execute',
      sendSmallPaymentAction(PKGS, {
        coinType: CRED,
        recipient: ALICE,
        amount: 1n,
        treasuryVaultId: TREASURY,
      }),
      ctx,
      ARMATURE,
    )
    expect(commandNames(sp).at(-1)).toBe(
      'treasury_ops::execute_send_small_payment',
    )
    const cl = claimTreasuryCoinsTx({
      armature: ARMATURE,
      treasuryVaultId: TREASURY,
      coinType: CRED,
      coinObjectIds: [CAP, hex('cd')],
    })
    expect(commandNames(cl)).toEqual([
      'treasury_vault::claim_coin',
      'treasury_vault::claim_coin',
    ])
  })

  it('an upgrade executes as authorize → Upgrade → commit in one PTB', () => {
    const a = proposeUpgradeAction(PKGS, {
      capId: CAP,
      packageId: hex('ee'),
      digest: new Uint8Array(32),
      capabilityVaultId: CHILD_CAPS,
      build: { modules: [[1, 2, 3]], dependencies: ['0x1', '0x2'] },
    })
    expect(commandNames(buildPlanTx('own-execute', a, ctx, ARMATURE))).toEqual([
      'propose_upgrade::new',
      'board_voting::submit_vote_execute',
      'upgrade_ops::execute_propose_upgrade',
      'Upgrade',
      'upgrade_ops::commit_upgrade',
    ])
    const noBuild = proposeUpgradeAction(PKGS, {
      capId: CAP,
      packageId: hex('ee'),
      digest: new Uint8Array(32),
      capabilityVaultId: CHILD_CAPS,
    })
    expect(() => buildPlanTx('own-execute', noBuild, ctx, ARMATURE)).toThrow(
      expect.objectContaining({ code: TriexError.ValidationFailed }),
    )
  })

  it('creates a tribe through tribe_setup with ProposalTypeInit overrides', () => {
    const tx = createTribeTx({
      armature: ARMATURE,
      armatureProposals: PROPOSALS,
      tribeBoard: [ALICE],
      officers: [ALICE],
      members: [ALICE],
      tribeName: 'T',
      officerName: 'O',
      memberName: 'M',
      tribeMetadataUri: 'u',
      officerMetadataUri: 'u',
      memberMetadataUri: 'u',
      officerFreezeAdmin: ALICE,
      memberFreezeAdmin: ALICE,
      officerOverrides: tradingTypeInits(TRADING, CRED),
    })
    const names = commandNames(tx)
    expect(names.at(-1)).toBe('tribe_setup::create_tribe_configured')
    expect(packages(tx).at(-1)).toBe(PROPOSALS)
    expect(names.filter((n) => n === 'ou::new_type_init')).toHaveLength(
      tradingTypeEntries(TRADING, CRED).length,
    )
  })
})

describe('executors — dispatch by payload type', () => {
  const unit = {
    daoId: CHILD,
    charterId: CHARTER,
    treasuryId: TREASURY,
    capabilityVaultId: CHILD_CAPS,
    emergencyFreezeId: CHILD_FREEZE,
  }

  it('splits generic Move types at the top level', () => {
    expect(
      splitMoveType(`${TRADING}::m::S<${BASE}, ${CRED}>`).args,
    ).toHaveLength(2)
  })

  it('EnableProposalType executes with the type PINNED in its payload', () => {
    const exec = executorForPayload(
      `${ARMATURE}::enable_proposal_type::EnableProposalType`,
      {
        pkgs: PKGS,
        unit,
        payload: { type_name: { name: `${'c0'.repeat(32)}::cred::CRED` } },
      },
    )
    expect('execute' in exec).toBe(true)
  })

  it('names what is missing instead of guessing', () => {
    const r = executorForPayload(
      `${ARMATURE}::transfer_freeze_admin::TransferFreezeAdmin`,
      { pkgs: PKGS, unit },
    )
    expect(r).toEqual({ missing: expect.stringContaining('freezeAdminCapId') })
    expect(
      executorForPayload(`${hex('77')}::x::Y`, { pkgs: PKGS, unit }),
    ).toEqual({ missing: expect.stringContaining('no wired executor') })
  })

  it('SendCoinToOU reads its target treasury from the payload', () => {
    const r = executorForPayload(
      `${PROPOSALS}::send_coin_to_ou::SendCoinToOU<${CRED}>`,
      { pkgs: PKGS, unit, payload: { recipient_treasury: hex('9a') } },
    )
    if (!('execute' in r)) throw new Error(r.missing)
    const tx = buildExecutePassedTx({
      action: {
        kind: 'x',
        own: {
          typeKey: 'x',
          payloadMoveType: `${PROPOSALS}::send_coin_to_ou::SendCoinToOU<${CRED}>`,
          buildPayload: () => {
            throw new Error()
          },
          buildExecute: r.execute,
        },
      },
      armature: ARMATURE,
      daoId: CHILD,
      proposalId: PROPOSAL,
      emergencyFreezeId: CHILD_FREEZE,
    })
    expect(objectInputs(tx)).toEqual(
      expect.arrayContaining([TREASURY, hex('9a')]),
    )
  })

  it('passedProposalAction maps default display keys and per-coin keys', () => {
    expect(
      passedProposalAction(PKGS, { typeKey: 'SetBoard' })?.own?.payloadMoveType,
    ).toBe(`${ARMATURE}::set_board::SetBoard`)
    expect(
      passedProposalAction(PKGS, {
        typeKey: `SendCoin<${CRED}>`,
        unit,
      })?.own?.payloadMoveType,
    ).toBe(`${PROPOSALS}::send_coin::SendCoin<${CRED}>`)
    // CharterUpdate needs the Charter id to build its execute call.
    expect(passedProposalAction(PKGS, { typeKey: 'CharterUpdate' })).toBeNull()
    expect(
      passedProposalAction(PKGS, {
        typeKey: 'CharterUpdate',
        charterId: CHARTER,
      }),
    ).not.toBeNull()
    expect(passedProposalAction(PKGS, { typeKey: 'Unwired' })).toBeNull()
  })
})

/** The full ladder end-to-end: a real action, real configs, real transaction. */
describe('resolver → builder integration', () => {
  // tribe_setup's ControllerBatch* config: single-vote, VAULT_BORROW, SubOUControl scope.
  const controller = baseConfig({
    approvalThreshold: 8000,
    permissions: PERMISSIONS.VAULT_BORROW,
    borrowScope: [subOuControlType(ARMATURE)],
  })

  it('an officer adding members through the parent gets ONE transaction', () => {
    const plan = resolveExecutionPlan(
      addMembersAction(PKGS, [NEWBIE]),
      ctx,
      { ownConfig: null, controlConfig: controller },
      CAROL, // on the parent board only
      PKGS.armature,
    )
    expect(plan.blocked).toBe(false)
    if (plan.blocked) return
    expect(plan.immediate).toBe(true)
    expect(commandNames(plan.buildTx())).toEqual([
      'controller_batch_add_members::new',
      'board_voting::submit_vote_execute_readonly',
      'subou_ops::execute_controller_batch_add_members',
    ])
  })

  it('is blocked, not mis-signed, when the controller slot lacks its bits', () => {
    const plan = resolveExecutionPlan(
      addMembersAction(PKGS, [NEWBIE]),
      ctx,
      { ownConfig: null, controlConfig: baseConfig() },
      CAROL,
      PKGS.armature,
    )
    expect(plan).toMatchObject({ blocked: true, code: 'missing-permissions' })
  })

  it('the same call becomes a proposal when quorum needs a real vote', () => {
    const plan = resolveExecutionPlan(
      addMembersAction(PKGS, [NEWBIE]),
      {
        ...ctx,
        parent: { ...ctx.parent!, board: [CAROL, hex('dd'), hex('ee')] },
      },
      { ownConfig: null, controlConfig: { ...controller, quorum: 5000 } },
      CAROL,
      PKGS.armature,
    )
    expect(plan.blocked).toBe(false)
    if (plan.blocked) return
    expect(plan.immediate).toBe(false)
    expect(commandNames(plan.buildTx())).toEqual([
      'controller_batch_add_members::new',
      'board_voting::submit_proposal',
    ])
  })
})

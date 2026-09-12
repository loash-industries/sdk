import type { Transaction } from '@mysten/sui/transactions'

import {
  addMembersAction,
  removeMembersAction,
  setBoardAction,
  updateMetadataAction,
  updateProposalConfigAction,
  enableSendCoinAction,
  enableTradingActions,
  compositeStepExecutor,
  passedProposalAction,
  sendCoinTypeKey,
  tradingTypeEntries,
} from '../src/armature/actions'
import {
  buildBatchPlanTx,
  buildCompositeSubmitTx,
  buildExecuteCompositeTx,
  buildExecutePassedTx,
  buildPlanTx,
  extractCreatedProposalId,
  resolveExecutionPlan,
} from '../src/armature/plan'
import type { OuExecContext } from '../src/armature/types'
import { TriexError } from '../src/errors'

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
const PARENT = hex('d5')
const PARENT_FREEZE = hex('d6')
const PARENT_CAPS = hex('d7')
const CONTROL_CAP = hex('d8')
const CHARTER = hex('e9')
const PROPOSAL = hex('f1')
const FRAME = hex('f2')

const CRED = `${hex('c0')}::cred::CRED`
const RECORDED_STEP_TYPE = `${hex('ab')}::recorded::Type`
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

describe('buildPlanTx — one action per strategy', () => {
  const action = addMembersAction(PKGS, [ALICE])

  it('own-execute: payload → submit_vote_execute → domain execute', () => {
    const tx = buildPlanTx('own-execute', action, ctx, PKGS.armature)
    expect(commandNames(tx)).toEqual([
      'batch_add_members::new',
      'board_voting::submit_vote_execute',
      'member_ops::execute_batch_add_members',
    ])
    // The type ARGUMENT is fully qualified even though the type_key is bare.
    expect(typeArgs(tx)[1]).toEqual([
      `${PROPOSALS}::batch_add_members::BatchAddMembers`,
    ])
    // submit_vote_execute belongs to the framework, the rest to proposals.
    expect(packages(tx)).toEqual([PROPOSALS, ARMATURE, PROPOSALS])
  })

  it('own-propose: payload → submit_proposal, and no execute', () => {
    const tx = buildPlanTx('own-propose', action, ctx, PKGS.armature)
    expect(commandNames(tx)).toEqual([
      'batch_add_members::new',
      'board_voting::submit_proposal',
    ])
  })

  it('control-execute: control payload → parent vote → subdao execute', () => {
    const tx = buildPlanTx('control-execute', action, ctx, PKGS.armature)
    expect(commandNames(tx)).toEqual([
      'controller_batch_add_members::new',
      'board_voting::submit_vote_execute',
      'subdao_ops::execute_controller_batch_add_members',
    ])
  })

  it('control-propose: control payload → parent proposal', () => {
    const tx = buildPlanTx('control-propose', action, ctx, PKGS.armature)
    expect(commandNames(tx)).toEqual([
      'controller_batch_add_members::new',
      'board_voting::submit_proposal',
    ])
  })

  it('refuses a strategy the action cannot carry, with a typed error', () => {
    const ownOnly = setBoardAction(PKGS, [ALICE])
    expect(() =>
      buildPlanTx('control-execute', ownOnly, ctx, PKGS.armature),
    ).toThrow(expect.objectContaining({ code: TriexError.ValidationFailed }))

    const controlOnly = removeMembersAction(PKGS, [ALICE])
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
    expect(actions).toHaveLength(9) // the non-coin-pool trading types
    const tx = buildBatchPlanTx('own-execute', actions, ctx, PKGS.armature)
    // Four commands per action — the ProposalConfig is constructed inline as
    // part of the payload, so it is not free.
    expect(commandNames(tx)).toHaveLength(actions.length * 4)
    expect(commandNames(tx).slice(0, 4)).toEqual([
      'proposal::new_config',
      'enable_proposal_type::new',
      'board_voting::submit_vote_execute',
      'admin_ops::execute_enable_proposal_type',
    ])
    // Each enable binds its own concrete Move type on the execute call.
    expect(typeArgs(tx)[3]).toEqual([
      `${TRADING}::place_limit_order::PlaceLimitOrder<${CRED}>`,
    ])
  })
})

describe('buildCompositeSubmitTx', () => {
  const composable = () =>
    updateProposalConfigAction(PKGS, 'SetBoard', { quorum: 1 })

  it('opens a frame, adds a step per action, then submits once', () => {
    const tx = buildCompositeSubmitTx(
      [composable(), composable()],
      ctx,
      PKGS.armature,
    )
    expect(commandNames(tx)).toEqual([
      'composite::new_frame',
      'update_proposal_config::new',
      'composite::add_step',
      'update_proposal_config::new',
      'composite::add_step',
      'composite::submit_composite',
    ])
    expect(typeArgs(tx)[2]).toEqual([
      `${PROPOSALS}::update_proposal_config::UpdateProposalConfig`,
    ])
  })

  it('refuses a control-only action — composites run the own pipeline', () => {
    expect(() =>
      buildCompositeSubmitTx(
        [composable(), removeMembersAction(PKGS, [ALICE])],
        ctx,
        PKGS.armature,
      ),
    ).toThrow(expect.objectContaining({ code: TriexError.ValidationFailed }))
  })
})

describe('buildExecutePassedTx', () => {
  it('takes the ticket from the recorded vote, then runs the same handler', () => {
    const tx = buildExecutePassedTx({
      action: setBoardAction(PKGS, [ALICE]),
      armature: PKGS.armature,
      daoId: CHILD,
      proposalId: PROPOSAL,
      emergencyFreezeId: CHILD_FREEZE,
    })
    expect(commandNames(tx)).toEqual([
      'board_voting::ticket_from_vote',
      'board_ops::execute_set_board',
    ])
    expect(typeArgs(tx)[0]).toEqual([`${PROPOSALS}::set_board::SetBoard`])
  })

  it('refuses an action with no own adapter', () => {
    expect(() =>
      buildExecutePassedTx({
        action: removeMembersAction(PKGS, [ALICE]),
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
    // The outer ticket is the composite payload, each step its own type.
    expect(typeArgs(tx)[0]).toEqual([
      `${ARMATURE}::composite::CompositePayload`,
    ])
    expect(typeArgs(tx)[2]).toEqual([
      `${PROPOSALS}::update_proposal_config::UpdateProposalConfig`,
    ])
  })

  it('prefers the on-chain recorded step type over the adapter default', () => {
    const step = compositeStepExecutor(
      PKGS,
      'UpdateProposalConfig',
      RECORDED_STEP_TYPE,
    )!
    const tx = buildExecuteCompositeTx({
      armature: PKGS.armature,
      daoId: CHILD,
      proposalId: PROPOSAL,
      emergencyFreezeId: CHILD_FREEZE,
      frameId: FRAME,
      steps: [step],
    })
    expect(typeArgs(tx)[2]).toEqual([RECORDED_STEP_TYPE])
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
  const cfg = {
    quorum: 1,
    approvalThreshold: 5000,
    proposeThreshold: 0,
    expiryMs: 1,
    executionDelayMs: 0,
    cooldownMs: 0,
    composableAllowed: false,
  }

  it('attaches a lazy builder that matches the chosen strategy', () => {
    const plan = resolveExecutionPlan(
      addMembersAction(PKGS, [ALICE]),
      ctx,
      { ownConfig: cfg, controlConfig: null },
      ALICE,
      PKGS.armature,
    )
    expect(plan.blocked).toBe(false)
    if (plan.blocked) return
    expect(plan.strategy).toBe('own-execute')
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
            objectType: `${ARMATURE}::proposal::Proposal<${PROPOSALS}::set_board::SetBoard>`,
          },
        ],
      }),
    ).toBe('0xprop-id')
  })

  it('is undefined when the transaction created no proposal', () => {
    expect(
      extractCreatedProposalId({ digest: 'd', raw: {}, createdObjects: [] }),
    ).toBeUndefined()
  })
})

describe('action catalog details', () => {
  it('keys treasury withdrawals per coin — one Move type per key on-chain', () => {
    expect(sendCoinTypeKey(CRED)).toBe(`SendCoin<${CRED}>`)
    const a = enableSendCoinAction(PKGS, CRED)
    const tx = buildPlanTx('own-execute', a, ctx, PKGS.armature)
    // [0] new_config, [1] enable_proposal_type::new, [2] submit_vote_execute,
    // [3] the execute that binds the concrete SendCoin<Coin>.
    expect(typeArgs(tx)[3]).toEqual([
      `${PROPOSALS}::send_coin::SendCoin<${CRED}>`,
    ])
  })

  it('binds coin-pool order types only when a base coin is given', () => {
    const withoutBase = tradingTypeEntries(TRADING, CRED)
    expect(withoutBase.some((e) => e.typeKey.includes('_coin::'))).toBe(false)

    const withBase = tradingTypeEntries(TRADING, CRED, BASE)
    const coinOrder = withBase.find((e) =>
      e.typeKey.endsWith('place_limit_order_coin::PlaceLimitOrderCoin'),
    )
    // The KEY stays bare; the irreversible binding is in the Move TYPE.
    expect(coinOrder?.moveType).toBe(
      `${TRADING}::place_limit_order_coin::PlaceLimitOrderCoin<${BASE}, ${CRED}>`,
    )
  })

  it('skips types the unit already has enabled', () => {
    const all = tradingTypeEntries(TRADING, CRED)
    const actions = enableTradingActions(PKGS, {
      armatureTrading: TRADING,
      quoteType: CRED,
      alreadyEnabled: new Set(all.slice(0, 3).map((e) => e.typeKey)),
    })
    expect(actions).toHaveLength(all.length - 3)
  })

  it('metadata execute targets the Charter, not the DAO', () => {
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
    const inputs = tx.getData().inputs as any[]
    // The Charter object is an input; the child DAO is too (for the vote).
    const objectIds = inputs
      .map(
        (i) =>
          i?.UnresolvedObject?.objectId ??
          i?.Object?.ImmOrOwnedObject?.objectId,
      )
      .filter(Boolean)
    expect(objectIds).toContain(CHARTER)
  })

  it('recovers the executor for a passed proposal from its type key', () => {
    expect(
      passedProposalAction(PKGS, { typeKey: 'SetBoard' })?.own?.typeKey,
    ).toBe('SetBoard')
    // EnableProposalType recovers the coin from the target key in the payload.
    const enable = passedProposalAction(PKGS, {
      typeKey: 'EnableProposalType',
      payload: { type_key: `SendCoin<${CRED}>` },
    })
    expect(enable?.kind).toBe('enable_treasury_withdraw')
    const toDao = passedProposalAction(PKGS, {
      typeKey: 'EnableProposalType',
      payload: { type_key: `SendCoinToDAO<${CRED}>` },
    })
    expect(toDao?.kind).toBe('enable_treasury_send_to_dao')

    // CharterUpdate needs the Charter id to build its execute call.
    expect(passedProposalAction(PKGS, { typeKey: 'CharterUpdate' })).toBeNull()
    expect(
      passedProposalAction(PKGS, {
        typeKey: 'CharterUpdate',
        charterId: CHARTER,
      })?.kind,
    ).toBe('update_org_metadata')

    expect(passedProposalAction(PKGS, { typeKey: 'Unwired' })).toBeNull()
  })

  it('omitted config fields become on-chain nones', () => {
    const tx = buildPlanTx(
      'own-propose',
      updateProposalConfigAction(PKGS, 'SetBoard', { quorum: 1 }),
      ctx,
      PKGS.armature,
    )
    expect(commandNames(tx)).toEqual([
      'update_proposal_config::new',
      'board_voting::submit_proposal',
    ])
    // 1 type key + 7 options; each option is its own pure input.
    const pureInputs = (tx.getData().inputs as any[]).filter((i) => i?.Pure)
    expect(pureInputs.length).toBeGreaterThanOrEqual(8)
  })
})

/** The full ladder end-to-end: a real action, real configs, real transaction. */
describe('resolver → builder integration', () => {
  const enabled = {
    quorum: 1,
    approvalThreshold: 5000,
    proposeThreshold: 0,
    expiryMs: 1,
    executionDelayMs: 0,
    cooldownMs: 0,
    composableAllowed: false,
  }

  it('an officer adding members through the parent gets ONE transaction', () => {
    const plan = resolveExecutionPlan(
      addMembersAction(PKGS, [NEWBIE]),
      ctx,
      { ownConfig: null, controlConfig: enabled },
      CAROL, // on the parent board only
      PKGS.armature,
    )
    expect(plan.blocked).toBe(false)
    if (plan.blocked) return
    expect(plan.immediate).toBe(true)
    expect(commandNames(plan.buildTx())).toEqual([
      'controller_batch_add_members::new',
      'board_voting::submit_vote_execute',
      'subdao_ops::execute_controller_batch_add_members',
    ])
  })

  it('the same call becomes a proposal when quorum needs a real vote', () => {
    const plan = resolveExecutionPlan(
      addMembersAction(PKGS, [NEWBIE]),
      {
        ...ctx,
        parent: { ...ctx.parent!, board: [CAROL, hex('dd'), hex('ee')] },
      },
      { ownConfig: null, controlConfig: { ...enabled, quorum: 5000 } },
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

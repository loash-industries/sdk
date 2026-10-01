import { jest } from '@jest/globals'
import type { Transaction } from '@mysten/sui/transactions'

import {
  subOuControlType,
  updateProposalConfigAction,
} from '../src/armature/actions'
import { PERMISSIONS } from '../src/armature/governance'
import { OrgHandle } from '../src/armature/OrgClient'
import type { Org } from '../src/armature/types'
import { TriexError } from '../src/errors'
import { resolvePackageIds } from '../src/config'
import { mockOuChain, type SlotSpec, type UnitSpec } from './helpers/ouChain'

const hex = (pair: string) => `0x${pair.repeat(32)}`
const ROOT = hex('c1')
const OFFICERS = hex('c2')
const ALICE = hex('11')
const BOB = hex('22')
const STRANGER = hex('99')

const ids = resolvePackageIds('testnet')
const A = ids.armature
const P = ids.armatureProposals

const T = {
  batchAdd: `${A}::batch_add_members::BatchAddMembers`,
  batchRemove: `${A}::batch_remove_members::BatchRemoveMembers`,
  setBoard: `${A}::set_board::SetBoard`,
  metadata: `${A}::update_metadata::UpdateMetadata`,
  enable: `${A}::enable_proposal_type::EnableProposalType`,
  updateConfig: `${A}::update_proposal_config::UpdateProposalConfig`,
  composite: `${A}::composite_payload::CompositePayload`,
  ctrlAdd: `${P}::controller_batch_add_members::ControllerBatchAddMembers`,
  ctrlRemove: `${P}::controller_batch_remove_members::ControllerBatchRemoveMembers`,
  pause: `${P}::pause_execution::PauseSubOUExecution`,
}

/** tribe_setup's controller config: single-vote, VAULT_BORROW, SubOUControl scope. */
const controller = (moveType: string): SlotSpec => ({
  moveType,
  config: {
    approvalThreshold: 8000,
    permissions: PERMISSIONS.VAULT_BORROW,
    borrowScope: [subOuControlType(A)],
  },
})

function unit(orgId: string, over: Partial<Org> = {}): Org {
  return {
    orgId,
    charterId: null,
    treasuryId: null,
    capabilityVaultId: null,
    emergencyFreezeId: null,
    name: orgId,
    metadataUri: null,
    metadata: {},
    members: [],
    ous: [],
    tradingAccountId: null,
    subdaoControlCapId: null,
    ...over,
  }
}

/** Root (Alice) → officers (Alice + Bob), fully linked for the control path. */
function tree(): Org {
  return unit(ROOT, {
    emergencyFreezeId: hex('e1'),
    capabilityVaultId: hex('e2'),
    charterId: hex('e3'),
    members: [ALICE],
    ous: [
      unit(OFFICERS, {
        emergencyFreezeId: hex('e4'),
        capabilityVaultId: hex('e5'),
        charterId: hex('e6'),
        members: [ALICE, BOB],
        subdaoControlCapId: hex('e7'),
      }),
    ],
  })
}

interface HarnessOpts {
  /** Slots per unit (the boards default to the tree's). */
  slots?: { root?: SlotSpec[]; officers?: SlotSpec[] }
  units?: { root?: Partial<UnitSpec>; officers?: Partial<UnitSpec> }
  /** Extra objects (live proposals, frame fields). */
  objects?: Parameters<typeof mockOuChain>[1]
  address?: string
  seat?: string
  proposals?: unknown[]
  createdProposalId?: string
}

function harness(opts: HarnessOpts = {}) {
  const captured: { txs: Transaction[] } = { txs: [] }
  const chain = mockOuChain(
    {
      [ROOT]: {
        members: [ALICE],
        slots: opts.slots?.root ?? [],
        ...opts.units?.root,
      },
      [OFFICERS]: {
        members: [ALICE, BOB],
        controllerCapId: hex('e7'),
        slots: opts.slots?.officers ?? [],
        ...opts.units?.officers,
      },
    },
    opts.objects,
  )
  const getObject = jest.fn(chain.core.getObject)
  const executor = jest.fn(async (tx: unknown) => {
    captured.txs.push(tx as Transaction)
    return {
      digest: 'DIGEST1',
      objectChanges: opts.createdProposalId
        ? [
            {
              type: 'created',
              objectId: opts.createdProposalId,
              objectType: `${ids.armature}::proposal::Proposal<0x2::x::X>`,
            },
          ]
        : [],
    }
  })
  const proposals = jest.fn(async () => opts.proposals ?? [])
  const handle = new OrgHandle(
    {
      suiClient: { core: { ...chain.core, getObject } } as never,
      indexer: { orgs: { proposals } } as never,
      ids,
      requireExecutor: () => executor,
      address: opts.address ?? ALICE,
    },
    tree(),
    opts.seat,
  )
  return { handle, executor, getObject, proposals, captured }
}

function commandNames(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.map((c: any) =>
      c.$kind === 'MoveCall'
        ? `${c.MoveCall.module}::${c.MoveCall.function}`
        : c.$kind,
    )
}

describe('OrgHandle seats', () => {
  it('defaults to the caller’s highest-authority seat', () => {
    const { handle } = harness()
    expect(handle.orgId).toBe(ROOT)
    expect(handle.seats.map((s) => s.daoId)).toEqual([ROOT, OFFICERS])
    expect(handle.seat?.daoId).toBe(ROOT)
  })

  it('honours an explicitly requested seat', () => {
    const { handle } = harness({ seat: OFFICERS })
    expect(handle.seat?.daoId).toBe(OFFICERS)
  })

  it('as() throws for a seat the caller does not hold', () => {
    const { handle } = harness({ address: BOB })
    expect(handle.seats.map((s) => s.daoId)).toEqual([OFFICERS])
    expect(() => handle.as(ROOT)).toThrow(
      expect.objectContaining({ code: TriexError.ValidationFailed }),
    )
    expect(handle.as(OFFICERS).seat?.daoId).toBe(OFFICERS)
  })

  it('a caller with no seat fails only when it tries to act', () => {
    const { handle } = harness({ address: STRANGER })
    expect(handle.seat).toBeNull()
    expect(() => handle.requireSeat()).toThrow(
      expect.objectContaining({ code: TriexError.ValidationFailed }),
    )
  })
})

describe('governance.run — outcome shaping', () => {
  it('executes (read-only entry) when a single vote clears', async () => {
    const { handle, executor, captured } = harness({
      seat: OFFICERS,
      slots: { officers: [{ moveType: T.batchAdd }] },
    })
    const outcome = await handle.members.add([STRANGER])

    expect(outcome).toEqual({ status: 'executed', digest: 'DIGEST1' })
    expect(executor).toHaveBeenCalledTimes(1)
    expect(commandNames(captured.txs[0])).toEqual([
      'batch_add_members::new',
      'board_voting::submit_vote_execute_readonly',
      'member_ops::execute_batch_add_members',
    ])
  })

  it('proposes and returns the created proposal id from effects', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      // Board of 2 at 6600bps: 13200 > 10000, so no lone vote passes.
      slots: { officers: [{ moveType: T.batchAdd, config: { quorum: 6600 } }] },
      createdProposalId: hex('7a'),
    })
    const outcome = await handle.members.add([STRANGER])

    expect(outcome).toEqual({
      status: 'proposed',
      digest: 'DIGEST1',
      proposalId: hex('7a'),
    })
    expect(commandNames(captured.txs[0])).toEqual([
      'batch_add_members::new',
      'board_voting::submit_proposal',
    ])
  })

  it('returns blocked as a VALUE and never touches the executor', async () => {
    const { handle, executor } = harness({ address: BOB, seat: OFFICERS })
    const outcome = await handle.members.add([STRANGER])
    expect(outcome).toMatchObject({ status: 'blocked', code: 'not-permitted' })
    expect(executor).not.toHaveBeenCalled()
  })

  it('routes a sub-unit removal through the parent’s control cap', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      slots: { root: [controller(T.ctrlRemove)] },
    })
    const outcome = await handle.members.remove([BOB])

    expect(outcome).toMatchObject({ status: 'executed' })
    expect(commandNames(captured.txs[0])).toEqual([
      'controller_batch_remove_members::new',
      'board_voting::submit_vote_execute_readonly',
      'subou_ops::execute_controller_batch_remove_members',
    ])
  })

  it('a root unit removes its own members now — BatchRemoveMembers is a default slot', async () => {
    const { handle, captured } = harness({
      slots: { root: [{ moveType: T.batchRemove }] },
    })
    expect(await handle.members.remove([ALICE])).toMatchObject({
      status: 'executed',
    })
    expect(commandNames(captured.txs[0])[2]).toBe(
      'member_ops::execute_batch_remove_members',
    )
  })

  it('acts ON a child the caller does not sit on, through the parent (unitId)', async () => {
    // Carol-less: Alice sits on the root only for this test.
    const { handle, captured } = harness({
      slots: { root: [controller(T.pause)] },
      units: { officers: { members: [BOB] } },
    })
    const outcome = await handle.units.pause({ unitId: OFFICERS })
    expect(outcome).toMatchObject({ status: 'executed' })
    expect(commandNames(captured.txs[0])).toEqual([
      'pause_execution::new_pause',
      'board_voting::submit_vote_execute_readonly',
      'subou_ops::execute_pause_subou_execution',
    ])
  })

  it('blocks with missing-permissions when the controller slot lacks its bits', async () => {
    const { handle, executor } = harness({
      seat: OFFICERS,
      slots: { root: [{ moveType: T.ctrlRemove }] }, // enabled, but no bits
    })
    expect(await handle.members.remove([BOB])).toMatchObject({
      status: 'blocked',
      code: 'missing-permissions',
    })
    expect(executor).not.toHaveBeenCalled()
  })

  it('a paused unit proposes instead of executing', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      slots: { officers: [{ moveType: T.batchAdd }] },
      units: { officers: { controllerPaused: true } },
    })
    expect(await handle.members.add([STRANGER])).toMatchObject({
      status: 'proposed',
    })
    expect(commandNames(captured.txs[0])[1]).toBe(
      'board_voting::submit_proposal',
    )
  })
})

describe('runBatch', () => {
  it('rejects a cart whose actions resolve to different strategies (OQ-A11)', async () => {
    const { handle, executor } = harness({
      seat: OFFICERS,
      slots: {
        // metadata → own-execute on the officers unit …
        officers: [{ moveType: T.metadata, displayKey: 'CharterUpdate' }],
        // … member add → control-execute on the root (no own slot below).
        root: [controller(T.ctrlAdd)],
      },
    })
    const { addMembersAction, updateMetadataAction } =
      await import('../src/armature/actions')
    await expect(
      handle.governance.runBatch([
        updateMetadataAction(handle.pkgs(), 'ipfs://x', hex('e6')),
        addMembersAction(handle.pkgs(), [STRANGER]),
      ]),
    ).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
      message: expect.stringContaining('control-execute'),
    })
    expect(executor).not.toHaveBeenCalled()
  })
})

describe('governance reads', () => {
  it('caches each unit’s chain state for the handle’s life, and refresh() clears it', async () => {
    const { handle, getObject } = harness({
      seat: OFFICERS,
      slots: { officers: [{ moveType: T.batchAdd }, { moveType: T.setBoard }] },
    })
    await handle.governance.read()
    await handle.governance.read()
    await handle.governance.resolve({
      kind: 'x',
      own: {
        typeKey: 'SetBoard',
        payloadMoveType: T.setBoard,
        buildPayload: () => ({}) as never,
        buildExecute: () => undefined,
      },
    })
    // OU root + its EmergencyFreeze, once each.
    expect(getObject).toHaveBeenCalledTimes(2)

    handle.refresh()
    await handle.governance.read()
    expect(getObject).toHaveBeenCalledTimes(4)
  })

  it('paths() explains every strategy, viable or not', async () => {
    const { handle } = harness({ seat: OFFICERS })
    const paths = await handle.governance.paths({
      kind: 'x',
      own: {
        typeKey: 'Nope',
        payloadMoveType: '0x2::a::A',
        buildPayload: () => ({}) as never,
        buildExecute: () => undefined,
      },
    })
    expect(paths).toHaveLength(4)
    expect(paths[0].detail).toBe('type not enabled on that unit')
  })
})

/** An UpdateProposalConfig action — composes through the typed step entry. */
const configAction = (handle: OrgHandle, typeKey: string, quorum: number) =>
  updateProposalConfigAction(handle.pkgs(), typeKey, { quorum })

describe('composite', () => {
  const composable: SlotSpec[] = [
    { moveType: T.composite, displayKey: 'Composite' },
    { moveType: T.updateConfig, config: { composableAllowed: true } },
  ]

  it('bundles eligible actions into ONE proposal', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      slots: { officers: composable },
      createdProposalId: hex('7b'),
    })
    const outcome = await handle.governance.runComposite([
      configAction(handle, 'SetBoard', 1),
      configAction(handle, 'BatchAddMembers', 1),
    ])

    expect(outcome).toMatchObject({ status: 'proposed', proposalId: hex('7b') })
    expect(commandNames(captured.txs[0])).toEqual([
      'composite::new_frame',
      'update_proposal_config::new',
      'composite::add_update_proposal_config_step',
      'update_proposal_config::new',
      'composite::add_update_proposal_config_step',
      'composite::submit_composite',
    ])
  })

  it('refuses an ineligible cart with the on-chain reason', async () => {
    const { handle, executor } = harness({
      seat: OFFICERS,
      slots: { officers: [{ moveType: T.updateConfig }] }, // no Composite slot
    })
    await expect(
      handle.governance.runComposite([
        configAction(handle, 'A', 1),
        configAction(handle, 'B', 1),
      ]),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    expect(executor).not.toHaveBeenCalled()
  })
})

describe('vote / execute / cleanup', () => {
  const PROPOSAL = hex('7c')
  const FRAME = hex('7d')
  const summary = (over: Record<string, unknown> = {}) => ({
    proposalId: PROPOSAL,
    orgId: OFFICERS,
    typeKey: 'SetBoard',
    proposer: ALICE,
    status: 'passed',
    yesWeight: 2,
    noWeight: 0,
    payloadType: T.setBoard,
    frameId: null,
    createdCheckpoint: 1,
    ...over,
  })
  /** A live `Proposal<P>` object (gRPC JSON shape). */
  const live = (
    payloadType: string,
    payload: Record<string, unknown> = {},
  ) => ({
    [PROPOSAL]: {
      type: `${A}::proposal::Proposal<${payloadType}>`,
      json: {
        ou_id: OFFICERS,
        type_key: 'X',
        proposer: ALICE,
        metadata_ipfs: null,
        payload,
        snapshot_version: '1',
        total_snapshot_weight: '2',
        votes_cast: { contents: [{ key: ALICE, value: true }] },
        yes_weight: '2',
        no_weight: '0',
        config: {
          quorum: 5000,
          approval_threshold: 5000,
          propose_threshold: '0',
          expiry_ms: '1000',
          execution_delay_ms: '0',
          cooldown_ms: '0',
          composable_allowed: false,
          permissions: '0',
          borrow_scope: [],
        },
        created_at_ms: '0',
        passed_at_ms: '10',
        status: { '@variant': 'Passed' },
      },
    },
  })

  it('reads the payload type and OU from the live object, and votes via board_voting', async () => {
    const { handle, proposals, captured } = harness({
      seat: OFFICERS,
      objects: live(T.setBoard),
    })
    await handle.governance.vote({ proposalId: PROPOSAL, approve: true })
    expect(proposals).not.toHaveBeenCalled()
    expect(commandNames(captured.txs[0])).toEqual(['board_voting::vote'])
  })

  it('falls back to the indexer when the object is not readable', async () => {
    const { handle, proposals, captured } = harness({
      seat: OFFICERS,
      proposals: [summary({ status: 'pending' })],
    })
    await handle.governance.vote({ proposalId: PROPOSAL, approve: false })
    expect(proposals).toHaveBeenCalled()
    expect(commandNames(captured.txs[0])).toEqual(['board_voting::vote'])
  })

  it('says plainly when a proposal was already executed (deleted on-chain)', async () => {
    const { handle } = harness({
      seat: OFFICERS,
      proposals: [summary({ status: 'executed' })],
    })
    await expect(
      handle.governance.vote({ proposalId: PROPOSAL, approve: true }),
    ).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
      message: expect.stringContaining('already executed'),
    })
  })

  it('says so plainly when a proposal is not indexed yet', async () => {
    const { handle } = harness({ seat: OFFICERS, proposals: [] })
    await expect(
      handle.governance.vote({ proposalId: PROPOSAL, approve: true }),
    ).rejects.toMatchObject({
      code: TriexError.OrgNotFound,
      message: expect.stringContaining('may not be indexed yet'),
    })
  })

  it('executes a passed proposal by its payload type', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      slots: { officers: [{ moveType: T.setBoard }] },
      objects: live(T.setBoard),
    })
    await handle.governance.execute(PROPOSAL)
    expect(commandNames(captured.txs[0])).toEqual([
      'board_voting::ticket_from_vote_readonly',
      'board_ops::execute_set_board',
    ])
  })

  it('runs a passed composite as a whole pipeline', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      objects: live(T.composite, {
        frame_id: FRAME,
        step_type_keys: ['UpdateProposalConfig'],
        step_types: [{ name: T.updateConfig.slice(2) }],
      }),
    })
    await handle.governance.execute(PROPOSAL, { deleteFrame: true })
    expect(commandNames(captured.txs[0])).toEqual([
      'board_voting::ticket_from_vote',
      'composite::begin_pipeline',
      'composite::advance_step',
      'admin_ops::execute_update_proposal_config',
      'composite::finalize_pipeline',
      'composite::delete_exhausted_frame',
    ])
  })

  it('refuses a partial pipeline when a step has no wired executor', async () => {
    const { handle, executor } = harness({
      seat: OFFICERS,
      proposals: [
        summary({
          typeKey: 'Composite',
          payloadType: T.composite,
          frameId: FRAME,
          composite: [{ stepIndex: 0, stepTypeKey: 'Unwired', stepType: null }],
        }),
      ],
    })
    await expect(handle.governance.execute(PROPOSAL)).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
      message: expect.stringContaining('partial pipeline'),
    })
    expect(executor).not.toHaveBeenCalled()
  })

  it('refuses to execute a type with no wired executor, naming why', async () => {
    const { handle } = harness({
      seat: OFFICERS,
      objects: live(`${hex('77')}::x::Unwired`),
    })
    await expect(handle.governance.execute(PROPOSAL)).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
      message: expect.stringContaining('no wired executor'),
    })
  })

  it('deletes expired proposals permissionlessly', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      objects: live(T.setBoard),
    })
    await handle.governance.deleteExpired({ proposalIds: [PROPOSAL] })
    expect(commandNames(captured.txs[0])).toEqual([
      'proposal::delete_expired_proposal',
    ])
  })

  it('expired() lists only proposals whose window has closed', async () => {
    const { handle } = harness({
      seat: OFFICERS,
      proposals: [summary({ status: 'passed' })],
      objects: live(T.setBoard),
    })
    // passed_at 10 + delay 0 + expiry 1000 → closed long ago.
    const out = await handle.governance.expired()
    expect(out.map((p) => p.proposalId)).toEqual([PROPOSAL])
    expect(out[0].status).toBe('passed')
  })
})

describe('types', () => {
  it('enableTrading enables only what is missing, in one transaction', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      slots: { officers: [{ moveType: T.enable }] },
    })
    const outcome = await handle.types.enableTrading()
    expect(outcome).toMatchObject({ status: 'executed' })
    const names = commandNames(captured.txs[0])
    expect(
      names.filter((n) => n === 'admin_ops::execute_enable_proposal_type'),
    ).toHaveLength(9)
    // DepositCoinToBook and CreateMulticoinPool carry the treasury bit.
    expect(
      names.filter((n) => n === 'proposal::with_permissions'),
    ).toHaveLength(2)
  })

  it('enableTrading refuses when there is nothing left to enable', async () => {
    const all = [
      'setup_trading_account::SetupTradingAccount',
      'deposit_coin_to_book::DepositCoinToBook<CRED>',
      'deposit_from_ou_vault_to_book::DepositFromOuVaultToBook',
      'place_limit_order::PlaceLimitOrder<CRED>',
      'place_market_order::PlaceMarketOrder<CRED>',
      'cancel_order::CancelOrder<CRED>',
      'create_multicoin_pool::CreateMulticoinPool<CRED>',
      'sweep_coin_to_treasury::SweepCoinToTreasury<CRED>',
      'sweep_multicoin_to_ou_vault::SweepMulticoinToOuVault',
    ].map((t) => ({
      moveType: `${ids.armatureTrading}::${t.replace('CRED', ids.credCoinType)}`,
    }))
    const { handle } = harness({
      seat: OFFICERS,
      slots: { officers: [{ moveType: T.enable }, ...all] },
    })
    await expect(handle.types.enableTrading()).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
      message: expect.stringContaining('already enabled'),
    })
  })

  it('enableComposite refuses — Composite is a default slot', async () => {
    const { handle } = harness({
      seat: OFFICERS,
      slots: { officers: [{ moveType: T.composite, displayKey: 'Composite' }] },
    })
    await expect(handle.types.enableComposite()).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
    })
  })
})

describe('metadata.update', () => {
  it('uses the seat’s charter (slot found by type, whatever its key)', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      slots: {
        officers: [{ moveType: T.metadata, displayKey: 'CharterUpdate' }],
      },
    })
    await handle.metadata.update({ metadataUri: 'ipfs://new' })
    expect(commandNames(captured.txs[0])).toEqual([
      'update_metadata::new',
      'board_voting::submit_vote_execute_readonly',
      'admin_ops::execute_update_metadata',
    ])
  })
})

describe('entries (member-gated, no vote)', () => {
  it('publishes straight to the OU, no governance', async () => {
    const { handle, captured } = harness({ seat: OFFICERS })
    await handle.entries.publish({ location: 'walrus://b', description: 'd' })
    expect(commandNames(captured.txs[0])).toEqual([
      'encrypted_entry::publish_entry',
    ])
  })
})

import { jest } from '@jest/globals'
import type { Transaction } from '@mysten/sui/transactions'

import { updateProposalConfigAction } from '../src/armature/actions'
import { OrgHandle } from '../src/armature/OrgClient'
import type { Org } from '../src/armature/types'
import { TriexError } from '../src/errors'
import { resolvePackageIds } from '../src/config'

const hex = (pair: string) => `0x${pair.repeat(32)}`
const ROOT = hex('c1')
const OFFICERS = hex('c2')
const ALICE = hex('11')
const BOB = hex('22')
const STRANGER = hex('99')

const ids = resolvePackageIds('testnet')

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
    balanceManagerId: null,
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

const cfg = (over: Record<string, unknown> = {}) => ({
  quorum: 1,
  approval_threshold: 5000,
  propose_threshold: '0',
  expiry_ms: '3600000',
  execution_delay_ms: '0',
  cooldown_ms: '0',
  composable_allowed: false,
  ...over,
})

/** A DAO object whose enabled types all share one config. */
function daoJson(typeKeys: string[], override: Record<string, unknown> = {}) {
  return {
    enabled_proposal_types: { contents: typeKeys },
    proposal_configs: {
      contents: typeKeys.map((key) => ({
        key,
        value: cfg(override[key] as any),
      })),
    },
    type_bindings: { contents: [] },
  }
}

interface HarnessOpts {
  /** DAO id → its object json. */
  daos?: Record<string, unknown>
  address?: string
  seat?: string
  proposals?: unknown[]
  createdProposalId?: string
}

function harness(opts: HarnessOpts = {}) {
  const captured: { txs: Transaction[] } = { txs: [] }
  const getObject = jest.fn(async ({ objectId }: any) => ({
    object: { json: (opts.daos ?? {})[objectId] ?? {} },
  }))
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
      suiClient: { core: { getObject } } as never,
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
  it('executes and reports the digest when a single vote clears', async () => {
    const { handle, executor, captured } = harness({
      seat: OFFICERS,
      daos: { [OFFICERS]: daoJson(['BatchAddMembers']) },
    })
    const outcome = await handle.members.add([STRANGER])

    expect(outcome).toEqual({ status: 'executed', digest: 'DIGEST1' })
    expect(executor).toHaveBeenCalledTimes(1)
    expect(commandNames(captured.txs[0])).toEqual([
      'batch_add_members::new',
      'board_voting::submit_vote_execute',
      'member_ops::execute_batch_add_members',
    ])
  })

  it('proposes and returns the created proposal id from effects', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      // Board of 2 at 6600bps: 13200 > 10000, so no lone vote passes.
      daos: {
        [OFFICERS]: daoJson(['BatchAddMembers'], {
          BatchAddMembers: { quorum: 6600 },
        }),
      },
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
    const { handle, executor } = harness({
      address: BOB,
      seat: OFFICERS,
      daos: { [OFFICERS]: daoJson([]) }, // nothing enabled
    })
    const outcome = await handle.members.add([STRANGER])

    expect(outcome).toMatchObject({ status: 'blocked', code: 'not-permitted' })
    expect(executor).not.toHaveBeenCalled()
  })

  it('routes a sub-DAO removal through the parent’s control cap', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      daos: {
        [ROOT]: daoJson(['ControllerBatchRemoveMembers']),
        [OFFICERS]: daoJson([]),
      },
    })
    const outcome = await handle.members.remove([BOB])

    expect(outcome).toMatchObject({ status: 'executed' })
    expect(commandNames(captured.txs[0])).toEqual([
      'controller_batch_remove_members::new',
      'board_voting::submit_vote_execute',
      'subdao_ops::execute_controller_batch_remove_members',
    ])
  })

  it('blocks a removal on the root unit — there is no parent to act through', async () => {
    const { handle } = harness({
      daos: { [ROOT]: daoJson(['ControllerBatchRemoveMembers']) },
    })
    expect(await handle.members.remove([ALICE])).toMatchObject({
      status: 'blocked',
    })
  })
})

describe('governance reads', () => {
  it('caches each DAO object for the handle’s life, and refresh() clears it', async () => {
    const { handle, getObject } = harness({
      seat: OFFICERS,
      daos: { [OFFICERS]: daoJson(['BatchAddMembers', 'SetBoard']) },
    })
    await handle.governance.read()
    await handle.governance.read()
    await handle.governance.resolve({
      kind: 'x',
      own: {
        typeKey: 'SetBoard',
        payloadMoveType: '0x2::a::A',
        buildPayload: () => ({}) as never,
        buildExecute: () => undefined,
      },
    })
    expect(getObject).toHaveBeenCalledTimes(1)

    handle.refresh()
    await handle.governance.read()
    expect(getObject).toHaveBeenCalledTimes(2)
  })

  it('paths() explains every strategy, viable or not', async () => {
    const { handle } = harness({
      seat: OFFICERS,
      daos: { [OFFICERS]: daoJson([]) },
    })
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
    expect(paths[0].detail).toBe('type not enabled on that DAO')
  })
})

/** An UpdateProposalConfig action — the only composable-wired type today. */
const configAction = (handle: OrgHandle, typeKey: string, quorum: number) =>
  updateProposalConfigAction(handle.pkgs(), typeKey, { quorum })

describe('composite', () => {
  const composableDao = daoJson(['Composite', 'UpdateProposalConfig'], {
    UpdateProposalConfig: { composable_allowed: true },
  })

  it('bundles eligible actions into ONE proposal', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      daos: { [OFFICERS]: composableDao },
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
      'composite::add_step',
      'update_proposal_config::new',
      'composite::add_step',
      'composite::submit_composite',
    ])
  })

  it('refuses an ineligible cart with the on-chain reason', async () => {
    const { handle, executor } = harness({
      seat: OFFICERS,
      daos: { [OFFICERS]: daoJson(['UpdateProposalConfig']) }, // no Composite
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

describe('vote / execute', () => {
  const PROPOSAL = hex('7c')
  const summary = (over: Record<string, unknown> = {}) => ({
    proposalId: PROPOSAL,
    orgId: OFFICERS,
    typeKey: 'SetBoard',
    proposer: ALICE,
    status: 'passed',
    yesWeight: 2,
    noWeight: 0,
    payloadType: `${ids.armatureProposals}::set_board::SetBoard`,
    frameId: null,
    createdCheckpoint: 1,
    ...over,
  })

  it('looks the payload type up from the indexer when not given', async () => {
    const { handle, proposals, captured } = harness({
      seat: OFFICERS,
      proposals: [summary()],
    })
    await handle.governance.vote({ proposalId: PROPOSAL, approve: true })
    expect(proposals).toHaveBeenCalled()
    expect(commandNames(captured.txs[0])).toEqual(['proposal::vote'])
  })

  it('skips the lookup when the payload type is supplied', async () => {
    const { handle, proposals } = harness({ seat: OFFICERS })
    await handle.governance.vote({
      proposalId: PROPOSAL,
      approve: false,
      payloadType: '0x2::a::A',
    })
    expect(proposals).not.toHaveBeenCalled()
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

  it('executes a passed proposal through the same handler', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      proposals: [summary()],
    })
    await handle.governance.execute(PROPOSAL)
    expect(commandNames(captured.txs[0])).toEqual([
      'board_voting::ticket_from_vote',
      'board_ops::execute_set_board',
    ])
  })

  it('runs a passed composite as a whole pipeline', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      proposals: [
        summary({
          typeKey: 'Composite',
          frameId: hex('7d'),
          composite: [
            {
              stepIndex: 0,
              stepTypeKey: 'UpdateProposalConfig',
              stepType: null,
            },
          ],
        }),
      ],
    })
    await handle.governance.execute(PROPOSAL)
    expect(commandNames(captured.txs[0])).toEqual([
      'board_voting::ticket_from_vote',
      'composite::begin_pipeline',
      'composite::advance_step',
      'admin_ops::execute_update_proposal_config',
      'composite::finalize_pipeline',
    ])
  })

  it('refuses a partial pipeline when a step has no wired executor', async () => {
    const { handle, executor } = harness({
      seat: OFFICERS,
      proposals: [
        summary({
          typeKey: 'Composite',
          frameId: hex('7d'),
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

  it('refuses to execute a type with no wired executor', async () => {
    const { handle } = harness({
      seat: OFFICERS,
      proposals: [summary({ typeKey: 'SomethingUnwired' })],
    })
    await expect(handle.governance.execute(PROPOSAL)).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
    })
  })
})

describe('types.enableTrading', () => {
  it('enables only what is missing, in one transaction', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      daos: { [OFFICERS]: daoJson(['EnableProposalType']) },
    })
    const outcome = await handle.types.enableTrading()
    expect(outcome).toMatchObject({ status: 'executed' })
    // 9 non-coin-pool trading types × 4 commands each.
    expect(commandNames(captured.txs[0])).toHaveLength(36)
  })

  it('refuses when there is nothing left to enable', async () => {
    const all = [
      'EnableProposalType',
      ...[
        'place_limit_order::PlaceLimitOrder',
        'cancel_order::CancelOrder',
        'deposit_coin_to_book::DepositCoinToBook',
        'sweep_coin_to_treasury::SweepCoinToTreasury',
        'setup_trading_account::SetupTradingAccount',
        'deposit_multicoin_to_book::DepositMulticoinToBook',
        'deposit_from_dao_vault_to_book::DepositFromDaoVaultToBook',
        'sweep_multicoin_to_treasury::SweepMulticoinToTreasury',
        'sweep_multicoin_to_dao_vault::SweepMulticoinToDaoVault',
      ].map((t) => `${ids.armatureTrading}::${t}`),
    ]
    const { handle } = harness({
      seat: OFFICERS,
      daos: { [OFFICERS]: daoJson(all) },
    })
    await expect(handle.types.enableTrading()).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
      message: expect.stringContaining('already enabled'),
    })
  })
})

describe('metadata.update', () => {
  it('uses the seat’s charter and refuses when there is none', async () => {
    const { handle, captured } = harness({
      seat: OFFICERS,
      daos: { [OFFICERS]: daoJson(['CharterUpdate']) },
    })
    await handle.metadata.update({ metadataUri: 'ipfs://new' })
    expect(commandNames(captured.txs[0])).toEqual([
      'update_metadata::new',
      'board_voting::submit_vote_execute',
      'admin_ops::execute_update_metadata',
    ])
  })
})

/**
 * Executing passed proposals: `executorForPayload` dispatches by payload type
 * to the handler that consumes the ticket. Every wired payload type is run
 * with a full context (it must append its handler call) and with an empty
 * one (it must name what is missing, not build half a transaction).
 */
import { Transaction } from '@mysten/sui/transactions'

import {
  compositeStepExecutor,
  executorForPayload,
  passedProposalAction,
  type PassedExecutionContext,
} from '../src/armature/executors'
import type { OrgNode } from '../src/armature/types'
import { resolvePackageIds } from '../src/config'

const hex = (pair: string) => `0x${pair.repeat(32)}`
const ids = resolvePackageIds('testnet')
const pkgs = {
  armature: ids.armature,
  armatureProposals: ids.armatureProposals,
} as PassedExecutionContext['pkgs']
const COIN = `${hex('ab')}::gold::GOLD`
const UNIT = hex('c1')
const CHILD = hex('c2')
const CONTROL = hex('e7')
const CAP = hex('ca')

/** Every payload path `executorForPayload` wires, by module::Struct. */
const WIRED = [
  'set_board::SetBoard',
  'add_member::AddMember',
  'remove_member::RemoveMember',
  'batch_add_members::BatchAddMembers',
  'batch_remove_members::BatchRemoveMembers',
  'update_metadata::UpdateMetadata',
  'enable_proposal_type::EnableProposalType',
  'disable_proposal_type::DisableProposalType',
  'update_proposal_config::UpdateProposalConfig',
  'enable_bypass_type::EnableBypassType',
  'disable_bypass_type::DisableBypassType',
  'unfreeze_proposal_type::UnfreezeProposalType',
  'update_freeze_config::UpdateFreezeConfig',
  'update_freeze_exempt_types::UpdateFreezeExemptTypes',
  'transfer_freeze_admin::TransferFreezeAdmin',
  'send_coin::SendCoin',
  'send_coin_to_ou::SendCoinToOU',
  'send_small_payment::SendSmallPayment',
  'controller_batch_add_members::ControllerBatchAddMembers',
  'controller_batch_remove_members::ControllerBatchRemoveMembers',
  'pause_execution::PauseSubOUExecution',
  'pause_execution::UnpauseSubOUExecution',
  'create_subou::CreateSubOU',
  'spawn_ou::SpawnOU',
  'spin_out_subou::SpinOutSubOU',
  'transfer_cap_to_subou::TransferCapToSubOU',
  'reclaim_cap_from_subou::ReclaimCapFromSubOU',
  'transfer_assets::TransferAssets',
  'adopt_currency::AdoptCurrency',
  'mint_coin::MintCoin',
  'mint_allowance::MintAllowance',
  'configure_mint_allowance::ConfigureMintAllowance',
  'burn_coin::BurnCoin',
  'return_currency_cap::ReturnCurrencyCap',
  'propose_upgrade::ProposeUpgrade',
]

/** Generic payloads take the coin type; the rest are plain. */
const GENERIC =
  /SendCoin|SendCoinToOU|SendSmallPayment|AdoptCurrency|MintCoin|MintAllowance|ConfigureMintAllowance|BurnCoin|ReturnCurrencyCap/

const child: OrgNode = {
  daoId: CHILD,
  parentDaoId: UNIT,
  depth: 1,
  childDaoIds: [],
  name: 'child',
  charterId: hex('d1'),
  treasuryId: hex('d2'),
  capabilityVaultId: hex('d3'),
  emergencyFreezeId: hex('d4'),
  members: [],
  tradingAccountId: null,
  subdaoControlCapId: CONTROL,
  roleKey: 'officer',
  roleLabel: 'Officers',
  rank: 1,
}

const fullContext = (): Omit<PassedExecutionContext, 'pkgs'> => ({
  unit: {
    daoId: UNIT,
    charterId: hex('e3'),
    treasuryId: hex('e8'),
    capabilityVaultId: hex('e2'),
    emergencyFreezeId: hex('e1'),
  },
  nodes: [child],
  payload: {
    type_name: { name: `${hex('aa')}::x::Y` },
    type_key: 'Y',
    control_id: CONTROL,
    subou_id: CHILD,
    target_subou: CHILD,
    target_treasury_id: hex('d2'),
    recipient_treasury: hex('d2'),
    target_vault_id: hex('d3'),
    cap_id: CAP,
    cap_ids: [CAP],
    coin_types: [{ name: COIN }],
    package_id: hex('dd'),
  },
  typeForDisplayKey: () => `${hex('aa')}::x::Y`,
  capTypeOf: () => `${ids.armature}::x::Cap`,
  freezeAdminCapId: hex('fa'),
  treasuryCapId: CAP,
  upgrade: { modules: ['AAAA'], dependencies: [hex('02')] },
})

/** The payload's full Move type, under whichever package wires it. */
function payloadType(path: string): string | null {
  for (const pkg of [ids.armature, ids.armatureProposals]) {
    const type = GENERIC.test(path)
      ? `${pkg}::${path}<${COIN}>`
      : `${pkg}::${path}`
    const r = executorForPayload(type, { pkgs, ...fullContext() })
    if (!('missing' in r) || !/no wired executor/.test(r.missing)) return type
  }
  return null
}

describe('executorForPayload — every wired payload type', () => {
  it.each(WIRED)('%s builds its handler call from a full context', (path) => {
    const type = payloadType(path)
    expect(type).not.toBeNull()
    const exec = executorForPayload(type!, { pkgs, ...fullContext() })
    if ('missing' in exec) throw new Error(exec.missing)
    const tx = new Transaction()
    const ticket = tx.moveCall({ target: '0x2::x::ticket' })
    exec.execute(tx, ticket, UNIT)
    const calls = (tx.getData().commands as any[]).filter(
      (c) => c.$kind === 'MoveCall',
    )
    // The ticket's maker, then at least one handler call that consumes it.
    expect(calls.length).toBeGreaterThan(1)
  })

  it.each(WIRED)('%s names what is missing from an empty context', (path) => {
    const type = payloadType(path)!
    const r = executorForPayload(type, { pkgs, unit: { daoId: UNIT } })
    if ('missing' in r) {
      expect(r.missing).toMatch(/needs|no wired/)
    } else {
      // Handlers that need nothing beyond the unit build regardless.
      expect(typeof r.execute).toBe('function')
    }
  })

  it('declines an unknown payload type, naming why', () => {
    const r = executorForPayload(`${hex('77')}::x::Y`, {
      pkgs,
      unit: { daoId: UNIT },
    })
    expect(r).toMatchObject({
      missing: expect.stringMatching(/no wired executor/),
    })
  })
})

describe('reconstructing passed actions', () => {
  it('maps default-slot display keys and per-coin keys to payload types', () => {
    expect(
      passedProposalAction(pkgs, {
        typeKey: 'SetBoard',
        unit: { daoId: UNIT },
      }),
    ).toMatchObject({ own: { typeKey: 'SetBoard' } })
    expect(
      passedProposalAction(pkgs, {
        typeKey: `SendCoin<${COIN}>`,
        unit: fullContext().unit,
      }),
    ).toMatchObject({
      own: {
        payloadMoveType: `${ids.armatureProposals}::send_coin::SendCoin<${COIN}>`,
      },
    })
    expect(passedProposalAction(pkgs, { typeKey: 'NoSuchType' })).toBeNull()
  })

  it('resolves composite steps, or declines unmapped ones', () => {
    expect(compositeStepExecutor(pkgs, 'SetBoard')).toMatchObject({
      payloadMoveType: `${ids.armature}::set_board::SetBoard`,
    })
    expect(compositeStepExecutor(pkgs, 'NoSuchType')).toBeNull()
  })
})

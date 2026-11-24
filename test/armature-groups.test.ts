/**
 * The org handle's long-tail groups — currency, units, freeze, entries,
 * upgrade and capabilities — run end to end against a mocked OU chain.
 *
 * Each call must end in one of the shapes the API promises: a governance
 * outcome (`executed` / `proposed` / `blocked`), a submitted `TxResult`, a
 * read result, or a TYPED `TriexClientError`. A raw TypeError — a field read
 * off something that isn't there — fails the test: that is the class of bug
 * these rarely-driven paths can hide.
 */
import { jest } from '@jest/globals'
import type { Transaction } from '@mysten/sui/transactions'

import { OrgHandle } from '../src/armature/OrgClient'
import type { Org } from '../src/armature/types'
import { resolvePackageIds } from '../src/config'
import { TriexClientError } from '../src/errors'
import { bcs } from '@mysten/sui/bcs'
import { mockOuChain } from './helpers/ouChain'

/** `capability_vault::CapabilityVault`, as `parseCapabilityVault` reads it. */
const CapabilityVaultBcs = bcs.struct('CapabilityVault', {
  id: bcs.Address,
  ou_id: bcs.Address,
  cap_types: bcs.struct('VecSet', { contents: bcs.vector(bcs.string()) }),
  cap_ids: bcs.struct('VecSet', { contents: bcs.vector(bcs.Address) }),
  ids_by_type: bcs.struct('VecMap', {
    contents: bcs.vector(
      bcs.struct('Entry', {
        key: bcs.string(),
        value: bcs.vector(bcs.Address),
      }),
    ),
  }),
})

const hex = (pair: string) => `0x${pair.repeat(32)}`
const ROOT = hex('c1')
const OFFICERS = hex('c2')
const ALICE = hex('11')
const BOB = hex('22')
const COIN = `${hex('ab')}::gold::GOLD`
const ids = resolvePackageIds('testnet')
const CAP = hex('ca')
const T = `${ids.armature}::x::Y`

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

const tree = (): Org =>
  unit(ROOT, {
    emergencyFreezeId: hex('e1'),
    capabilityVaultId: hex('e2'),
    charterId: hex('e3'),
    treasuryId: hex('e8'),
    members: [ALICE],
    ous: [
      unit(OFFICERS, {
        emergencyFreezeId: hex('e4'),
        capabilityVaultId: hex('e5'),
        charterId: hex('e6'),
        treasuryId: hex('e9'),
        members: [ALICE, BOB],
        subdaoControlCapId: hex('e7'),
      }),
    ],
  })

function harness() {
  const captured: Transaction[] = []
  // The mock serves units, their freezes and these capability vaults; the ids
  // match the tree so every group method can read what it needs.
  const vault = (vaultId: string, ouId: string) => ({
    type: `${ids.armature}::capability_vault::CapabilityVault`,
    content: CapabilityVaultBcs.serialize({
      id: vaultId,
      ou_id: ouId,
      cap_types: { contents: [] },
      cap_ids: { contents: [CAP] },
      ids_by_type: { contents: [{ key: T, value: [CAP] }] },
    }).toBytes(),
  })
  const chain = mockOuChain(
    {
      [ROOT]: { members: [ALICE], slots: [], emergencyFreezeId: hex('e1') },
      [OFFICERS]: {
        members: [ALICE, BOB],
        controllerCapId: hex('e7'),
        slots: [],
        emergencyFreezeId: hex('e4'),
      },
    },
    {
      [hex('e2')]: vault(hex('e2'), ROOT),
      [hex('e5')]: vault(hex('e5'), OFFICERS),
    },
  )
  const executor = jest.fn(async (tx: unknown) => {
    captured.push(tx as Transaction)
    return { digest: 'D', objectChanges: [] }
  })
  const handle = new OrgHandle(
    {
      suiClient: { core: chain.core } as never,
      indexer: { orgs: { proposals: async () => [] } } as never,
      ids,
      requireExecutor: () => executor,
      address: ALICE,
    },
    tree(),
  )
  return { handle, executor, captured }
}

/** [label, call] — every group method, with plausible arguments. */
const calls: Array<[string, (h: OrgHandle) => Promise<unknown>]> = [
  // currency
  ['currency.enable', (h) => h.currency.enable({ coinType: COIN })],
  [
    'currency.adopt',
    (h) => h.currency.adopt({ coinType: COIN, treasuryCapId: CAP }),
  ],
  [
    'currency.mint',
    (h) =>
      h.currency.mint({
        coinType: COIN,
        treasuryCapId: CAP,
        amount: 5n,
        recipient: BOB,
      }),
  ],
  [
    'currency.mintAllowance',
    (h) =>
      h.currency.mintAllowance({
        coinType: COIN,
        treasuryCapId: CAP,
        amount: 5n,
      }),
  ],
  [
    'currency.configureAllowance',
    (h) =>
      h.currency.configureAllowance({
        coinType: COIN,
        addMinters: [BOB],
        maxPerCall: 10n,
        enabled: true,
      }),
  ],
  [
    'currency.mintWithAllowance',
    (h) =>
      h.currency.mintWithAllowance({
        coinType: COIN,
        treasuryCapId: CAP,
        amount: 1n,
      }),
  ],
  [
    'currency.burn',
    (h) => h.currency.burn({ coinType: COIN, treasuryCapId: CAP, amount: 1n }),
  ],
  [
    'currency.returnCap',
    (h) =>
      h.currency.returnCap({
        coinType: COIN,
        treasuryCapId: CAP,
        recipient: BOB,
      }),
  ],
  // units
  [
    'units.create',
    (h) =>
      h.units.create({ name: 'Scouts', board: [BOB], metadataUri: 'ipfs://x' }),
  ],
  ['units.pause', (h) => h.units.pause({ unitId: OFFICERS })],
  ['units.unpause', (h) => h.units.unpause({ unitId: OFFICERS })],
  [
    'units.transferCap',
    (h) => h.units.transferCap({ unitId: OFFICERS, capId: CAP, capType: T }),
  ],
  [
    'units.reclaimCap',
    (h) => h.units.reclaimCap({ unitId: OFFICERS, capId: CAP, capType: T }),
  ],
  ['units.spinOut', (h) => h.units.spinOut({ unitId: OFFICERS })],
  [
    'units.spawnSuccessor',
    (h) =>
      h.units.spawnSuccessor({
        board: [ALICE],
        name: 'Next',
        metadataUri: 'ipfs://y',
      }),
  ],
  [
    'units.transferAssets',
    (h) => h.units.transferAssets({ targetOuId: OFFICERS, coinTypes: [COIN] }),
  ],
  ['units.destroy', (h) => h.units.destroy({ unitId: OFFICERS })],
  // freeze
  ['freeze.read', (h) => h.freeze.read()],
  [
    'freeze.freezeType',
    (h) => h.freeze.freezeType({ moveType: T, freezeAdminCapId: CAP }),
  ],
  [
    'freeze.unfreezeType',
    (h) => h.freeze.unfreezeType({ moveType: T, freezeAdminCapId: CAP }),
  ],
  ['freeze.unfreeze', (h) => h.freeze.unfreeze({ moveType: T })],
  [
    'freeze.setMaxDuration',
    (h) => h.freeze.setMaxDuration({ maxFreezeDurationMs: 86_400_000 }),
  ],
  ['freeze.updateExempt', (h) => h.freeze.updateExempt({ add: [T] })],
  [
    'freeze.transferAdmin',
    (h) => h.freeze.transferAdmin({ newAdmin: BOB, freezeAdminCapId: CAP }),
  ],
  // entries
  ['entries.list', (h) => h.entries.list()],
  [
    'entries.publish',
    (h) => h.entries.publish({ location: 'walrus://a', description: 'base' }),
  ],
  [
    'entries.update',
    (h) => h.entries.update({ entryId: CAP, location: 'walrus://b' }),
  ],
  [
    'entries.edit',
    (h) => h.entries.edit({ entryId: CAP, location: 'walrus://c' }),
  ],
  ['entries.rotateEpoch', (h) => h.entries.rotateEpoch()],
  ['entries.remove', (h) => h.entries.remove({ entryId: CAP })],
  // upgrade & capabilities
  [
    'upgrade.propose',
    (h) =>
      h.upgrade.propose({
        capId: CAP,
        packageId: hex('dd'),
        digest: new Array(32).fill(7),
      }),
  ],
  ['capabilities.list', (h) => h.capabilities.list()],
  [
    'capabilities.enableBypass',
    (h) =>
      h.capabilities.enableBypass({
        typeKey: 'Y',
        moveType: T,
        config: {
          quorum: 1,
          approvalThreshold: 8000,
          proposeThreshold: 0,
          expiryMs: 3_600_000,
          executionDelayMs: 0,
          cooldownMs: 0,
          composableAllowed: false,
          permissions: 0,
        } as never,
      }),
  ],
  [
    'capabilities.disableBypass',
    (h) =>
      h.capabilities.disableBypass({ moveType: T, typeKey: 'Y', capId: CAP }),
  ],
]

describe('org handle groups end in a promised shape', () => {
  it.each(calls)('%s', async (_label, call) => {
    const { handle } = harness()
    let outcome: unknown
    try {
      outcome = await call(handle)
    } catch (e) {
      // A typed refusal (missing slot, permission, object) is a promised shape.
      if (!(e instanceof TriexClientError)) {
        throw new Error(
          `untyped ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`,
        )
      }
      return
    }
    expect(outcome).toBeDefined()
    const status = (outcome as { status?: string }).status
    if (status !== undefined) {
      expect(['executed', 'proposed', 'blocked']).toContain(status)
    }
  })

  it('submits entries directly — member-gated, no vote', async () => {
    const { handle, captured } = harness()
    await handle.entries.rotateEpoch()
    expect(captured).toHaveLength(1)
  })
})

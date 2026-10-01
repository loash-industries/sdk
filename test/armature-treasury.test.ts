import { jest } from '@jest/globals'
import { bcs } from '@mysten/sui/bcs'
import type { Transaction } from '@mysten/sui/transactions'

import {
  depositToTreasuryTx,
  fetchTreasuryCoinBalance,
  fetchTreasuryCoinBalances,
  fetchTreasuryItemBalance,
  sendCoinAction,
  sendCoinToDaoAction,
  toTypeNameKey,
} from '../src/armature/treasury'
import { buildPlanTx } from '../src/armature/plan'
import type { OuExecContext } from '../src/armature/types'

const hex = (pair: string) => `0x${pair.repeat(32)}`
const ARMATURE = hex('a1')
const PROPOSALS = hex('b2')
const PKGS = { armature: ARMATURE, armatureProposals: PROPOSALS }
const VAULT = hex('44')
const OTHER_VAULT = hex('45')
const ALICE = hex('11')
const CRED = `${hex('c0')}::cred::CRED`
const CRED_KEY = toTypeNameKey(CRED)

const ctx: OuExecContext = {
  daoId: hex('c3'),
  board: [ALICE],
  emergencyFreezeId: hex('c4'),
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
function typeArgs(tx: Transaction): string[][] {
  return tx
    .getData()
    .commands.filter((c: any) => c.$kind === 'MoveCall')
    .map((c: any) => c.MoveCall.typeArguments)
}

describe('toTypeNameKey', () => {
  it('matches Move’s type_name string: no 0x, zero-padded to 64', () => {
    expect(toTypeNameKey('0x2::sui::SUI')).toBe(`${'0'.repeat(63)}2::sui::SUI`)
    expect(toTypeNameKey(CRED)).toBe(`${'c0'.repeat(32)}::cred::CRED`)
    // Already-padded input is unchanged, and case is normalized.
    expect(toTypeNameKey(`0x${'A0'.repeat(32)}::x::X`)).toBe(
      `${'a0'.repeat(32)}::x::X`,
    )
  })
})

describe('treasury reads', () => {
  const vaultObject = (coinTypes: string[], nested = false) => ({
    object: {
      json: nested
        ? { coin_types: { fields: { contents: coinTypes } } }
        : { coin_types: { contents: coinTypes } },
    },
  })

  it('enumerates from the vault’s own coin_types set, both transports', async () => {
    for (const nested of [false, true]) {
      const getObject = jest.fn(async () => vaultObject([CRED_KEY], nested))
      // Declare the parameter so `mock.calls[0][0]` is typed, not `never`.
      const getDynamicField = jest.fn(async (_args: unknown) => ({
        dynamicField: { value: { bcs: bcs.u64().serialize(4200n).toBytes() } },
      }))
      const sui = { core: { getObject, getDynamicField } } as never

      const balances = await fetchTreasuryCoinBalances(sui, VAULT)
      expect(balances).toEqual([{ coinType: CRED_KEY, amount: 4200n }])
      // Keyed by an ascii::String, not by the 0x-prefixed type.
      const call = getDynamicField.mock.calls[0][0] as any
      expect(call.parentId).toBe(VAULT)
      expect(call.name.type).toBe('0x1::ascii::String')
    }
  })

  it('reports a withdrawn coin as 0 rather than dropping it', async () => {
    const sui = {
      core: {
        getObject: async () => vaultObject([CRED_KEY]),
        // No dynamic field → the balance was fully withdrawn.
        getDynamicField: async () => {
          throw new Error('not found')
        },
      },
    } as never
    expect(await fetchTreasuryCoinBalances(sui, VAULT)).toEqual([
      { coinType: CRED_KEY, amount: 0n },
    ])
  })

  it('returns an empty list for a vault that has held nothing', async () => {
    const sui = {
      core: { getObject: async () => ({ object: { json: {} } }) },
    } as never
    expect(await fetchTreasuryCoinBalances(sui, VAULT)).toEqual([])
  })

  it('reads one coin balance by type', async () => {
    const getDynamicField = jest.fn(async () => ({
      dynamicField: { value: { bcs: bcs.u64().serialize(7n).toBytes() } },
    }))
    const sui = { core: { getDynamicField } } as never
    expect(await fetchTreasuryCoinBalance(sui, VAULT, CRED)).toBe(7n)
  })

  it('walks collection → asset for an item balance', async () => {
    const RECORD = hex('55')
    const MultiCoin = bcs.struct('MultiCoinBalance', {
      id: bcs.Address,
      collection: bcs.Address,
      asset_id: bcs.u64(),
      amount: bcs.u64(),
    })
    const getDynamicField = jest.fn(async ({ parentId }: any) =>
      parentId === VAULT
        ? {
            dynamicField: {
              value: { bcs: bcs.Address.serialize(RECORD).toBytes() },
            },
          }
        : {
            dynamicField: {
              value: {
                bcs: MultiCoin.serialize({
                  id: RECORD,
                  collection: hex('66'),
                  asset_id: 70810n,
                  amount: 12n,
                }).toBytes(),
              },
            },
          },
    )
    const sui = { core: { getDynamicField } } as never
    const amount = await fetchTreasuryItemBalance(sui, VAULT, {
      collectionId: hex('66'),
      assetId: 70810n,
    })
    expect(amount).toBe(12n)
    expect(getDynamicField).toHaveBeenCalledTimes(2)
    expect((getDynamicField.mock.calls[1][0] as any).parentId).toBe(RECORD)
  })

  it('is 0n when the collection was never recorded', async () => {
    const sui = {
      core: {
        getDynamicField: async () => {
          throw new Error('nope')
        },
      },
    } as never
    expect(
      await fetchTreasuryItemBalance(sui, VAULT, {
        collectionId: hex('66'),
        assetId: 1n,
      }),
    ).toBe(0n)
  })
})

describe('depositToTreasuryTx', () => {
  it('sources the coin and deposits it — no governance in the PTB', () => {
    const tx = depositToTreasuryTx({
      armature: ARMATURE,
      treasuryVaultId: VAULT,
      coinType: CRED,
      amount: 500n,
    })
    // No submit_vote_execute, no submit_proposal: depositing is permissionless.
    const names = commandNames(tx)
    expect(names).toContain('treasury_vault::deposit')
    expect(names.some((n) => n.startsWith('board_voting::'))).toBe(false)
    expect(typeArgs(tx).at(-1)).toEqual([CRED])
  })
})

describe('treasury payouts are governance', () => {
  it('sendCoin builds payload → vote → treasury_ops execute', () => {
    const tx = buildPlanTx(
      'own-execute',
      sendCoinAction(PKGS, {
        coinType: CRED,
        recipient: ALICE,
        amount: 100n,
        treasuryVaultId: VAULT,
      }),
      ctx,
      ARMATURE,
    )
    expect(commandNames(tx)).toEqual([
      'send_coin::new',
      'board_voting::submit_vote_execute',
      'treasury_ops::execute_send_coin',
    ])
    expect(typeArgs(tx)[1]).toEqual([
      `${PROPOSALS}::send_coin::SendCoin<${CRED}>`,
    ])
  })

  it('sendCoin defers cleanly — one action serves both strategies', () => {
    const tx = buildPlanTx(
      'own-propose',
      sendCoinAction(PKGS, {
        coinType: CRED,
        recipient: ALICE,
        amount: 100n,
        treasuryVaultId: VAULT,
      }),
      ctx,
      ARMATURE,
    )
    expect(commandNames(tx)).toEqual([
      'send_coin::new',
      'board_voting::submit_proposal',
    ])
  })

  it('sendCoinToDao targets the recipient TREASURY, not a wallet', () => {
    const tx = buildPlanTx(
      'own-execute',
      sendCoinToDaoAction(PKGS, {
        coinType: CRED,
        recipientTreasuryId: OTHER_VAULT,
        amount: 100n,
        treasuryVaultId: VAULT,
      }),
      ctx,
      ARMATURE,
    )
    expect(commandNames(tx)).toEqual([
      'send_coin_to_dao::new',
      'board_voting::submit_vote_execute',
      'treasury_ops::execute_send_coin_to_dao',
    ])
    // Both vaults are inputs: source and destination.
    const objectIds = (tx.getData().inputs as any[])
      .map(
        (i) =>
          i?.UnresolvedObject?.objectId ??
          i?.Object?.ImmOrOwnedObject?.objectId,
      )
      .filter(Boolean)
    expect(objectIds).toEqual(expect.arrayContaining([VAULT, OTHER_VAULT]))
  })

  it('both payout types fall back to a proposal — they are not single-vote-only', () => {
    expect(
      sendCoinAction(PKGS, {
        coinType: CRED,
        recipient: ALICE,
        amount: 1n,
        treasuryVaultId: VAULT,
      }).fallbackPolicy,
    ).toBe('fall-back-to-proposal')
    expect(
      sendCoinToDaoAction(PKGS, {
        coinType: CRED,
        recipientTreasuryId: OTHER_VAULT,
        amount: 1n,
        treasuryVaultId: VAULT,
      }).fallbackPolicy,
    ).toBe('fall-back-to-proposal')
  })
})

import { jest } from '@jest/globals'
import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'

import type { DaoGovernance } from '../src/armature/governance'
import { OrgHandle } from '../src/armature/OrgClient'
import { tradingProposalTypes } from '../src/armature/trading'
import type { Org } from '../src/armature/types'
import {
  deinitializeOuVaultTx,
  depositReceiptTx,
  fetchOuVaultInfo,
  fetchVaultBalance,
  grantEditOuTx,
  grantTx,
  initializeOuVaultTx,
  principalVec,
  resolveOuVaultId,
  revokeTx,
  roleVec,
  sourceWalletReceipts,
  toStorageUnitId,
  updateRegistryKeyTx,
  VaultKeyBcs,
  withdrawReceiptTx,
} from '../src/armature/vault'
import { resolvePackageIds } from '../src/config'
import { TriexError } from '../src/errors'

const hex = (pair: string) => `0x${pair.repeat(32)}`
const ids = resolvePackageIds('testnet')
const VAULT_PKG = ids.armatureVault

const ROOT = hex('c1')
const OFFICERS = hex('c2')
const ALICE = hex('11')
const BOT = hex('1b')
const SSU = hex('55')
const VAULT = hex('47')
const TABLE = hex('56')
const COLLECTION = hex('51')
const TREASURY = hex('44')
const ACCOUNT = hex('b0')
const CUSTODY = hex('b1')
const CONFIG = hex('53')

// ─── PTB inspection ─────────────────────────────────────────────────────────

interface Call {
  fn: string
  target: string
  typeArgs: string[]
  args: (string | { pure: string } | { result: number })[]
}

function calls(tx: Transaction): Call[] {
  const data = tx.getData()
  const inputs = data.inputs as any[]
  const arg = (a: any) => {
    if (a?.$kind === 'Input') {
      const input = inputs[a.Input]
      const objectId =
        input?.UnresolvedObject?.objectId ??
        input?.Object?.ImmOrOwnedObject?.objectId ??
        input?.Object?.SharedObject?.objectId
      if (objectId) return objectId as string
      return { pure: input?.Pure?.bytes as string }
    }
    if (a?.$kind === 'Result') return { result: a.Result as number }
    if (a?.$kind === 'NestedResult')
      return { result: a.NestedResult[0] as number }
    return { pure: '?' }
  }
  return data.commands.map((c: any) =>
    c.$kind === 'MoveCall'
      ? {
          fn: `${c.MoveCall.module}::${c.MoveCall.function}`,
          target: `${c.MoveCall.package}::${c.MoveCall.module}::${c.MoveCall.function}`,
          typeArgs: c.MoveCall.typeArguments,
          args: c.MoveCall.arguments.map(arg),
        }
      : {
          fn: c.$kind,
          target: c.$kind,
          typeArgs: [],
          args: c.$kind === 'MakeMoveVec' ? [c.MakeMoveVec.type] : [],
        },
  )
}
const commandNames = (tx: Transaction) => calls(tx).map((c) => c.fn)
const last = (tx: Transaction) => calls(tx).at(-1)!
const pureId = (v: string) => ({ pure: bcs.Address.serialize(v).toBase64() })
const pureU64 = (v: bigint) => ({ pure: bcs.u64().serialize(v).toBase64() })

const MultiCoin = bcs.struct('MultiCoinBalance', {
  id: bcs.Address,
  collection: bcs.Address,
  asset_id: bcs.u64(),
  amount: bcs.u64(),
})

describe('toStorageUnitId', () => {
  it('normalizes short hex and decimal forms to 0x + 64', () => {
    expect(toStorageUnitId('0x2a')).toBe(`0x${'0'.repeat(62)}2a`)
    expect(toStorageUnitId('42')).toBe(`0x${'0'.repeat(62)}2a`)
    expect(toStorageUnitId(SSU)).toBe(SSU)
  })
})

describe('resolveOuVaultId', () => {
  function sui(over: { table?: unknown; entry?: unknown } = {}) {
    return {
      core: {
        getObject: async () => ({
          object: {
            json: over.table ?? { vaults: { id: { id: TABLE } } },
          },
        }),
        getDynamicField: jest.fn(async (_args: unknown) =>
          over.entry === undefined
            ? {
                dynamicField: {
                  value: { bcs: bcs.Address.serialize(VAULT).toBytes() },
                },
              }
            : over.entry,
        ),
      },
    } as never
  }

  it('keys by BOTH storage unit and registrant OU', async () => {
    const client = sui()
    const id = await resolveOuVaultId(client, ids, {
      storageUnitId: SSU,
      registrantOrgId: OFFICERS,
    })
    expect(id).toBe(VAULT)

    const call = (client as any).core.getDynamicField.mock.calls[0][0]
    expect(call.parentId).toBe(TABLE)
    expect(call.name.bcs).toEqual(
      VaultKeyBcs.serialize({
        storage_unit_id: SSU,
        registrant_ou_id: OFFICERS,
      }).toBytes(),
    )
  })

  it('types the key with the ORIGINAL package id, never the current one', async () => {
    // The cycle-7 preset is a fresh publish (original === current), so prove
    // the choice with an upgraded package: objects keep the type tag of the
    // version that created them.
    const upgraded = resolvePackageIds('testnet', {
      armatureVault: hex('9a'),
      armatureVaultOriginal: hex('9b'),
    })
    const client = sui()
    await resolveOuVaultId(client, upgraded, {
      storageUnitId: SSU,
      registrantOrgId: OFFICERS,
    })
    const call = (client as any).core.getDynamicField.mock.calls[0][0]
    expect(call.name.type).toBe(`${hex('9b')}::ou_receipt_vault::VaultKey`)
  })

  it('unwraps the table UID through both transport shapes', async () => {
    for (const table of [
      { vaults: { id: { id: TABLE } } },
      { vaults: { fields: { id: { id: TABLE } } } },
    ]) {
      const id = await resolveOuVaultId(sui({ table }), ids, {
        storageUnitId: SSU,
        registrantOrgId: OFFICERS,
      })
      expect(id).toBe(VAULT)
    }
  })

  it('is null when this organization has no vault there', async () => {
    const client = {
      core: {
        getObject: async () => ({
          object: { json: { vaults: { id: { id: TABLE } } } },
        }),
        getDynamicField: async () => {
          throw new Error('not found')
        },
      },
    } as never
    expect(
      await resolveOuVaultId(client, ids, {
        storageUnitId: SSU,
        registrantOrgId: OFFICERS,
      }),
    ).toBeNull()
  })
})

describe('fetchOuVaultInfo', () => {
  function client(json: unknown) {
    return {
      core: { getObject: async () => ({ object: { json } }) },
    } as never
  }
  const base = {
    storage_unit_id: SSU,
    collection_id: COLLECTION,
    registrant_ou_id: OFFICERS,
    non_empty_assets: 2,
  }
  const expected = [
    { role: 'deposit', principal: { kind: 'ou', value: OFFICERS } },
    { role: 'edit', principal: { kind: 'player', value: ALICE } },
    { role: 'edit', principal: { kind: 'machine', value: BOT } },
  ]

  it('parses gRPC JSON enums (`@variant`), including Machine', async () => {
    const info = await fetchOuVaultInfo(
      client({
        ...base,
        acl: {
          contents: [
            {
              key: { '@variant': 'Deposit' },
              value: [{ '@variant': 'Ou', ou_id: OFFICERS }],
            },
            {
              key: { '@variant': 'Edit' },
              value: [
                { '@variant': 'Player', addr: ALICE },
                { '@variant': 'Machine', addr: BOT },
              ],
            },
          ],
        },
      }),
      VAULT,
    )
    expect(info).toMatchObject({
      vaultId: VAULT,
      storageUnitId: SSU,
      collectionId: COLLECTION,
      registrantOrgId: OFFICERS,
      nonEmptyAssets: 2,
    })
    expect(info!.acl).toEqual(expected)
  })

  it('parses JSON-RPC enums (`variant` + `fields`)', async () => {
    const info = await fetchOuVaultInfo(
      client({
        fields: {
          ...base,
          acl: {
            fields: {
              contents: [
                {
                  fields: {
                    key: { variant: 'Deposit', fields: {} },
                    value: [{ variant: 'Ou', fields: { ou_id: OFFICERS } }],
                  },
                },
                {
                  fields: {
                    key: { variant: 'Edit', fields: {} },
                    value: [
                      { variant: 'Player', fields: { addr: ALICE } },
                      { variant: 'Machine', fields: { addr: BOT } },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
      VAULT,
    )
    expect(info!.acl).toEqual(expected)
  })

  it('parses externally tagged enums and bare variant names', async () => {
    const info = await fetchOuVaultInfo(
      client({
        acl: {
          contents: [
            { key: { Withdraw: {} }, value: [{ Player: { addr: ALICE } }] },
            { key: 'Edit', value: [{ Ou: { ou_id: ROOT } }] },
          ],
        },
      }),
      VAULT,
    )
    expect(info!.acl).toEqual([
      { role: 'withdraw', principal: { kind: 'player', value: ALICE } },
      { role: 'edit', principal: { kind: 'ou', value: ROOT } },
    ])
  })

  it('is null for a vault that cannot be read', async () => {
    const c = {
      core: {
        getObject: async () => {
          throw new Error('gone')
        },
      },
    } as never
    expect(await fetchOuVaultInfo(c, VAULT)).toBeNull()
  })
})

describe('fetchVaultBalance', () => {
  it('reads the u64-keyed dynamic OBJECT field and decodes the child', async () => {
    const getDynamicObjectField = jest.fn(async (_a: unknown) => ({
      object: {
        content: MultiCoin.serialize({
          id: hex('77'),
          collection: COLLECTION,
          asset_id: 70810n,
          amount: 9n,
        }).toBytes(),
      },
    }))
    const c = { core: { getDynamicObjectField } } as never
    expect(await fetchVaultBalance(c, VAULT, 70810n)).toBe(9n)
    const args = getDynamicObjectField.mock.calls[0][0] as any
    expect(args.parentId).toBe(VAULT)
    expect(args.name.type).toBe('u64')
    expect(args.name.bcs).toEqual(bcs.u64().serialize(70810n).toBytes())
  })

  it('is 0n for an asset the vault has never held', async () => {
    const c = {
      core: {
        getDynamicObjectField: async () => {
          throw new Error('nope')
        },
      },
    } as never
    expect(await fetchVaultBalance(c, VAULT, 1n)).toBe(0n)
  })
})

describe('principal + role vectors', () => {
  it('builds each Principal with its acl:: constructor — it cannot cross as tx.pure', () => {
    const tx = new Transaction()
    principalVec(tx, VAULT_PKG, [
      { kind: 'ou', value: OFFICERS },
      { kind: 'player', value: ALICE },
      { kind: 'machine', value: BOT },
    ])
    const cs = calls(tx)
    expect(cs.map((c) => c.fn)).toEqual([
      'acl::ou',
      'acl::player',
      'acl::machine',
      'MakeMoveVec',
    ])
    expect(cs[0].args).toEqual([pureId(OFFICERS)])
    expect(cs[1].args).toEqual([pureId(ALICE)])
    expect(cs[2].args).toEqual([pureId(BOT)])
    expect(cs[2].target).toBe(`${VAULT_PKG}::acl::machine`)
  })

  it('builds Role via ou_receipt_vault constructors', () => {
    const tx = new Transaction()
    roleVec(tx, VAULT_PKG, ['deposit', 'withdraw', 'edit'])
    expect(commandNames(tx)).toEqual([
      'ou_receipt_vault::role_deposit',
      'ou_receipt_vault::role_withdraw',
      'ou_receipt_vault::role_edit',
      'MakeMoveVec',
    ])
  })
})

describe('vault write PTBs', () => {
  it('initialize_ou_vault: registry, SSU, registrant OU, config, three vectors', () => {
    const tx = new Transaction()
    initializeOuVaultTx(tx, {
      armatureVault: VAULT_PKG,
      registryId: ids.ouReceiptVaultRegistry,
      storageUnitId: '0x55',
      registrantOrgId: OFFICERS,
      vaultConfigId: CONFIG,
      depositPrincipals: [{ kind: 'ou', value: OFFICERS }],
      withdrawPrincipals: [{ kind: 'machine', value: BOT }],
      editPrincipals: [{ kind: 'player', value: ALICE }],
    })
    expect(commandNames(tx)).toEqual([
      'acl::ou',
      'MakeMoveVec',
      'acl::machine',
      'MakeMoveVec',
      'acl::player',
      'MakeMoveVec',
      'ou_receipt_vault::initialize_ou_vault',
    ])
    const init = last(tx)
    expect(init.target).toBe(
      `${VAULT_PKG}::ou_receipt_vault::initialize_ou_vault`,
    )
    expect(init.args).toEqual([
      ids.ouReceiptVaultRegistry,
      toStorageUnitId('0x55'),
      OFFICERS,
      CONFIG,
      { result: 1 },
      { result: 3 },
      { result: 5 },
    ])
  })

  it('deposit_receipt: (vault, ou, balance)', () => {
    const tx = new Transaction()
    const [bal] = tx.moveCall({ target: '0x2::m::make', arguments: [] })
    depositReceiptTx(tx, {
      armatureVault: VAULT_PKG,
      vaultId: VAULT,
      ouId: OFFICERS,
      balance: bal,
    })
    expect(last(tx).fn).toBe('ou_receipt_vault::deposit_receipt')
    expect(last(tx).args).toEqual([VAULT, OFFICERS, { result: 0 }])
  })

  it('withdraw_receipt: (vault, ou, asset, amount) → a balance the caller routes', () => {
    const tx = new Transaction()
    const balance = withdrawReceiptTx(tx, {
      armatureVault: VAULT_PKG,
      vaultId: VAULT,
      ouId: OFFICERS,
      assetId: 70810n,
      amount: 3n,
    })
    tx.transferObjects([balance], ALICE)
    expect(commandNames(tx)).toEqual([
      'ou_receipt_vault::withdraw_receipt',
      'TransferObjects',
    ])
    expect(calls(tx)[0].args).toEqual([
      VAULT,
      OFFICERS,
      pureU64(70810n),
      pureU64(3n),
    ])
  })

  it('grant builds parallel role + principal vectors, edit to any principal', () => {
    const tx = new Transaction()
    grantTx(tx, {
      armatureVault: VAULT_PKG,
      vaultId: VAULT,
      editorOuId: ROOT,
      grants: [
        { role: 'deposit', principal: { kind: 'player', value: ALICE } },
        { role: 'edit', principal: { kind: 'machine', value: BOT } },
      ],
    })
    expect(commandNames(tx)).toEqual([
      'ou_receipt_vault::role_deposit',
      'ou_receipt_vault::role_edit',
      'MakeMoveVec',
      'acl::player',
      'acl::machine',
      'MakeMoveVec',
      'ou_receipt_vault::grant',
    ])
    expect(last(tx).args).toEqual([VAULT, ROOT, { result: 2 }, { result: 5 }])
  })

  it('grant_edit_ou: (vault, editor OU, target OU) — target as a live object', () => {
    const tx = new Transaction()
    grantEditOuTx(tx, {
      armatureVault: VAULT_PKG,
      vaultId: VAULT,
      editorOuId: ROOT,
      targetOuId: OFFICERS,
    })
    expect(last(tx).fn).toBe('ou_receipt_vault::grant_edit_ou')
    expect(last(tx).args).toEqual([VAULT, ROOT, OFFICERS])
  })

  it('revoke mirrors grant', () => {
    const tx = new Transaction()
    revokeTx(tx, {
      armatureVault: VAULT_PKG,
      vaultId: VAULT,
      editorOuId: ROOT,
      revocations: [
        { role: 'deposit', principal: { kind: 'player', value: ALICE } },
      ],
    })
    expect(commandNames(tx)).toEqual([
      'ou_receipt_vault::role_deposit',
      'MakeMoveVec',
      'acl::player',
      'MakeMoveVec',
      'ou_receipt_vault::revoke',
    ])
    expect(last(tx).args).toEqual([VAULT, ROOT, { result: 1 }, { result: 3 }])
  })

  it('update_registry_key: (registry, vault, editor OU, new registrant OU)', () => {
    const tx = new Transaction()
    updateRegistryKeyTx(tx, {
      armatureVault: VAULT_PKG,
      registryId: ids.ouReceiptVaultRegistry,
      vaultId: VAULT,
      editorOuId: ROOT,
      newRegistrantOrgId: OFFICERS,
    })
    expect(commandNames(tx)).toEqual(['ou_receipt_vault::update_registry_key'])
    expect(last(tx).args).toEqual([
      ids.ouReceiptVaultRegistry,
      VAULT,
      ROOT,
      OFFICERS,
    ])
  })

  it('deinitialize_ou_vault: (registry, vault, editor OU)', () => {
    const tx = new Transaction()
    deinitializeOuVaultTx(tx, {
      armatureVault: VAULT_PKG,
      registryId: ids.ouReceiptVaultRegistry,
      vaultId: VAULT,
      editorOuId: ROOT,
    })
    expect(commandNames(tx)).toEqual([
      'ou_receipt_vault::deinitialize_ou_vault',
    ])
    expect(last(tx).args).toEqual([ids.ouReceiptVaultRegistry, VAULT, ROOT])
  })
})

describe('sourceWalletReceipts', () => {
  function receiptClient(
    receipts: { id: string; amount: bigint; collection?: string }[],
  ) {
    return {
      core: {
        listOwnedObjects: async () => ({
          objects: receipts.map((r) => ({
            objectId: r.id,
            content: MultiCoin.serialize({
              id: r.id,
              collection: r.collection ?? COLLECTION,
              asset_id: 70810n,
              amount: r.amount,
            }).toBytes(),
          })),
          hasNextPage: false,
        }),
      },
    } as never
  }

  it('uses one receipt whole when it matches exactly', async () => {
    const tx = new Transaction()
    await sourceWalletReceipts(
      receiptClient([{ id: hex('01'), amount: 5n }]),
      tx,
      ids,
      { owner: ALICE, assetId: 70810n, amount: 5n, collectionId: COLLECTION },
    )
    expect(commandNames(tx)).toEqual([])
  })

  it('joins largest-first and splits the remainder', async () => {
    const tx = new Transaction()
    await sourceWalletReceipts(
      receiptClient([
        { id: hex('01'), amount: 2n },
        { id: hex('02'), amount: 7n },
      ]),
      tx,
      ids,
      { owner: ALICE, assetId: 70810n, amount: 8n, collectionId: COLLECTION },
    )
    // 7 then 2 = 9 ≥ 8, so one join and a split back to 8.
    expect(commandNames(tx)).toEqual([
      'multicoin::join_entry',
      'multicoin::split',
    ])
  })

  it('reports a shortfall rather than building a doomed transaction', async () => {
    await expect(
      sourceWalletReceipts(
        receiptClient([{ id: hex('01'), amount: 2n }]),
        new Transaction(),
        ids,
        { owner: ALICE, assetId: 70810n, amount: 8n, collectionId: COLLECTION },
      ),
    ).rejects.toMatchObject({ code: TriexError.InsufficientBalance })
  })

  it('distinguishes a wrong collection from an empty wallet', async () => {
    await expect(
      sourceWalletReceipts(
        receiptClient([{ id: hex('01'), amount: 9n, collection: hex('99') }]),
        new Transaction(),
        ids,
        { owner: ALICE, assetId: 70810n, amount: 1n, collectionId: COLLECTION },
      ),
    ).rejects.toMatchObject({ code: TriexError.CollectionMismatch })
  })
})

// ─── through the handle ─────────────────────────────────────────────────────

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

function governance(): DaoGovernance {
  const keys = tradingProposalTypes(ids.armatureTrading, ids.credCoinType)
  const config = {
    quorum: 1,
    approvalThreshold: 8000,
    proposeThreshold: 0,
    expiryMs: 3_600_000,
    executionDelayMs: 0,
    cooldownMs: 0,
    composableAllowed: false,
  }
  return {
    enabledTypes: new Set(keys.map((k) => k.typeKey)),
    configs: new Map(keys.map((k) => [k.typeKey, config])),
    typeBindings: new Map(keys.map((k) => [k.typeKey, k.moveType])),
  } as unknown as DaoGovernance
}

/** `vaultFor` maps `"<storageUnitId>|<registrantOrgId>"` → vault id. */
function harness(
  opts: { vaultFor?: Record<string, string>; sweepable?: unknown } = {},
) {
  const captured: { txs: Transaction[] } = { txs: [] }
  const executor = jest.fn(async (tx: unknown) => {
    captured.txs.push(tx as Transaction)
    return { digest: 'D1', objectChanges: [] }
  })
  const accountContent = new Uint8Array(80)
  accountContent.set(bcs.Address.serialize(CUSTODY).toBytes(), 32)
  const getObject = jest.fn(async ({ objectId }: any) => {
    if (objectId === ids.ouReceiptVaultRegistry) {
      return { object: { json: { vaults: { id: { id: TABLE } } } } }
    }
    if (objectId === ACCOUNT) return { object: { content: accountContent } }
    if (objectId === CUSTODY) {
      return {
        object: {
          type: `${ids.armatureTrading}::trading_custody::TradingCustody`,
          json: { ou_id: OFFICERS, trading_account_id: ACCOUNT },
        },
      }
    }
    if (objectId === VAULT) {
      return {
        object: {
          json: {
            storage_unit_id: SSU,
            collection_id: COLLECTION,
            registrant_ou_id: OFFICERS,
            non_empty_assets: 0,
            acl: { contents: [] },
          },
        },
      }
    }
    throw new Error(`unexpected getObject ${objectId}`)
  })
  const getDynamicField = jest.fn(async ({ name }: any) => {
    // Decode the real VaultKey so the mock is keyed by BOTH halves — which is
    // the property under test: a vault is (storage unit, organization), and one
    // half matching is not a hit.
    const key = VaultKeyBcs.parse(new Uint8Array(name.bcs))
    const norm = (v: string) => v.toLowerCase().replace(/^0x/, '')
    const hit = Object.entries(opts.vaultFor ?? {}).find(([k]) => {
      const [ssu, org] = k.split('|')
      return (
        norm(ssu) === norm(key.storage_unit_id) &&
        norm(org) === norm(key.registrant_ou_id)
      )
    })
    if (!hit) throw new Error('no vault')
    return {
      dynamicField: { value: { bcs: bcs.Address.serialize(hit[1]).toBytes() } },
    }
  })
  jest
    .spyOn(OrgHandle.prototype, 'gov')
    .mockImplementation(async () => governance())
  const handle = new OrgHandle(
    {
      suiClient: {
        core: {
          getObject,
          getDynamicField,
          getCoins: async () => ({ objects: [] }),
          getDynamicObjectField: async () => {
            throw new Error('none')
          },
          listOwnedObjects: async () => ({
            objects: [
              {
                objectId: hex('01'),
                content: MultiCoin.serialize({
                  id: hex('01'),
                  collection: COLLECTION,
                  asset_id: 70810n,
                  amount: 5n,
                }).toBytes(),
              },
            ],
            hasNextPage: false,
          }),
        },
      } as never,
      indexer: {
        hubVault: async () => ({
          collectionId: COLLECTION,
          vaultConfigId: CONFIG,
        }),
        sweepable: async () =>
          opts.sweepable ?? { tradingAccountId: ACCOUNT, pools: [], items: [] },
        orgs: {},
      } as never,
      ids,
      requireExecutor: () => executor,
      address: ALICE,
    },
    unit(ROOT, {
      emergencyFreezeId: hex('e1'),
      members: [ALICE],
      ous: [
        unit(OFFICERS, {
          emergencyFreezeId: hex('e4'),
          treasuryId: TREASURY,
          members: [ALICE],
          subdaoControlCapId: hex('e7'),
          tradingAccountId: ACCOUNT,
        }),
      ],
    }),
    OFFICERS,
  )
  return { handle, executor, captured }
}

afterEach(() => jest.restoreAllMocks())

describe('org.vault through the handle', () => {
  it('resolve walks the tree when the acting seat has no vault', async () => {
    // Registered by the ROOT, while the caller acts from OFFICERS.
    const { handle } = harness({ vaultFor: { [`${SSU}|${ROOT}`]: VAULT } })
    expect(await handle.vault.resolve({ storageUnitId: SSU })).toBe(VAULT)
  })

  it('says which key half failed when nothing resolves', async () => {
    const { handle } = harness()
    expect(await handle.vault.resolve({ storageUnitId: SSU })).toBeNull()
    // The same failure surfaces through any method that needs a vault.
    await expect(
      handle.vault.deposit({
        storageUnitId: SSU,
        items: [{ assetId: 1n, amount: 1n }],
      }),
    ).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
      message: expect.stringContaining('keyed by (storage unit, organization)'),
    })
  })

  it('init registers on the acting unit, with EDIT on the PARENT', async () => {
    const { handle, captured } = harness()
    await handle.vault.init({ storageUnitId: SSU })
    const tx = captured.txs[0]
    expect(commandNames(tx)).toEqual([
      'acl::ou',
      'MakeMoveVec',
      'acl::ou',
      'MakeMoveVec',
      'acl::ou',
      'MakeMoveVec',
      'ou_receipt_vault::initialize_ou_vault',
    ])
    const cs = calls(tx)
    // deposit + withdraw → OFFICERS; edit → ROOT.
    expect([cs[0].args, cs[2].args, cs[4].args]).toEqual([
      [pureId(OFFICERS)],
      [pureId(OFFICERS)],
      [pureId(ROOT)],
    ])
    expect(last(tx).args.slice(0, 4)).toEqual([
      ids.ouReceiptVaultRegistry,
      SSU,
      OFFICERS,
      CONFIG,
    ])
  })

  it('init refuses an explicitly empty editor set', async () => {
    const { handle, executor } = harness()
    await expect(
      handle.vault.init({ storageUnitId: SSU, editPrincipals: [] }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    expect(executor).not.toHaveBeenCalled()
  })

  it('deposits wallet receipts with the acting OU as context', async () => {
    const { handle, captured } = harness({
      vaultFor: { [`${SSU}|${OFFICERS}`]: VAULT },
    })
    await handle.vault.deposit({
      storageUnitId: SSU,
      items: [{ assetId: 70810n, amount: 5n }],
    })
    const tx = captured.txs[0]
    expect(last(tx).fn).toBe('ou_receipt_vault::deposit_receipt')
    expect(last(tx).args.slice(0, 2)).toEqual([VAULT, OFFICERS])
  })

  it('withdraws to the wallet by default', async () => {
    const { handle, captured } = harness()
    await handle.vault.withdraw({
      storageUnitId: SSU,
      vaultId: VAULT,
      items: [{ assetId: 70810n, amount: 2n }],
    })
    expect(commandNames(captured.txs[0])).toEqual([
      'ou_receipt_vault::withdraw_receipt',
      'TransferObjects',
    ])
  })

  it('routes an edit+ou grant through the witnessed path, the rest through grant', async () => {
    const { handle, captured } = harness()
    await handle.vault.grant({
      vaultId: VAULT,
      grants: [
        { role: 'edit', principal: { kind: 'ou', value: ROOT } },
        { role: 'deposit', principal: { kind: 'player', value: ALICE } },
        { role: 'edit', principal: { kind: 'machine', value: BOT } },
      ],
    })
    const tx = captured.txs[0]
    const witnessed = calls(tx).find(
      (c) => c.fn === 'ou_receipt_vault::grant_edit_ou',
    )!
    expect(witnessed.args).toEqual([VAULT, OFFICERS, ROOT])
    // A machine editor is an ordinary grant since cycle 7.
    expect(commandNames(tx)).toContain('acl::machine')
    expect(last(tx).fn).toBe('ou_receipt_vault::grant')
  })

  it('rejects empty grant / revoke batches', async () => {
    const { handle } = harness()
    await expect(
      handle.vault.grant({ vaultId: VAULT, grants: [] }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    await expect(
      handle.vault.revoke({ vaultId: VAULT, revocations: [] }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })

  it('revoke, rekey and deinit default the editor to the acting seat', async () => {
    const { handle, captured } = harness()
    await handle.vault.revoke({
      vaultId: VAULT,
      revocations: [
        { role: 'withdraw', principal: { kind: 'machine', value: BOT } },
      ],
    })
    await handle.vault.rekey({ vaultId: VAULT, newRegistrantOrgId: ROOT })
    await handle.vault.deinit({ vaultId: VAULT, editorOuId: ROOT })
    expect(last(captured.txs[0]).args.slice(0, 2)).toEqual([VAULT, OFFICERS])
    expect(last(captured.txs[1])).toMatchObject({
      fn: 'ou_receipt_vault::update_registry_key',
      args: [ids.ouReceiptVaultRegistry, VAULT, OFFICERS, ROOT],
    })
    expect(last(captured.txs[2])).toMatchObject({
      fn: 'ou_receipt_vault::deinitialize_ou_vault',
      args: [ids.ouReceiptVaultRegistry, VAULT, ROOT],
    })
  })

  it('withdraw to the hangar demands a character', async () => {
    const { handle } = harness({ vaultFor: { [`${SSU}|${OFFICERS}`]: VAULT } })
    await expect(
      handle.vault.withdraw({
        storageUnitId: SSU,
        items: [{ assetId: 1n, amount: 1n }],
        to: 'hangar',
      }),
    ).rejects.toMatchObject({ code: TriexError.CharacterNotFound })
  })
})

describe('sweepAll', () => {
  const item = (ssu: string, assetId: string, amount: bigint) => ({
    collectionId: COLLECTION,
    assetId,
    amount,
    storageUnitId: ssu,
  })

  it('claims first, parks each stack, and sends CRED to the treasury', async () => {
    const { handle, captured } = harness({
      vaultFor: { [`${SSU}|${OFFICERS}`]: VAULT },
      sweepable: {
        tradingAccountId: ACCOUNT,
        pools: [
          {
            poolId: hex('60'),
            quoteAssetId: null,
            settled: { base: 0n, quote: 0n, cred: 100n },
          },
        ],
        items: [item(SSU, '70810', 4n)],
      },
    })
    const res = await handle.orders.sweepAll()
    expect(res.status).toBe('executed')
    expect(res.skipped).toEqual([])
    // The claim precedes every governance command.
    const names = commandNames(captured.txs[0])
    expect(names[0]).toBe(
      'multicoin_pool::withdraw_settled_amounts_permissionless',
    )
    expect(names).toContain('sweep_multicoin_to_ou_vault::new')
    expect(names).toContain('sweep_coin_to_treasury::new')
  })

  it('REPORTS stacks with no vault instead of dropping them', async () => {
    const OTHER_SSU = hex('57')
    const { handle, captured } = harness({
      // A vault at SSU only — the stack at OTHER_SSU has nowhere to go.
      vaultFor: { [`${SSU}|${OFFICERS}`]: VAULT },
      sweepable: {
        tradingAccountId: ACCOUNT,
        pools: [],
        items: [item(SSU, '70810', 4n), item(OTHER_SSU, '999', 2n)],
      },
    })
    const res = await handle.orders.sweepAll()

    // The resolvable stack still moves…
    expect(res.status).toBe('executed')
    expect(commandNames(captured.txs[0])).toContain(
      'sweep_multicoin_to_ou_vault::new',
    )
    // …and the other is named, not silently dropped.
    expect(res.skipped).toEqual([
      {
        storageUnitId: OTHER_SSU,
        assetId: 999n,
        amount: 2n,
        reason: 'no-vault',
      },
    ])
  })

  it('REPORTS stacks the indexer has not linked to a hub yet', async () => {
    const { handle, captured } = harness({
      vaultFor: { [`${SSU}|${OFFICERS}`]: VAULT },
      sweepable: {
        tradingAccountId: ACCOUNT,
        pools: [],
        // storageUnitId '' is how the schema surfaces a null hub link.
        items: [item(SSU, '70810', 4n), item('', '999', 2n)],
      },
    })
    const res = await handle.orders.sweepAll()
    expect(res.status).toBe('executed')
    expect(commandNames(captured.txs[0])).toContain(
      'sweep_multicoin_to_ou_vault::new',
    )
    expect(res.skipped).toEqual([
      { storageUnitId: '', assetId: 999n, amount: 2n, reason: 'unlinked' },
    ])
  })

  it('refuses when there is nothing to sweep at all', async () => {
    const { handle } = harness({
      sweepable: { tradingAccountId: ACCOUNT, pools: [], items: [] },
    })
    await expect(handle.orders.sweepAll()).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
      message: expect.stringContaining('Nothing to sweep'),
    })
  })

  it('explains when every stack was skipped for want of a vault', async () => {
    const { handle } = harness({
      sweepable: {
        tradingAccountId: ACCOUNT,
        pools: [],
        items: [item(SSU, '70810', 4n)],
      },
    })
    await expect(handle.orders.sweepAll()).rejects.toMatchObject({
      message: expect.stringContaining('no shared storage registered'),
    })
  })
})

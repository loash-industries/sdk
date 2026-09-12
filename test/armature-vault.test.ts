import { jest } from '@jest/globals'
import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'

import { OrgHandle } from '../src/armature/OrgClient'
import type { Org } from '../src/armature/types'
import {
  deinitializeDaoVaultTx,
  fetchDaoVaultInfo,
  fetchVaultBalance,
  grantTx,
  initializeDaoVaultTx,
  principalVec,
  resolveDaoVaultId,
  revokeTx,
  sourceWalletReceipts,
  toStorageUnitId,
  VaultKeyBcs,
  withdrawReceiptTx,
} from '../src/armature/vault'
import { resolvePackageIds } from '../src/config'
import { TriexError } from '../src/errors'

const hex = (pair: string) => `0x${pair.repeat(32)}`
const ids = resolvePackageIds('testnet')

const ROOT = hex('c1')
const OFFICERS = hex('c2')
const ALICE = hex('11')
const SSU = hex('55')
const VAULT = hex('47')
const TABLE = hex('56')
const COLLECTION = hex('51')
const CAPS = hex('e5')
const TREASURY = hex('44')
const BM = hex('b0')

function commandNames(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.map((c: any) =>
      c.$kind === 'MoveCall'
        ? `${c.MoveCall.module}::${c.MoveCall.function}`
        : c.$kind,
    )
}

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

describe('resolveDaoVaultId', () => {
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

  it('keys by BOTH storage unit and registrant, using the ORIGINAL package id', async () => {
    const client = sui()
    const id = await resolveDaoVaultId(client, ids, {
      storageUnitId: SSU,
      registrantOrgId: OFFICERS,
    })
    expect(id).toBe(VAULT)

    const call = (client as any).core.getDynamicField.mock.calls[0][0]
    expect(call.parentId).toBe(TABLE)
    // Objects keep the type tag of the package that created them; on stillness
    // the vault package's current and original ids differ.
    expect(call.name.type).toBe(
      `${ids.armatureVaultOriginal}::dao_receipt_vault::VaultKey`,
    )
    expect(ids.armatureVaultOriginal).not.toBe(ids.armatureVault)
    expect(call.name.bcs).toEqual(
      VaultKeyBcs.serialize({
        storage_unit_id: SSU,
        registrant_dao_id: OFFICERS,
      }).toBytes(),
    )
  })

  it('unwraps the table UID through both transport shapes', async () => {
    for (const table of [
      { vaults: { id: { id: TABLE } } },
      { vaults: { fields: { id: { id: TABLE } } } },
    ]) {
      const id = await resolveDaoVaultId(sui({ table }), ids, {
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
      await resolveDaoVaultId(client, ids, {
        storageUnitId: SSU,
        registrantOrgId: OFFICERS,
      }),
    ).toBeNull()
  })
})

describe('fetchDaoVaultInfo', () => {
  const aclContents = [
    { key: 'Deposit', value: [{ kind: 1, id: OFFICERS, data: [] }] },
    { key: 'Edit', value: [{ kind: 0, id: ALICE, data: [] }] },
  ]

  it('parses roles and principals, both transports', async () => {
    for (const acl of [
      { contents: aclContents },
      {
        fields: {
          contents: aclContents.map((e) => ({
            fields: { key: e.key, value: e.value.map((p) => ({ fields: p })) },
          })),
        },
      },
    ]) {
      const client = {
        core: {
          getObject: async () => ({
            object: {
              json: {
                storage_unit_id: SSU,
                collection_id: COLLECTION,
                registrant_dao_id: OFFICERS,
                non_empty_assets: 2,
                acl,
              },
            },
          }),
        },
      } as never
      const info = await fetchDaoVaultInfo(client, VAULT)
      expect(info).toMatchObject({
        vaultId: VAULT,
        storageUnitId: SSU,
        collectionId: COLLECTION,
        nonEmptyAssets: 2,
      })
      expect(info!.acl).toEqual([
        { role: 'deposit', principal: { kind: 'ou', value: OFFICERS } },
        { role: 'edit', principal: { kind: 'player', value: ALICE } },
      ])
    }
  })

  it('reads a Move enum role given as a variant tag', async () => {
    const client = {
      core: {
        getObject: async () => ({
          object: {
            json: {
              acl: {
                contents: [
                  { key: { Withdraw: {} }, value: [{ kind: 0, id: ALICE }] },
                ],
              },
            },
          },
        }),
      },
    } as never
    const info = await fetchDaoVaultInfo(client, VAULT)
    expect(info!.acl[0].role).toBe('withdraw')
  })

  it('is null for a vault that cannot be read', async () => {
    const client = {
      core: {
        getObject: async () => {
          throw new Error('gone')
        },
      },
    } as never
    expect(await fetchDaoVaultInfo(client, VAULT)).toBeNull()
  })
})

describe('fetchVaultBalance', () => {
  it('reads the u64-keyed dynamic object field', async () => {
    const getDynamicField = jest.fn(async (_a: unknown) => ({
      dynamicField: {
        value: {
          bcs: MultiCoin.serialize({
            id: VAULT,
            collection: COLLECTION,
            asset_id: 70810n,
            amount: 9n,
          }).toBytes(),
        },
      },
    }))
    const client = { core: { getDynamicField } } as never
    expect(await fetchVaultBalance(client, VAULT, 70810n)).toBe(9n)
    expect((getDynamicField.mock.calls[0][0] as any).name.type).toBe('u64')
  })

  it('is 0n for an asset the vault has never held', async () => {
    const client = {
      core: {
        getDynamicField: async () => {
          throw new Error('nope')
        },
      },
    } as never
    expect(await fetchVaultBalance(client, VAULT, 1n)).toBe(0n)
  })
})

describe('principal + role vectors', () => {
  it('builds Principal via moveCall — it cannot cross as tx.pure', () => {
    const tx = new Transaction()
    principalVec(tx, ids.armatureVault, [
      { kind: 'ou', value: OFFICERS },
      { kind: 'player', value: ALICE },
    ])
    expect(commandNames(tx)).toEqual(['acl::ou', 'acl::player', 'MakeMoveVec'])
  })
})

describe('vault write PTBs', () => {
  it('initialize passes three principal vectors', () => {
    const tx = new Transaction()
    initializeDaoVaultTx(tx, {
      armatureVault: ids.armatureVault,
      registryId: ids.daoReceiptVaultRegistry,
      storageUnitId: SSU,
      registrantOrgId: OFFICERS,
      vaultConfigId: hex('53'),
      depositPrincipals: [{ kind: 'ou', value: OFFICERS }],
      withdrawPrincipals: [{ kind: 'ou', value: OFFICERS }],
      editPrincipals: [{ kind: 'ou', value: ROOT }],
    })
    expect(commandNames(tx)).toEqual([
      'acl::ou',
      'MakeMoveVec',
      'acl::ou',
      'MakeMoveVec',
      'acl::ou',
      'MakeMoveVec',
      'dao_receipt_vault::initialize_dao_vault_v2',
    ])
  })

  it('grant builds parallel role + principal vectors', () => {
    const tx = new Transaction()
    grantTx(tx, {
      armatureVault: ids.armatureVault,
      vaultId: VAULT,
      editorDaoId: ROOT,
      grants: [
        { role: 'deposit', principal: { kind: 'player', value: ALICE } },
        { role: 'withdraw', principal: { kind: 'ou', value: OFFICERS } },
      ],
    })
    expect(commandNames(tx)).toEqual([
      'dao_receipt_vault::role_deposit',
      'dao_receipt_vault::role_withdraw',
      'MakeMoveVec',
      'acl::player',
      'acl::ou',
      'MakeMoveVec',
      'dao_receipt_vault::grant',
    ])
  })

  it('revoke and deinit are single calls', () => {
    const tx = new Transaction()
    revokeTx(tx, {
      armatureVault: ids.armatureVault,
      vaultId: VAULT,
      editorDaoId: ROOT,
      revocations: [
        { role: 'deposit', principal: { kind: 'player', value: ALICE } },
      ],
    })
    expect(commandNames(tx).at(-1)).toBe('dao_receipt_vault::revoke')

    const tx2 = new Transaction()
    deinitializeDaoVaultTx(tx2, {
      armatureVault: ids.armatureVault,
      registryId: ids.daoReceiptVaultRegistry,
      vaultId: VAULT,
      editorDaoId: ROOT,
    })
    expect(commandNames(tx2)).toEqual([
      'dao_receipt_vault::deinitialize_dao_vault',
    ])
  })

  it('withdraw returns a balance the caller routes', () => {
    const tx = new Transaction()
    const balance = withdrawReceiptTx(tx, {
      armatureVault: ids.armatureVault,
      vaultId: VAULT,
      daoId: OFFICERS,
      assetId: 70810n,
      amount: 3n,
    })
    tx.transferObjects([balance], ALICE)
    expect(commandNames(tx)).toEqual([
      'dao_receipt_vault::withdraw_receipt',
      'TransferObjects',
    ])
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
    balanceManagerId: null,
    subdaoControlCapId: null,
    ...over,
  }
}

const TRADING_KEYS = [
  'sweep_multicoin_to_dao_vault::SweepMulticoinToDaoVault',
  'sweep_coin_to_treasury::SweepCoinToTreasury',
].map((t) => `${ids.armatureTrading}::${t}`)

function daoJson() {
  return {
    enabled_proposal_types: { contents: TRADING_KEYS },
    proposal_configs: {
      contents: TRADING_KEYS.map((key) => ({
        key,
        value: {
          quorum: 1,
          approval_threshold: 5000,
          propose_threshold: '0',
          expiry_ms: '3600000',
          execution_delay_ms: '0',
          cooldown_ms: '0',
          composable_allowed: false,
        },
      })),
    },
    type_bindings: { contents: [] },
  }
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
  const getObject = jest.fn(async ({ objectId }: any) => {
    if (objectId === ids.daoReceiptVaultRegistry) {
      return { object: { json: { vaults: { id: { id: TABLE } } } } }
    }
    return { object: { json: daoJson() } }
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
        norm(org) === norm(key.registrant_dao_id)
      )
    })
    if (!hit) throw new Error('no vault')
    return {
      dynamicField: { value: { bcs: bcs.Address.serialize(hit[1]).toBytes() } },
    }
  })
  const handle = new OrgHandle(
    {
      suiClient: {
        core: {
          getObject,
          getDynamicField,
          getCoins: async () => ({ objects: [] }),
        },
      } as never,
      indexer: {
        hubVault: async () => ({
          collectionId: COLLECTION,
          vaultConfigId: hex('53'),
        }),
        sweepable: async () =>
          opts.sweepable ?? { balanceManagerId: BM, pools: [], items: [] },
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
          capabilityVaultId: CAPS,
          treasuryId: TREASURY,
          members: [ALICE],
          subdaoControlCapId: hex('e7'),
          balanceManagerId: BM,
        }),
      ],
    }),
    OFFICERS,
  )
  return { handle, executor, captured }
}

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

  it('init defaults edit to the PARENT unit, not the acting one', async () => {
    const { handle, captured } = harness()
    await handle.vault.init({ storageUnitId: SSU })
    const tx = captured.txs[0]
    expect(commandNames(tx).at(-1)).toBe(
      'dao_receipt_vault::initialize_dao_vault_v2',
    )
    // Three acl::ou calls: deposit + withdraw on OFFICERS, edit on ROOT.
    const ouArgs = (tx.getData().inputs as any[])
      .map((i) => i?.UnresolvedObject?.objectId ?? i?.Pure?.bytes)
      .filter(Boolean)
    expect(commandNames(tx).filter((n) => n === 'acl::ou')).toHaveLength(3)
    expect(ouArgs.length).toBeGreaterThan(0)
  })

  it('routes an edit+ou grant through the witnessed path', async () => {
    const { handle, captured } = harness()
    await handle.vault.grant({
      vaultId: VAULT,
      grants: [
        { role: 'edit', principal: { kind: 'ou', value: ROOT } },
        { role: 'deposit', principal: { kind: 'player', value: ALICE } },
      ],
    })
    const names = commandNames(captured.txs[0])
    // grant_edit_ou for the ou editor; plain grant for the rest.
    expect(names).toContain('dao_receipt_vault::grant_edit_ou')
    expect(names).toContain('dao_receipt_vault::grant')
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
        balanceManagerId: BM,
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
    expect(names).toContain('sweep_multicoin_to_dao_vault::new')
    expect(names).toContain('sweep_coin_to_treasury::new')
  })

  it('REPORTS stacks with no vault instead of dropping them', async () => {
    const OTHER_SSU = hex('57')
    const { handle, captured } = harness({
      // A vault at SSU only — the stack at OTHER_SSU has nowhere to go.
      vaultFor: { [`${SSU}|${OFFICERS}`]: VAULT },
      sweepable: {
        balanceManagerId: BM,
        pools: [],
        items: [item(SSU, '70810', 4n), item(OTHER_SSU, '999', 2n)],
      },
    })
    const res = await handle.orders.sweepAll()

    // The resolvable stack still moves…
    expect(res.status).toBe('executed')
    expect(commandNames(captured.txs[0])).toContain(
      'sweep_multicoin_to_dao_vault::new',
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

  it('refuses when there is nothing to sweep at all', async () => {
    const { handle } = harness({
      sweepable: { balanceManagerId: BM, pools: [], items: [] },
    })
    await expect(handle.orders.sweepAll()).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
      message: expect.stringContaining('Nothing to sweep'),
    })
  })

  it('explains when every stack was skipped for want of a vault', async () => {
    const { handle } = harness({
      sweepable: {
        balanceManagerId: BM,
        pools: [],
        items: [item(SSU, '70810', 4n)],
      },
    })
    await expect(handle.orders.sweepAll()).rejects.toMatchObject({
      message: expect.stringContaining('no shared storage registered'),
    })
  })
})

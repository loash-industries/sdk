/**
 * Direct unit tests for the fullnode resolution helpers and the hangar
 * sourcing path (borrow_owner_cap → deposit_for_receipt → return_owner_cap →
 * deposit_multicoin), against fake cores shaped like the v2 gRPC client.
 */
import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'

import {
  MultiCoinBalanceBcs,
  fetchCharacterInfo,
  fetchInventorySlotQuantity,
  fetchSsuOwnerInfo,
  findOwnedItemReceipts,
  getObjectRef,
  getRegistryMulticoinCollectionId,
  getWalletCurrencyBalance,
} from '../src/onchain'
import { sourceItemsIntoBalanceManager } from '../src/funding'
import { TriexError } from '../src/errors'
import { STILLNESS_PACKAGE_IDS } from '../src/config'

const IDS = STILLNESS_PACKAGE_IDS
const OWNER = '0x' + 'ab'.repeat(32)
const SSU = '0x' + 'dd'.repeat(32)
const SSU_CAP = '0x' + 'd1'.repeat(32)
const CHAR_ID = '0x' + 'c1'.repeat(32)
const CHAR_CAP = '0x' + 'c2'.repeat(32)
const COLLECTION = '0x' + 'f1'.repeat(32)
const VAULT_CFG = '0x' + 'f2'.repeat(32)

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const capKeyHex = (capId: string) => hex(bcs.Address.serialize(capId).toBytes())

const asyncCore = (impl: Record<string, (args: any) => any>) => ({
  core: Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, async (args: any) => fn(args)]),
  ),
})

describe('getWalletCurrencyBalance', () => {
  it('sums coin pages following hasNextPage/cursor', async () => {
    const pages = [
      {
        objects: [{ balance: '10' }, { balance: '5' }],
        hasNextPage: true,
        cursor: 'c1',
      },
      { objects: [{ balance: '7' }], hasNextPage: false, cursor: null },
    ]
    const calls: unknown[] = []
    const sui = asyncCore({
      listCoins: (args) => {
        calls.push(args.cursor)
        return pages.shift()
      },
    })
    const total = await getWalletCurrencyBalance(sui as any, OWNER, 'CRED')
    expect(total).toBe(22n)
    expect(calls).toEqual([undefined, 'c1'])
  })
})

describe('getObjectRef', () => {
  it('returns the receivingRef triple', async () => {
    const sui = asyncCore({
      getObject: () => ({
        object: { objectId: CHAR_CAP, version: '9', digest: 'dg' },
      }),
    })
    expect(await getObjectRef(sui as any, CHAR_CAP)).toEqual({
      objectId: CHAR_CAP,
      version: '9',
      digest: 'dg',
    })
  })
})

describe('getRegistryMulticoinCollectionId', () => {
  it('parses the Address value of the registry singleton field', async () => {
    const sui = asyncCore({
      getDynamicField: (args) => {
        expect(args.parentId).toBe(IDS.triexRegistry)
        return {
          dynamicField: {
            value: { bcs: bcs.Address.serialize(COLLECTION).toBytes() },
          },
        }
      },
    })
    expect(await getRegistryMulticoinCollectionId(sui as any, IDS)).toBe(
      COLLECTION,
    )
  })
})

describe('findOwnedItemReceipts', () => {
  it('BCS-decodes receipt pages and filters by asset id', async () => {
    const content = (assetId: bigint, amount: bigint) =>
      MultiCoinBalanceBcs.serialize({
        id: '0x' + 'ee'.repeat(32),
        collection: COLLECTION,
        asset_id: assetId,
        amount,
      }).toBytes()
    const sui = asyncCore({
      listOwnedObjects: () => ({
        objects: [
          { objectId: '0x' + '01'.repeat(32), content: content(70810n, 4n) },
          { objectId: '0x' + '02'.repeat(32), content: content(99999n, 9n) },
          { objectId: '0x' + '03'.repeat(32), content: new Uint8Array([1]) }, // undecodable → skipped
        ],
        hasNextPage: false,
      }),
    })
    const receipts = await findOwnedItemReceipts(sui as any, IDS, OWNER, {
      assetId: '70810',
    })
    expect(receipts).toEqual([
      {
        objectId: '0x' + '01'.repeat(32),
        collectionId: COLLECTION,
        assetId: '70810',
        amount: 4n,
      },
    ])
  })
})

describe('fetchCharacterInfo', () => {
  it('resolves PlayerProfile → character → owner cap', async () => {
    const sui = asyncCore({
      listOwnedObjects: (args) =>
        String(args.type).includes('PlayerProfile')
          ? { objects: [{ json: { character_id: CHAR_ID } }] }
          : { objects: [] },
      getObject: (args) => {
        expect(args.objectId).toBe(CHAR_ID)
        return { object: { json: { owner_cap_id: CHAR_CAP } } }
      },
    })
    expect(await fetchCharacterInfo(sui as any, IDS, OWNER)).toEqual({
      characterId: CHAR_ID,
      ownerCapId: CHAR_CAP,
    })
  })

  it('returns null when no profile exists', async () => {
    const sui = asyncCore({ listOwnedObjects: () => ({ objects: [] }) })
    expect(await fetchCharacterInfo(sui as any, IDS, OWNER)).toBeNull()
  })
})

describe('fetchSsuOwnerInfo', () => {
  const objects: Record<string, any> = {
    [SSU]: { json: { owner_cap_id: SSU_CAP } },
    [SSU_CAP]: { owner: { AddressOwner: CHAR_ID } },
    [CHAR_ID]: {
      json: { character_address: OWNER, owner_cap_id: CHAR_CAP },
    },
  }
  const sui = asyncCore({
    getObject: (args) => ({ object: objects[args.objectId] ?? { json: {} } }),
  })

  it('follows SSU cap → holding character → char cap for the owner', async () => {
    expect(await fetchSsuOwnerInfo(sui as any, SSU, OWNER)).toEqual({
      ssuOwnerCapId: SSU_CAP,
      characterId: CHAR_ID,
      charOwnerCapId: CHAR_CAP,
    })
  })

  it('returns null for a non-owner', async () => {
    expect(
      await fetchSsuOwnerInfo(sui as any, SSU, '0x' + '99'.repeat(32)),
    ).toBeNull()
  })
})

describe('fetchInventorySlotQuantity', () => {
  it('sums matching type_id entries of the slot contents', async () => {
    const sui = asyncCore({
      getDynamicField: () => ({ dynamicField: { fieldId: '0xfield' } }),
      getObject: () => ({
        object: {
          json: {
            value: {
              items: {
                contents: [
                  { key: '1', value: { type_id: '70810', quantity: '30' } },
                  { key: '2', value: { type_id: '70810', quantity: '12' } },
                  { key: '3', value: { type_id: '555', quantity: '99' } },
                ],
              },
            },
          },
        },
      }),
    })
    expect(
      await fetchInventorySlotQuantity(sui as any, SSU, CHAR_CAP, '70810'),
    ).toBe(42n)
  })

  it('returns 0n when the slot does not exist', async () => {
    const sui = asyncCore({
      getDynamicField: () => {
        throw new Error('not found')
      },
    })
    expect(
      await fetchInventorySlotQuantity(sui as any, SSU, CHAR_CAP, '70810'),
    ).toBe(0n)
  })
})

// ─── hangar sourcing (funding.ts step 2 + transactions.sourceItemsFromHangar) ─

const commandNames = (tx: Transaction) =>
  tx
    .getData()
    .commands.map((c: any) =>
      c.$kind === 'MoveCall'
        ? `${c.MoveCall.module}::${c.MoveCall.function}`
        : c.$kind,
    )

function hangarCore(opts: {
  ssuOwner: boolean
  slotQty: Record<string, bigint>
}) {
  const fieldFor: Record<string, string> = {}
  let fieldSeq = 0
  const objects: Record<string, any> = {
    [SSU]: opts.ssuOwner ? { json: { owner_cap_id: SSU_CAP } } : { json: {} },
    [SSU_CAP]: { owner: { AddressOwner: CHAR_ID } },
    [CHAR_ID]: { json: { character_address: OWNER, owner_cap_id: CHAR_CAP } },
    [CHAR_CAP]: { objectId: CHAR_CAP, version: '3', digest: 'dg' },
    [SSU_CAP + 'ref']: {},
  }
  return asyncCore({
    // wallet receipts: none
    listOwnedObjects: (args) =>
      String(args.type).includes('multicoin::Balance')
        ? { objects: [], hasNextPage: false }
        : { objects: [{ json: { character_id: CHAR_ID } }] },
    getObject: (args) => {
      if (args.objectId === SSU_CAP) {
        // both the owner lookup and the receivingRef fetch hit this id
        return {
          object: {
            objectId: SSU_CAP,
            version: '2',
            digest: 'dg2',
            owner: { AddressOwner: CHAR_ID },
          },
        }
      }
      const known = objects[args.objectId]
      if (known) return { object: { ...known, objectId: args.objectId } }
      // hangar slot field object
      const capId = fieldFor[args.objectId]
      const qty = opts.slotQty[capId] ?? 0n
      return {
        object: {
          json: {
            value: {
              items: {
                contents: [
                  {
                    key: '1',
                    value: { type_id: '70810', quantity: qty.toString() },
                  },
                ],
              },
            },
          },
        },
      }
    },
    getDynamicField: (args) => {
      const nameHex = hex(args.name.bcs)
      const capId =
        nameHex === capKeyHex(SSU_CAP)
          ? SSU_CAP
          : nameHex === capKeyHex(CHAR_CAP)
            ? CHAR_CAP
            : 'unknown'
      const fieldId = `0xfield${fieldSeq++}`
      fieldFor[fieldId] = capId
      return { dynamicField: { fieldId } }
    },
  })
}

describe('sourceItemsIntoBalanceManager — hangar paths', () => {
  const base = {
    owner: OWNER,
    ssuObjectId: SSU,
    vaultConfigId: VAULT_CFG,
    vaultCollectionId: COLLECTION,
    assetId: 70810n,
    balanceManagerId: null,
    deficitMode: false as const,
  }

  it('non-owner: sources the full amount from the character hangar slot', async () => {
    const sui = hangarCore({ ssuOwner: false, slotQty: { [CHAR_CAP]: 50n } })
    const tx = new Transaction()
    const bm = tx.object('0x' + 'b1'.repeat(32))
    await sourceItemsIntoBalanceManager(sui as any, tx, IDS, bm, {
      ...base,
      amount: 5n,
    })
    expect(commandNames(tx)).toEqual([
      'character::borrow_owner_cap',
      'receipt::deposit_for_receipt',
      'character::return_owner_cap',
      'balance_manager::deposit_multicoin',
    ])
  })

  it('hub owner: drains the SSU slot first, then the character slot', async () => {
    const sui = hangarCore({
      ssuOwner: true,
      slotQty: { [SSU_CAP]: 3n, [CHAR_CAP]: 10n },
    })
    const tx = new Transaction()
    const bm = tx.object('0x' + 'b1'.repeat(32))
    await sourceItemsIntoBalanceManager(sui as any, tx, IDS, bm, {
      ...base,
      amount: 5n, // 3 from SSU slot + 2 from character slot
    })
    expect(commandNames(tx)).toEqual([
      'character::borrow_owner_cap',
      'receipt::deposit_for_receipt',
      'character::return_owner_cap',
      'balance_manager::deposit_multicoin',
      'character::borrow_owner_cap',
      'receipt::deposit_for_receipt',
      'character::return_owner_cap',
      'balance_manager::deposit_multicoin',
    ])
  })

  it('throws typed InsufficientBalance when hangar slots cannot cover', async () => {
    const sui = hangarCore({
      ssuOwner: true,
      slotQty: { [SSU_CAP]: 1n, [CHAR_CAP]: 1n },
    })
    const tx = new Transaction()
    const bm = tx.object('0x' + 'b1'.repeat(32))
    await expect(
      sourceItemsIntoBalanceManager(sui as any, tx, IDS, bm, {
        ...base,
        amount: 5n,
      }),
    ).rejects.toMatchObject({ code: TriexError.InsufficientBalance })
  })
})

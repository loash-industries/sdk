/**
 * Hauling-agreement writes: the PTB builders (ported from triex-app-api
 * `src/hauling/tx.ts`, so the same command sequences) and the
 * `client.hauling` write flows that source coins and item balances.
 */
import { jest } from '@jest/globals'
import { Transaction } from '@mysten/sui/transactions'

import { STILLNESS_PACKAGE_IDS } from '../src/config'
import { TriexError } from '../src/errors'
import { HangarCapBorrows, sourceItemBalance } from '../src/funding'
import {
  acceptAgreement,
  cancelAgreement,
  collectProceeds,
  deleteListerCap,
  endAgreement,
  haulingIds,
  postAgreement,
} from '../src/hauling/transactions'
import { MultiCoinBalanceBcs } from '../src/onchain'
import { depositForReceipt } from '../src/transactions'
import { TriexClient } from '../src/TriexClient'

const IDS = STILLNESS_PACKAGE_IDS
const H = haulingIds(IDS)
const CRED = IDS.credCoinType
const OWNER = '0x' + 'ab'.repeat(32)
const AGREEMENT = '0x' + 'a1'.repeat(32)
const CAP = '0x' + 'ca'.repeat(32)
const PROCEEDS = '0x' + 'pe'.replace('p', 'd').repeat(32)
const ORG = '0x' + '0a'.repeat(32)
const COLLECTION = '0x' + 'c0'.repeat(32)
const DEST_COLLECTION = '0x' + 'd0'.repeat(32)
const PICKUP = '1001'
const DEST = '2002'

// ─── helpers ─────────────────────────────────────────────────────────────────

interface Cmd {
  fn: string
  pkg?: string
  typeArgs: string[]
}

function cmds(tx: Transaction): Cmd[] {
  return (tx.getData().commands as any[]).map((c) =>
    c.$kind === 'MoveCall'
      ? {
          fn: `${c.MoveCall.module}::${c.MoveCall.function}`,
          pkg: c.MoveCall.package,
          typeArgs: c.MoveCall.typeArguments,
        }
      : { fn: c.$kind, typeArgs: [] },
  )
}
const names = (tx: Transaction) => cmds(tx).map((c) => c.fn)

function routeFetch(routes: Array<[string, unknown]>): void {
  ;(global as any).fetch = jest.fn(async (url: unknown) => {
    const s = String(url)
    const hit = routes.find(([pattern]) => s.includes(pattern))
    if (!hit) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({}),
      }
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => hit[1] }
  })
}

const receipt = (
  objectId: string,
  amount: bigint,
  collection = COLLECTION,
  assetId = 78437n,
) => ({
  objectId,
  content: MultiCoinBalanceBcs.serialize({
    id: objectId,
    collection,
    asset_id: assetId,
    amount,
  }).toBytes(),
})

function fakeSui(opts: {
  receipts?: ReturnType<typeof receipt>[]
  coins?: bigint[]
}): any {
  return {
    core: {
      listOwnedObjects: async () => ({
        objects: opts.receipts ?? [],
        hasNextPage: false,
      }),
      listCoins: async () => ({
        objects: (opts.coins ?? []).map((b, i) => ({
          objectId: '0x' + String(i + 1).padStart(64, '0'),
          balance: b.toString(),
        })),
        hasNextPage: false,
      }),
    },
  }
}

function captureExecutor() {
  const captured: { tx?: Transaction } = {}
  const executor = jest.fn(async (tx: Transaction) => {
    captured.tx = tx
    return {
      digest: '0xd1gest',
      objectChanges: [
        {
          type: 'created',
          objectId: AGREEMENT,
          objectType: `${H.hauling}::hauling::HaulingAgreement<${CRED}>`,
        },
        {
          type: 'created',
          objectId: CAP,
          objectType: `${H.hauling}::hauling::ListerCap`,
        },
      ],
    }
  })
  return { executor, captured }
}

const client = (sui: any, executor: any) =>
  new TriexClient({
    suiClient: sui,
    apiKey: 'k',
    indexerUrl: 'https://api.example.test',
    address: OWNER,
    executor,
  })

afterEach(() => jest.restoreAllMocks())

// ─── builders ────────────────────────────────────────────────────────────────

describe('hauling builders', () => {
  const zero = (tx: Transaction) =>
    tx.moveCall({ target: '0x2::coin::zero', typeArguments: [CRED] })[0]

  it('posts with a claim gate and a fixed beneficiary', () => {
    const tx = new Transaction()
    const cap = postAgreement(tx, H, {
      currency: CRED,
      cargo: [tx.object(AGREEMENT)],
      reward: zero(tx),
      postFeeCoinType: '0x2::sui::SUI',
      postFee: zero(tx),
      want: [{ collectionId: DEST_COLLECTION, assetId: '78437', quantity: 5n }],
      collateral: 10n,
      acceptWindowMs: 3_600_000,
      haulDurationMs: 86_400_000,
      beneficiary: OWNER,
      principals: [
        { kind: 'player', address: OWNER },
        { kind: 'ou', orgId: ORG },
      ],
    })
    expect(cap).toBeDefined()
    expect(names(tx)).toEqual([
      'coin::zero',
      'coin::zero',
      'spec::new',
      'MakeMoveVec',
      'terms::new',
      'MakeMoveVec',
      'hauling::draft',
      'acl::player',
      'acl::ou',
      'MakeMoveVec',
      'claim::requirement',
      'hauling::require_to_accept',
      'hauling::publish',
    ])
    const draft = cmds(tx).find((c) => c.fn === 'hauling::draft')!
    expect(draft.typeArgs).toEqual([CRED, '0x2::sui::SUI'])
    // spec::Spec type tags use agreements' ORIGINAL id; calls the current.
    const want = (tx.getData().commands as any[]).find(
      (c) => c.$kind === 'MakeMoveVec',
    )
    expect(want.MakeMoveVec.type).toBe(`${H.agreementsOriginal}::spec::Spec`)
    expect(cmds(tx).find((c) => c.fn === 'spec::new')!.pkg).toBe(H.agreements)
  })

  it('tags acl::Principal with roles’ ORIGINAL id once roles is upgraded', () => {
    const upgraded = haulingIds({
      ...IDS,
      roles: '0x' + '9e'.repeat(32),
      rolesOriginal: IDS.roles,
    })
    const tx = new Transaction()
    postAgreement(tx, upgraded, {
      currency: CRED,
      cargo: [tx.object(AGREEMENT)],
      reward: zero(tx),
      postFeeCoinType: CRED,
      postFee: zero(tx),
      want: [{ collectionId: DEST_COLLECTION, assetId: '1', quantity: 1n }],
      collateral: 1n,
      acceptWindowMs: 1,
      haulDurationMs: 1,
      principals: [{ kind: 'ou', orgId: ORG }],
    })
    const vecs = (tx.getData().commands as any[]).filter(
      (c) => c.$kind === 'MakeMoveVec',
    )
    expect(vecs.at(-1).MakeMoveVec.type).toBe(`${IDS.roles}::acl::Principal`)
    expect(cmds(tx).find((c) => c.fn === 'acl::ou')!.pkg).toBe(
      '0x' + '9e'.repeat(32),
    )
  })

  it('pays the cap holder and skips the gate when none is given', () => {
    const tx = new Transaction()
    postAgreement(tx, H, {
      currency: CRED,
      cargo: [tx.object(AGREEMENT)],
      reward: zero(tx),
      postFeeCoinType: CRED,
      postFee: zero(tx),
      want: [{ collectionId: DEST_COLLECTION, assetId: 1n, quantity: 1n }],
      collateral: 1n,
      acceptWindowMs: 1,
      haulDurationMs: 1,
    })
    expect(names(tx)).toContain('terms::new_for_cap_holder')
    expect(names(tx)).not.toContain('claim::requirement')
  })

  it('rejects an empty want list', () => {
    const tx = new Transaction()
    expect(() =>
      postAgreement(tx, H, {
        currency: CRED,
        cargo: [],
        reward: zero(tx),
        postFeeCoinType: CRED,
        postFee: zero(tx),
        want: [],
        collateral: 1n,
        acceptWindowMs: 1,
        haulDurationMs: 1,
      }),
    ).toThrow(/wanted item/)
  })

  it('accepts directly when there is no claim gate', () => {
    const tx = new Transaction()
    acceptAgreement(tx, H, {
      agreementId: AGREEMENT,
      currency: CRED,
      collateral: zero(tx),
      steps: [],
    })
    expect(names(tx)).toEqual(['coin::zero', 'hauling::accept'])
  })

  it('satisfies each gate in requirement order between begin and finish', () => {
    const tx = new Transaction()
    acceptAgreement(tx, H, {
      agreementId: AGREEMENT,
      currency: CRED,
      collateral: zero(tx),
      steps: [
        { reqIndex: 1, action: 'satisfy', orgId: ORG },
        { reqIndex: 0, action: 'satisfy_directly', orgId: null },
      ],
    })
    expect(names(tx)).toEqual([
      'coin::zero',
      'hauling::begin_accept',
      'claim::satisfy_directly',
      'claim::satisfy',
      'hauling::finish_accept',
    ])
  })

  it('refuses a plan it cannot satisfy', () => {
    const tx = new Transaction()
    expect(() =>
      acceptAgreement(tx, H, {
        agreementId: AGREEMENT,
        currency: CRED,
        collateral: zero(tx),
        steps: [{ reqIndex: 0, action: 'not_satisfiable', orgId: null }],
      }),
    ).toThrow(/claim list/)
  })

  it('cancels, returning cargo and reward to the owner', () => {
    const tx = new Transaction()
    cancelAgreement(tx, H, {
      agreementId: AGREEMENT,
      capId: CAP,
      currency: CRED,
      owner: OWNER,
    })
    expect(names(tx)).toEqual([
      'hauling::cancel',
      'payout::pay_all',
      'TransferObjects',
    ])
  })

  it('collects proceeds: destroys the empty coin after a delivery', () => {
    const delivered = new Transaction()
    collectProceeds(delivered, H, {
      capId: CAP,
      proceedsId: PROCEEDS,
      currency: CRED,
      owner: OWNER,
      delivered: true,
    })
    expect(names(delivered)).toEqual([
      'hauling::collect',
      'payout::pay_all',
      'coin::destroy_zero',
    ])
    const defaulted = new Transaction()
    collectProceeds(defaulted, H, {
      capId: CAP,
      proceedsId: PROCEEDS,
      currency: CRED,
      owner: OWNER,
      delivered: false,
    })
    expect(names(defaulted)).toEqual([
      'hauling::collect',
      'payout::pay_all',
      'TransferObjects',
    ])
  })

  it('defaults, forfeits and deletes caps', () => {
    const tx = new Transaction()
    endAgreement(tx, H, {
      agreementId: AGREEMENT,
      currency: CRED,
      kind: 'default',
    })
    endAgreement(tx, H, {
      agreementId: AGREEMENT,
      currency: CRED,
      kind: 'forfeit',
    })
    deleteListerCap(tx, H, CAP)
    expect(names(tx)).toEqual([
      'hauling::default',
      'hauling::forfeit',
      'hauling::delete_cap',
    ])
  })

  it('fails typed on a network without hauling', () => {
    expect(() => haulingIds({ ...IDS, haulingAgreements: undefined })).toThrow(
      /not deployed/,
    )
  })
})

// ─── item sourcing ───────────────────────────────────────────────────────────

describe('sourceItemBalance', () => {
  it('takes one exact receipt as is', async () => {
    const tx = new Transaction()
    await sourceItemBalance(
      fakeSui({ receipts: [receipt('0x' + '01'.repeat(32), 5n)] }),
      tx,
      IDS,
      { owner: OWNER, collectionId: COLLECTION, assetId: 78437n, quantity: 5n },
    )
    expect(names(tx)).toEqual([])
  })

  it('joins largest first and splits off exactly the quantity', async () => {
    const tx = new Transaction()
    await sourceItemBalance(
      fakeSui({
        receipts: [
          receipt('0x' + '01'.repeat(32), 2n),
          receipt('0x' + '02'.repeat(32), 4n),
          // Other collection: never used.
          receipt('0x' + '03'.repeat(32), 50n, DEST_COLLECTION),
        ],
      }),
      tx,
      IDS,
      { owner: OWNER, collectionId: COLLECTION, assetId: 78437n, quantity: 5n },
    )
    expect(names(tx)).toEqual(['multicoin::join_entry', 'multicoin::split'])
  })

  it('fails typed when receipts fall short and no hangar is given', async () => {
    await expect(
      sourceItemBalance(
        fakeSui({ receipts: [receipt('0x' + '01'.repeat(32), 2n)] }),
        new Transaction(),
        IDS,
        {
          owner: OWNER,
          collectionId: COLLECTION,
          assetId: 78437n,
          quantity: 5n,
        },
      ),
    ).rejects.toMatchObject({ code: TriexError.InsufficientBalance })
  })
})

describe('HangarCapBorrows — several hangar items in one transaction', () => {
  // A PTB can receive an object once: a second `borrow_owner_cap` of the same
  // cap fails on chain with ArgumentWithoutValue. Found simulating a
  // three-item hauling post on testnet; the app borrows once per cap too.
  const CHAR = '0x' + 'cc'.repeat(32)
  const CHAR_CAP = '0x' + 'c1'.repeat(32)
  const SSU_CAP = '0x' + 'c2'.repeat(32)
  const sui = {
    core: {
      getObject: async ({ objectId }: { objectId: string }) => ({
        object: {
          objectId,
          version: '7',
          digest: '11111111111111111111111111111111',
        },
      }),
    },
  } as any
  const deposit = (
    tx: Transaction,
    held: { character: any; cap: any },
    capTypeArg: string,
    assetId: bigint,
  ) =>
    depositForReceipt(tx, IDS, {
      ssuObjectId: '0x' + '55'.repeat(32),
      ...held,
      capTypeArg,
      vaultConfigId: '0x' + '56'.repeat(32),
      vaultCollectionId: COLLECTION,
      assetId,
      amount: 1,
    })

  it('borrows each cap once, deposits every item under it, returns it once', async () => {
    const tx = new Transaction()
    const borrows = new HangarCapBorrows(sui, tx, IDS)
    const charType = `${IDS.worldOriginal}::character::Character`
    const ssuType = `${IDS.worldOriginal}::storage_unit::StorageUnit`
    for (const asset of [1n, 2n, 3n]) {
      deposit(tx, await borrows.cap(CHAR_CAP, charType, CHAR), charType, asset)
    }
    deposit(tx, await borrows.cap(SSU_CAP, ssuType, CHAR), ssuType, 4n)
    borrows.returnAll()

    expect(names(tx)).toEqual([
      'character::borrow_owner_cap',
      'receipt::deposit_for_receipt',
      'receipt::deposit_for_receipt',
      'receipt::deposit_for_receipt',
      'character::borrow_owner_cap',
      'receipt::deposit_for_receipt',
      'character::return_owner_cap',
      'character::return_owner_cap',
    ])
    // Each cap is a receiving input exactly once.
    const receiving = (tx.getData().inputs as any[]).filter(
      (i) => i.Object?.Receiving,
    )
    expect(receiving.map((i) => i.Object.Receiving.objectId)).toEqual([
      CHAR_CAP,
      SSU_CAP,
    ])
    // Returned with the type it was borrowed as.
    const returns = cmds(tx).filter(
      (c) => c.fn === 'character::return_owner_cap',
    )
    expect(returns.map((c) => c.typeArgs[0])).toEqual([charType, ssuType])
    // returnAll is idempotent: nothing left to return.
    borrows.returnAll()
    expect(
      names(tx).filter((n) => n.endsWith('return_owner_cap')),
    ).toHaveLength(2)
  })
})

// ─── client.hauling writes ───────────────────────────────────────────────────

const coin = { coin_type: CRED, symbol: 'CRED', name: null, decimals: 9 }
const party = { address: OWNER, character_name: null }
const zeroCap = {
  cap_id: CAP,
  owner_kind: 'address',
  owner: OWNER,
  owner_name: null,
  receives_proceeds: true,
  ended_kind: null,
}

function detail(over: Record<string, unknown> = {}) {
  return {
    agreement_id: AGREEMENT,
    status: 'open',
    posted_at: 1,
    accept_deadline_at: 2,
    haul_duration_ms: 3,
    lister: party,
    beneficiary: party,
    pays_cap_holder: true,
    on_behalf_of: null,
    cargo: [],
    want: [
      {
        collection_id: DEST_COLLECTION,
        asset_id: '78437',
        quantity: '5',
        hub_id: null,
        hub_name: null,
        verified: true,
      },
    ],
    currency: coin,
    reward: '1000',
    collateral: '300',
    delivery_fee_bps: 250,
    claim_gated: false,
    has_other_rules: false,
    hauler: null,
    hauler_identity: null,
    accepted_at: null,
    delivery_deadline_at: null,
    closed_at: null,
    closed_by: null,
    hauler_reward: null,
    delivery_fee: null,
    refunded_to: null,
    cap_id: CAP,
    posted_tx_digest: 'D',
    accepted_tx_digest: null,
    closed_tx_digest: null,
    requirements: [],
    observer: null,
    cap: zeroCap,
    proceeds: null,
    fees: {
      post_fee: null,
      delivery_fee_bps: 250,
      delivery_fee: null,
      treasury: OWNER,
    },
    claims: [],
    timeline: [],
    viewer: null,
    evaluated_at: 9,
    ...over,
  }
}

describe('client.hauling writes', () => {
  it('posts: cargo from wallet receipts, the fee split off the reward', async () => {
    routeFetch([
      [
        `/v1/hubs/${PICKUP}/vault`,
        {
          hub_id: PICKUP,
          collection_id: COLLECTION,
          vault_config_id: COLLECTION,
        },
      ],
      [
        `/v1/hubs/${DEST}/vault`,
        {
          hub_id: DEST,
          collection_id: DEST_COLLECTION,
          vault_config_id: DEST_COLLECTION,
        },
      ],
      [
        '/v1/agreements/config',
        {
          config_id: H.config,
          currencies: [coin],
          post_fee: { currency: coin, amount: '50' },
          delivery_fee_bps: 250,
          treasury: OWNER,
          updated_at: 1,
          history: [],
        },
      ],
    ])
    const { executor, captured } = captureExecutor()
    const posted = await client(
      fakeSui({
        receipts: [receipt('0x' + '01'.repeat(32), 5n)],
        coins: [2000n],
      }),
      executor,
    ).hauling.post({
      pickupStorageUnitId: PICKUP,
      destinationStorageUnitId: DEST,
      cargo: [{ assetId: '78437', quantity: 5n }],
      reward: 1000n,
      collateral: 300n,
      acceptWindowMs: 3_600_000,
      haulDurationMs: 86_400_000,
    })
    expect(posted).toMatchObject({ agreementId: AGREEMENT, capId: CAP })
    const tx = captured.tx!
    expect(names(tx)).toEqual([
      // reward + fee in one funding split, then the fee off it
      'SplitCoins',
      'SplitCoins',
      'spec::new',
      'MakeMoveVec',
      'terms::new_for_cap_holder',
      'MakeMoveVec',
      'hauling::draft',
      'hauling::publish',
      'TransferObjects',
    ])
    const draft = cmds(tx).find((c) => c.fn === 'hauling::draft')!
    expect(draft.typeArgs).toEqual([CRED, CRED])
  })

  it('accepts through the claim plan the gateway returns for the player', async () => {
    routeFetch([
      [
        `/v1/agreements/${AGREEMENT}`,
        detail({
          claim_gated: true,
          viewer: {
            address: OWNER,
            roles: [],
            claim_plan: {
              eligibility: 'eligible',
              steps: [
                {
                  req_index: 0,
                  rule: 'claim',
                  type_name: 'x::claim::ClaimGate',
                  is_identity_rule: false,
                  action: 'satisfy',
                  org_id: ORG,
                },
              ],
            },
          },
        }),
      ],
    ])
    const { executor, captured } = captureExecutor()
    await client(fakeSui({ coins: [300n] }), executor).hauling.accept({
      agreementId: AGREEMENT,
    })
    expect(names(captured.tx!)).toEqual([
      'SplitCoins',
      'hauling::begin_accept',
      'claim::satisfy',
      'hauling::finish_accept',
      'payout::pay_all',
    ])
  })

  it('delivers the wanted items from wallet receipts', async () => {
    routeFetch([
      [`/v1/agreements/${AGREEMENT}`, detail({ status: 'accepted' })],
    ])
    const { executor, captured } = captureExecutor()
    await client(
      fakeSui({
        receipts: [receipt('0x' + '07'.repeat(32), 5n, DEST_COLLECTION)],
      }),
      executor,
    ).hauling.deliver({ agreementId: AGREEMENT })
    expect(names(captured.tx!)).toEqual(['MakeMoveVec', 'hauling::deliver'])
  })

  it('refuses writes the agreement’s status rules out, before signing', async () => {
    routeFetch([
      [`/v1/agreements/${AGREEMENT}`, detail({ status: 'delivered' })],
    ])
    const { executor } = captureExecutor()
    const c = client(fakeSui({}), executor)
    for (const call of [
      () => c.hauling.accept({ agreementId: AGREEMENT }),
      () => c.hauling.deliver({ agreementId: AGREEMENT }),
      () => c.hauling.cancel({ agreementId: AGREEMENT }),
      () => c.hauling.default({ agreementId: AGREEMENT }),
      () => c.hauling.forfeit({ agreementId: AGREEMENT }),
      () => c.hauling.collect({ agreementId: AGREEMENT }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: TriexError.ValidationFailed,
      })
    }
    expect(executor).not.toHaveBeenCalled()
  })

  it('collects proceeds after a delivery and deletes a spent cap', async () => {
    routeFetch([
      [
        `/v1/agreements/${AGREEMENT}`,
        detail({
          status: 'delivered',
          proceeds: {
            proceeds_id: PROCEEDS,
            collected: false,
            collected_by: null,
          },
        }),
      ],
    ])
    const { executor, captured } = captureExecutor()
    const c = client(fakeSui({}), executor)
    await c.hauling.collect({ agreementId: AGREEMENT })
    expect(names(captured.tx!)).toEqual([
      'hauling::collect',
      'payout::pay_all',
      'coin::destroy_zero',
    ])
    // This cap receives proceeds, so it can't be deleted.
    await expect(
      c.hauling.deleteCap({ agreementId: AGREEMENT }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })
})

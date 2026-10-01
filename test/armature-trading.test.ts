import { jest } from '@jest/globals'
import { bcs } from '@mysten/sui/bcs'
import type { Transaction } from '@mysten/sui/transactions'

import type { DaoGovernance } from '../src/armature/governance'
import { OrgHandle } from '../src/armature/OrgClient'
import { buildPlanTx } from '../src/armature/plan'
import {
  cancelOrderAction,
  cancelOrderCoinAction,
  coinPairProposalTypes,
  createMulticoinPoolAction,
  createMulticoinPoolProposalType,
  depositCoinToBookAction,
  depositFromOuVaultToBookAction,
  extractCreatedTradingCustody,
  fetchTradingCustody,
  normalizeMoveType,
  placeLimitOrderAction,
  placeLimitOrderCoinAction,
  placeMarketOrderAction,
  setupTradingAccountAction,
  sweepCoinToTreasuryAction,
  sweepMulticoinToOuVaultAction,
  tradingProposalTypes,
  withEnabledTypeKey,
  type TradingContext,
} from '../src/armature/trading'
import type { Org, OuExecContext } from '../src/armature/types'
import { resolvePackageIds } from '../src/config'
import { TriexError } from '../src/errors'
import { computeBidQuoteDeposit, GTC_EXPIRE } from '../src/money'
import { FeeScheduleBcs } from '../src/onchain'

const hex = (pair: string) => `0x${pair.repeat(32)}`
const ids = resolvePackageIds('testnet')
const TRADING = ids.armatureTrading

const ROOT = hex('c1')
const OFFICERS = hex('c2')
const ALICE = hex('11')
const BOB = hex('12')
const ACCOUNT = hex('b0')
const CUSTODY = hex('b1')
const TREASURY = hex('44')
const VAULT = hex('47')
const POOL = hex('50')
const COLLECTION = hex('51')
const HUB = hex('52')
const COIN_POOL = hex('5c')
const CRED = ids.credCoinType
const CLOCK = `0x${'0'.repeat(63)}6`
const BASE = `${hex('ba')}::base::BASE`

const ctx: OuExecContext = {
  daoId: OFFICERS,
  board: [ALICE],
  emergencyFreezeId: hex('e4'),
}
const tctx: TradingContext = {
  armatureTrading: TRADING,
  tradingCustodyId: CUSTODY,
  tradingAccountId: ACCOUNT,
  feePolicyId: ids.triexFeePolicy,
}

// ─── PTB inspection ─────────────────────────────────────────────────────────

type Arg =
  | { object: string }
  | { pure: string }
  | { result: number }
  | { other: unknown }

interface Call {
  fn: string
  typeArgs: string[]
  args: Arg[]
}

function calls(tx: Transaction): Call[] {
  const data = tx.getData()
  const inputs = data.inputs as any[]
  const arg = (a: any): Arg => {
    if (a?.$kind === 'Input') {
      const input = inputs[a.Input]
      const objectId =
        input?.UnresolvedObject?.objectId ??
        input?.Object?.ImmOrOwnedObject?.objectId ??
        input?.Object?.SharedObject?.objectId
      if (objectId) return { object: objectId }
      if (input?.Pure) return { pure: input.Pure.bytes }
    }
    if (a?.$kind === 'Result') return { result: a.Result }
    if (a?.$kind === 'NestedResult') return { result: a.NestedResult[0] }
    return { other: a }
  }
  return data.commands.map((c: any) =>
    c.$kind === 'MoveCall'
      ? {
          fn: `${c.MoveCall.module}::${c.MoveCall.function}`,
          typeArgs: c.MoveCall.typeArguments,
          args: c.MoveCall.arguments.map(arg),
        }
      : { fn: c.$kind, typeArgs: [], args: [] },
  )
}

const commandNames = (tx: Transaction) => calls(tx).map((c) => c.fn)
const call = (tx: Transaction, fn: string) => {
  const hit = calls(tx).find((c) => c.fn === fn)
  if (!hit) throw new Error(`no ${fn} in ${commandNames(tx).join(', ')}`)
  return hit
}
const objectsOf = (c: Call) =>
  c.args.map((a) => ('object' in a ? a.object : 'result' in a ? '<ticket>' : a))
const pure = {
  id: (v: string) => bcs.Address.serialize(v).toBase64(),
  u64: (v: bigint) => bcs.u64().serialize(v).toBase64(),
  u128: (v: bigint) => bcs.u128().serialize(v).toBase64(),
  u8: (v: number) => bcs.u8().serialize(v).toBase64(),
  bool: (v: boolean) => bcs.bool().serialize(v).toBase64(),
}
const puresOf = (c: Call) =>
  c.args.map((a) => ('pure' in a ? a.pure : a)) as string[]

const own = (a: Parameters<typeof buildPlanTx>[1]) =>
  buildPlanTx('own-execute', a, ctx, ids.armature)

// ─── actions ────────────────────────────────────────────────────────────────

describe('trading actions are own-DAO only', () => {
  const actions = () => [
    setupTradingAccountAction({ armatureTrading: TRADING }),
    depositCoinToBookAction(tctx, {
      coinType: CRED,
      amount: 1n,
      treasuryVaultId: TREASURY,
    }),
    depositFromOuVaultToBookAction(tctx, {
      vaultId: VAULT,
      assetId: 1n,
      amount: 1n,
    }),
    placeLimitOrderAction(tctx, {
      quoteType: CRED,
      poolId: POOL,
      price: 1n,
      quantity: 1n,
      isBid: true,
      expireTimestamp: GTC_EXPIRE,
    }),
    placeMarketOrderAction(tctx, {
      quoteType: CRED,
      poolId: POOL,
      quantity: 1n,
      isBid: true,
    }),
    cancelOrderAction(tctx, { quoteType: CRED, poolId: POOL, orderId: 1n }),
    placeLimitOrderCoinAction(tctx, {
      baseType: BASE,
      quoteType: CRED,
      poolId: COIN_POOL,
      price: 1n,
      quantity: 1n,
      isBid: true,
      expireTimestamp: GTC_EXPIRE,
    }),
    cancelOrderCoinAction(tctx, {
      baseType: BASE,
      quoteType: CRED,
      poolId: COIN_POOL,
      orderId: 1n,
    }),
    sweepCoinToTreasuryAction(tctx, {
      coinType: CRED,
      amount: 1n,
      treasuryVaultId: TREASURY,
    }),
    sweepMulticoinToOuVaultAction(tctx, {
      vaultId: VAULT,
      collectionId: COLLECTION,
      assetId: 1n,
      amount: 1n,
    }),
  ]

  it('every order-flow action refuses to degrade into a deferred proposal', () => {
    for (const a of actions()) {
      expect(a.fallbackPolicy).toBe('single-vote-only')
      // Trading is own-DAO only; there is no Control* form of an order.
      expect(a.control).toBeUndefined()
    }
  })

  it('pool creation MAY become a proposal — a new market does not go stale', () => {
    const a = createMulticoinPoolAction(
      {
        armatureTrading: TRADING,
        triexRegistryId: ids.triexRegistry,
        feePolicyId: ids.triexFeePolicy,
      },
      {
        quoteType: CRED,
        collectionId: COLLECTION,
        assetId: 7n,
        treasuryVaultId: TREASURY,
      },
    )
    expect(a.fallbackPolicy).toBe('fall-back-to-proposal')
    expect(a.control).toBeUndefined()
  })

  it('the default display keys match the type catalog', () => {
    const catalog = [
      ...tradingProposalTypes(TRADING, CRED),
      ...coinPairProposalTypes(TRADING, BASE, CRED),
    ]
    for (const a of actions()) {
      const entry = catalog.find((e) => e.moveType === a.own!.payloadMoveType)
      expect(entry).toBeDefined()
      expect(a.own!.typeKey).toBe(entry!.typeKey)
    }
  })
})

describe('trading PTBs, command by command', () => {
  it('setup: empty payload, handler takes only the ticket', () => {
    const tx = own(setupTradingAccountAction({ armatureTrading: TRADING }))
    expect(commandNames(tx)).toEqual([
      'setup_trading_account::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_setup_trading_account',
    ])
    expect(call(tx, 'setup_trading_account::new').args).toEqual([])
    expect(
      objectsOf(call(tx, 'trading_ops::execute_setup_trading_account')),
    ).toEqual(['<ticket>'])
    expect(call(tx, 'board_voting::submit_vote_execute').typeArgs[0]).toBe(
      `${TRADING}::setup_trading_account::SetupTradingAccount`,
    )
  })

  it('deposit coin: payload names the account; treasury → custody → account', () => {
    const tx = own(
      depositCoinToBookAction(tctx, {
        coinType: BASE,
        amount: 25n,
        treasuryVaultId: TREASURY,
      }),
    )
    const payload = call(tx, 'deposit_coin_to_book::new')
    expect(payload.typeArgs).toEqual([BASE])
    expect(puresOf(payload)).toEqual([pure.id(ACCOUNT), pure.u64(25n)])
    const exec = call(tx, 'trading_ops::execute_deposit_coin_to_book')
    expect(exec.typeArgs).toEqual([BASE])
    expect(objectsOf(exec)).toEqual([TREASURY, CUSTODY, ACCOUNT, '<ticket>'])
  })

  it('deposit from vault: (vault, account, asset, amount); handler takes the acting OU', () => {
    const tx = own(
      depositFromOuVaultToBookAction(tctx, {
        vaultId: VAULT,
        assetId: 70810n,
        amount: 3n,
      }),
    )
    expect(commandNames(tx)).toEqual([
      'deposit_from_ou_vault_to_book::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_deposit_from_ou_vault_to_book',
    ])
    expect(puresOf(call(tx, 'deposit_from_ou_vault_to_book::new'))).toEqual([
      pure.id(VAULT),
      pure.id(ACCOUNT),
      pure.u64(70810n),
      pure.u64(3n),
    ])
    expect(
      objectsOf(call(tx, 'trading_ops::execute_deposit_from_ou_vault_to_book')),
    ).toEqual([VAULT, OFFICERS, CUSTODY, ACCOUNT, '<ticket>'])
  })

  it('create pool: (collection, asset); registry → policy → collection → treasury', () => {
    const tx = own(
      createMulticoinPoolAction(
        {
          armatureTrading: TRADING,
          triexRegistryId: ids.triexRegistry,
          feePolicyId: ids.triexFeePolicy,
        },
        {
          quoteType: CRED,
          collectionId: COLLECTION,
          assetId: 70810n,
          treasuryVaultId: TREASURY,
        },
      ),
    )
    expect(commandNames(tx)).toEqual([
      'create_multicoin_pool::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_create_multicoin_pool',
    ])
    const payload = call(tx, 'create_multicoin_pool::new')
    expect(payload.typeArgs).toEqual([CRED])
    expect(puresOf(payload)).toEqual([pure.id(COLLECTION), pure.u64(70810n)])
    expect(
      objectsOf(call(tx, 'trading_ops::execute_create_multicoin_pool')),
    ).toEqual([
      ids.triexRegistry,
      ids.triexFeePolicy,
      COLLECTION,
      TREASURY,
      '<ticket>',
    ])
  })

  it('limit order: eight payload fields; FeePolicy right after the pool', () => {
    const tx = own(
      placeLimitOrderAction(tctx, {
        quoteType: CRED,
        poolId: POOL,
        price: 100n,
        quantity: 5n,
        isBid: false,
        orderType: 1,
        selfMatchingOption: 2,
        expireTimestamp: 999n,
      }),
    )
    expect(commandNames(tx)).toEqual([
      'place_limit_order::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_limit_order',
    ])
    expect(puresOf(call(tx, 'place_limit_order::new'))).toEqual([
      pure.id(ACCOUNT),
      pure.id(POOL),
      pure.u64(100n),
      pure.u64(5n),
      pure.bool(false),
      pure.u8(1),
      pure.u8(2),
      pure.u64(999n),
    ])
    expect(
      objectsOf(call(tx, 'trading_ops::execute_place_limit_order')),
    ).toEqual([POOL, ids.triexFeePolicy, CUSTODY, ACCOUNT, CLOCK, '<ticket>'])
  })

  it('market order: (account, pool, qty, is_bid, smo); same handler arg order', () => {
    const tx = own(
      placeMarketOrderAction(tctx, {
        quoteType: CRED,
        poolId: POOL,
        quantity: 4n,
        isBid: true,
      }),
    )
    expect(commandNames(tx)).toEqual([
      'place_market_order::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_market_order',
    ])
    expect(puresOf(call(tx, 'place_market_order::new'))).toEqual([
      pure.id(ACCOUNT),
      pure.id(POOL),
      pure.u64(4n),
      pure.bool(true),
      pure.u8(0),
    ])
    expect(
      objectsOf(call(tx, 'trading_ops::execute_place_market_order')),
    ).toEqual([POOL, ids.triexFeePolicy, CUSTODY, ACCOUNT, CLOCK, '<ticket>'])
  })

  it('cancel: the order id crosses as u128', () => {
    const big = (1n << 100n) + 7n
    const tx = own(
      cancelOrderAction(tctx, { quoteType: CRED, poolId: POOL, orderId: big }),
    )
    expect(puresOf(call(tx, 'cancel_order::new'))).toEqual([
      pure.id(ACCOUNT),
      pure.id(POOL),
      pure.u128(big),
    ])
    expect(objectsOf(call(tx, 'trading_ops::execute_cancel_order'))).toEqual([
      POOL,
      ids.triexFeePolicy,
      CUSTODY,
      ACCOUNT,
      CLOCK,
      '<ticket>',
    ])
  })

  it('coin limit order: <Base, Quote>, per-pair key, FeePolicy after the pool', () => {
    const action = placeLimitOrderCoinAction(tctx, {
      baseType: BASE,
      quoteType: CRED,
      poolId: COIN_POOL,
      price: 3n,
      quantity: 9n,
      isBid: true,
      expireTimestamp: GTC_EXPIRE,
    })
    expect(action.own!.typeKey).toBe(
      `${TRADING}::place_limit_order_coin::PlaceLimitOrderCoin<${BASE}, ${CRED}>`,
    )
    const tx = own(action)
    expect(commandNames(tx)).toEqual([
      'place_limit_order_coin::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_limit_order_coin',
    ])
    expect(call(tx, 'place_limit_order_coin::new').typeArgs).toEqual([
      BASE,
      CRED,
    ])
    const exec = call(tx, 'trading_ops::execute_place_limit_order_coin')
    expect(exec.typeArgs).toEqual([BASE, CRED])
    expect(objectsOf(exec)).toEqual([
      COIN_POOL,
      ids.triexFeePolicy,
      CUSTODY,
      ACCOUNT,
      CLOCK,
      '<ticket>',
    ])
  })

  it('coin cancel: NO FeePolicy, u128 order id', () => {
    const tx = own(
      cancelOrderCoinAction(tctx, {
        baseType: BASE,
        quoteType: CRED,
        poolId: COIN_POOL,
        orderId: 42n,
      }),
    )
    expect(puresOf(call(tx, 'cancel_order_coin::new'))).toEqual([
      pure.id(ACCOUNT),
      pure.id(COIN_POOL),
      pure.u128(42n),
    ])
    expect(
      objectsOf(call(tx, 'trading_ops::execute_cancel_order_coin')),
    ).toEqual([COIN_POOL, CUSTODY, ACCOUNT, CLOCK, '<ticket>'])
  })

  it('sweep coin: (account, amount); treasury → custody → account', () => {
    const tx = own(
      sweepCoinToTreasuryAction(tctx, {
        coinType: CRED,
        amount: 10n,
        treasuryVaultId: TREASURY,
      }),
    )
    expect(puresOf(call(tx, 'sweep_coin_to_treasury::new'))).toEqual([
      pure.id(ACCOUNT),
      pure.u64(10n),
    ])
    expect(
      objectsOf(call(tx, 'trading_ops::execute_sweep_coin_to_treasury')),
    ).toEqual([TREASURY, CUSTODY, ACCOUNT, '<ticket>'])
  })

  it('sweep items: (account, vault, collection, asset, amount); handler takes the acting OU', () => {
    const tx = own(
      sweepMulticoinToOuVaultAction(tctx, {
        vaultId: VAULT,
        collectionId: COLLECTION,
        assetId: 70810n,
        amount: 3n,
      }),
    )
    expect(commandNames(tx)).toEqual([
      'sweep_multicoin_to_ou_vault::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_sweep_multicoin_to_ou_vault',
    ])
    expect(puresOf(call(tx, 'sweep_multicoin_to_ou_vault::new'))).toEqual([
      pure.id(ACCOUNT),
      pure.id(VAULT),
      pure.id(COLLECTION),
      pure.u64(70810n),
      pure.u64(3n),
    ])
    expect(
      objectsOf(call(tx, 'trading_ops::execute_sweep_multicoin_to_ou_vault')),
    ).toEqual([VAULT, OFFICERS, CUSTODY, ACCOUNT, '<ticket>'])
  })
})

describe('type catalog', () => {
  it('covers every armature_trading payload module, with the permission bits', () => {
    const entries = [
      ...tradingProposalTypes(TRADING, CRED),
      ...coinPairProposalTypes(TRADING, BASE, CRED),
      createMulticoinPoolProposalType(TRADING, CRED),
    ]
    const modules = entries.map((e) => e.moveType.split('::')[1]).sort()
    expect(modules).toEqual(
      [
        'cancel_order',
        'cancel_order_coin',
        'create_multicoin_pool',
        'deposit_coin_to_book',
        'deposit_from_ou_vault_to_book',
        'place_limit_order',
        'place_limit_order_coin',
        'place_market_order',
        'setup_trading_account',
        'sweep_coin_to_treasury',
        'sweep_multicoin_to_ou_vault',
      ].sort(),
    )
    // trading_permissions.move: only the two treasury-withdrawing types need bits.
    const withBits = entries
      .filter((e) => e.permissions !== 0)
      .map((e) => e.moveType.split('::')[1])
      .sort()
    expect(withBits).toEqual(['create_multicoin_pool', 'deposit_coin_to_book'])
    for (const e of entries.filter((x) => x.permissions)) {
      expect(e.permissions).toBe(1 << 7)
    }
  })

  it('coin pairs get distinct display keys so several coexist', () => {
    const a = coinPairProposalTypes(TRADING, BASE, CRED)
    const b = coinPairProposalTypes(TRADING, `${hex('bb')}::x::X`, CRED)
    expect(a[0].typeKey).not.toBe(b[0].typeKey)
  })
})

describe('display-key resolution', () => {
  it('normalizes type spellings (prefix, padding, case, spacing)', () => {
    expect(normalizeMoveType('0x2::coin::Coin<0x2::sui::SUI>')).toBe(
      normalizeMoveType(
        `${'0'.repeat(63)}2::coin::Coin<${'0'.repeat(63)}2::sui::SUI>`,
      ),
    )
    expect(normalizeMoveType(`0xAB::m::P<0x1::a::A,0x2::b::B>`)).toBe(
      normalizeMoveType(`0xab::m::P<0x1::a::A, 0x2::b::B>`),
    )
  })

  it('adopts the key the OU enabled the payload type under', () => {
    const action = placeLimitOrderCoinAction(tctx, {
      baseType: BASE,
      quoteType: CRED,
      poolId: COIN_POOL,
      price: 1n,
      quantity: 1n,
      isBid: true,
      expireTimestamp: GTC_EXPIRE,
    })
    // Enabled under the legacy generics-free key, type spelled without 0x.
    const legacyKey = `${TRADING}::place_limit_order_coin::PlaceLimitOrderCoin`
    const bindings = new Map([
      [legacyKey, action.own!.payloadMoveType.replace(/0x/g, '')],
    ])
    expect(withEnabledTypeKey(action, bindings).own!.typeKey).toBe(legacyKey)
    // Unrelated bindings leave it alone.
    expect(withEnabledTypeKey(action, new Map()).own!.typeKey).toBe(
      action.own!.typeKey,
    )
  })
})

describe('custody discovery', () => {
  const accountBytes = (owner: string) => {
    const out = new Uint8Array(80)
    out.set(bcs.Address.serialize(ACCOUNT).toBytes(), 0)
    out.set(bcs.Address.serialize(owner).toBytes(), 32)
    return out
  }

  it('reads the account owner as the custody id', async () => {
    const getObject = jest.fn(async ({ objectId }: any) =>
      objectId === ACCOUNT
        ? { object: { content: accountBytes(CUSTODY) } }
        : {
            object: {
              type: `${TRADING}::trading_custody::TradingCustody`,
              json: { ou_id: OFFICERS, trading_account_id: ACCOUNT },
            },
          },
    )
    const info = await fetchTradingCustody(
      { core: { getObject } } as never,
      ACCOUNT,
    )
    expect(info).toEqual({
      tradingCustodyId: CUSTODY,
      ouId: OFFICERS,
      tradingAccountId: ACCOUNT,
    })
    expect((getObject.mock.calls[1][0] as any).objectId).toBe(CUSTODY)
  })

  it('refuses a personal (non-custody) account', async () => {
    const getObject = async ({ objectId }: any) =>
      objectId === ACCOUNT
        ? { object: { content: accountBytes(ALICE) } }
        : { object: { type: '0x2::account::Account', json: {} } }
    await expect(
      fetchTradingCustody({ core: { getObject } } as never, ACCOUNT),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })

  it('extracts the created custody + account from effects', () => {
    expect(
      extractCreatedTradingCustody([
        {
          objectId: CUSTODY,
          objectType: `${TRADING}::trading_custody::TradingCustody`,
        },
        {
          objectId: ACCOUNT,
          objectType: `${ids.triex}::trading_account::TradingAccount`,
        },
      ]),
    ).toEqual({ tradingCustodyId: CUSTODY, tradingAccountId: ACCOUNT })
    expect(extractCreatedTradingCustody([])).toBeNull()
  })
})

// ─── end-to-end through the handle ──────────────────────────────────────────

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

const ENABLED = [
  ...tradingProposalTypes(TRADING, CRED),
  ...coinPairProposalTypes(TRADING, BASE, CRED),
  createMulticoinPoolProposalType(TRADING, CRED),
]

/**
 * The governance the resolver sees. Built directly rather than from on-chain
 * JSON so these tests pin the TRADING surface, not the governance parser.
 */
function governance(quorum: number, keys = ENABLED): DaoGovernance {
  const config = {
    quorum,
    approvalThreshold: 8000,
    proposeThreshold: 0,
    expiryMs: 3_600_000,
    executionDelayMs: 0,
    cooldownMs: 0,
    composableAllowed: false,
  }
  // `EnableProposalType` is a framework default slot on every OU.
  const all = [...keys.map((k) => k.typeKey), 'EnableProposalType']
  return {
    enabledTypes: new Set(all),
    configs: new Map(all.map((k) => [k, config])),
    typeBindings: new Map(keys.map((k) => [k.typeKey, k.moveType])),
  } as unknown as DaoGovernance
}

function harness(
  opts: {
    quorum?: number
    hasAccount?: boolean
    /** Unit the account (and custody) belongs to. Default: OFFICERS. */
    accountUnit?: string
    /** The seat the handle is opened on. Default: OFFICERS. */
    seat?: string
    officers?: string[]
    keys?: typeof ENABLED
    createdObjects?: { objectId: string; objectType: string }[]
  } = {},
) {
  const accountUnit = opts.accountUnit ?? OFFICERS
  const captured: { txs: Transaction[] } = { txs: [] }
  const executor = jest.fn(async (tx: unknown) => {
    captured.txs.push(tx as Transaction)
    return {
      digest: 'D1',
      objectChanges: (opts.createdObjects ?? []).map((o) => ({
        type: 'created',
        ...o,
      })),
    }
  })
  const content = new Uint8Array(80)
  content.set(bcs.Address.serialize(CUSTODY).toBytes(), 32)
  const getObject = jest.fn(async ({ objectId }: any) => {
    if (objectId === ACCOUNT) return { object: { content } }
    if (objectId === CUSTODY) {
      return {
        object: {
          type: `${TRADING}::trading_custody::TradingCustody`,
          json: { ou_id: accountUnit, trading_account_id: ACCOUNT },
        },
      }
    }
    throw new Error(`unexpected getObject ${objectId}`)
  })
  jest
    .spyOn(OrgHandle.prototype, 'gov')
    .mockImplementation(async () => governance(opts.quorum ?? 1, opts.keys))

  const account = (id: string) =>
    opts.hasAccount !== false && id === accountUnit ? ACCOUNT : null
  const handle = new OrgHandle(
    {
      suiClient: {
        core: {
          getObject,
          getCoins: async () => ({ objects: [] }),
          getDynamicField: async () => {
            throw new Error('none')
          },
          simulateTransaction: async () => feeSimulation(),
        },
      } as never,
      indexer: {
        hubVault: async () => ({
          collectionId: COLLECTION,
          vaultConfigId: hex('53'),
        }),
        resolvePool: async () => POOL,
        poolMetadata: async () => ({ feeRateScaled: 20_000_000n }),
        orgs: {},
      } as never,
      ids,
      requireExecutor: () => executor,
      address: ALICE,
    },
    unit(ROOT, {
      emergencyFreezeId: hex('e1'),
      treasuryId: hex('43'),
      members: [ALICE],
      tradingAccountId: account(ROOT),
      ous: [
        unit(OFFICERS, {
          emergencyFreezeId: hex('e4'),
          treasuryId: TREASURY,
          members: opts.officers ?? [ALICE],
          subdaoControlCapId: hex('e7'),
          tradingAccountId: account(OFFICERS),
        }),
      ],
    }),
    opts.seat ?? OFFICERS,
  )
  return { handle, executor, captured, getObject }
}

/**
 * `getPoolTradingFees`' simulate result for a pool on the launch ladder —
 * tier 0 is 2.2% taker / 1.8% maker, so a bid escrows at the TAKER rate.
 */
const ENTRY_TAKER = 22_000_000n
function feeSimulation() {
  const ladder = FeeScheduleBcs.serialize({
    tiers: [
      { min_turnover: 0n, taker_fee: ENTRY_TAKER, maker_fee: 18_000_000n },
    ],
  }).toBytes()
  const u64 = (n: bigint) => bcs.u64().serialize(n).toBytes()
  return {
    $kind: 'Transaction',
    Transaction: { digest: 'sim', epoch: '901' },
    commandResults: [
      { returnValues: [{ bcs: bcs.u16().serialize(1).toBytes() }] },
      { returnValues: [{ bcs: ladder }] },
      { returnValues: [{ bcs: ladder }, { bcs: u64(900n) }] },
      { returnValues: [{ bcs: u64(2_000n) }] },
    ],
  }
}

afterEach(() => jest.restoreAllMocks())

describe('orders through the handle', () => {
  it('resolves pool + custody and places the order', async () => {
    const { handle, captured } = harness()
    const outcome = await handle.orders.limit({
      storageUnitId: HUB,
      assetId: '70810',
      side: 'sell',
      price: 1000n,
      quantity: 2n,
    })
    expect(outcome).toEqual({ status: 'executed', digest: 'D1' })
    const tx = captured.txs[0]
    // runAtomic bundles steps through the `&mut` entry point whatever the
    // cooldown; only governance.run picks `_readonly`.
    expect(commandNames(tx)).toEqual([
      'place_limit_order::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_limit_order',
    ])
    expect(
      objectsOf(call(tx, 'trading_ops::execute_place_limit_order')),
    ).toEqual([POOL, ids.triexFeePolicy, CUSTODY, ACCOUNT, CLOCK, '<ticket>'])
  })

  it('acts through the unit that owns the account, even from another seat', async () => {
    // Opened on ROOT; the account belongs to OFFICERS, where Alice also sits.
    const { handle, captured } = harness({ seat: ROOT })
    await handle.orders.limit({
      storageUnitId: HUB,
      assetId: '70810',
      side: 'buy',
      price: 10n,
      quantity: 1n,
    })
    // The ticket is minted on the OFFICERS unit — the custody's OU.
    const submit = call(captured.txs[0], 'board_voting::submit_vote_execute')
    expect(objectsOf(submit)[0]).toBe(OFFICERS)
  })

  it('refuses when the caller holds no seat on the account-owning unit', async () => {
    const { handle } = harness({ seat: ROOT, officers: [BOB] })
    await expect(
      handle.orders.limit({
        storageUnitId: HUB,
        assetId: '1',
        side: 'buy',
        price: 1n,
        quantity: 1n,
      }),
    ).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
      message: expect.stringContaining('only that unit'),
    })
  })

  it('reads the custody once per handle', async () => {
    const { handle, getObject } = harness()
    const p = {
      storageUnitId: HUB,
      assetId: '1',
      side: 'buy' as const,
      price: 1n,
      quantity: 1n,
    }
    await handle.orders.limit(p)
    await handle.orders.limit(p)
    expect(getObject).toHaveBeenCalledTimes(2) // account + custody, once
  })

  it('rejects a non-positive price or quantity before any network call', async () => {
    const { handle, executor } = harness()
    await expect(
      handle.orders.limit({
        storageUnitId: HUB,
        assetId: '1',
        side: 'buy',
        price: 0n,
        quantity: 1n,
      }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
    expect(executor).not.toHaveBeenCalled()
  })

  it('market order', async () => {
    const { handle, captured } = harness()
    await handle.orders.market({
      storageUnitId: HUB,
      assetId: '70810',
      side: 'buy',
      quantity: 3n,
    })
    expect(commandNames(captured.txs[0])).toEqual([
      'place_market_order::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_market_order',
    ])
  })

  it('cancel passes a u128 order id', async () => {
    const { handle, captured } = harness()
    const orderId = (1n << 90n) + 3n
    await handle.orders.cancel({
      storageUnitId: HUB,
      assetId: '70810',
      orderId,
    })
    expect(puresOf(call(captured.txs[0], 'cancel_order::new'))[2]).toBe(
      pure.u128(orderId),
    )
  })

  it('funds a bid from the treasury in ONE atomic transaction', async () => {
    const { handle, captured } = harness()
    await handle.orders.buyFromTreasury({
      storageUnitId: HUB,
      assetId: '70810',
      side: 'buy',
      price: 1000n,
      quantity: 2n,
    })
    // Deposit and place in a single PTB — if the place aborts the deposit rolls back.
    expect(captured.txs).toHaveLength(1)
    const tx = captured.txs[0]
    expect(commandNames(tx)).toEqual([
      'deposit_coin_to_book::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_deposit_coin_to_book',
      'place_limit_order::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_limit_order',
    ])
    // The trading unit's own treasury funds it.
    expect(
      objectsOf(call(tx, 'trading_ops::execute_deposit_coin_to_book'))[0],
    ).toBe(TREASURY)
  })

  it('sizes the default bid deposit from the on-chain escrow rate, or from bidFeeRate', async () => {
    const { handle, captured } = harness()
    const p = {
      storageUnitId: HUB,
      assetId: '70810',
      side: 'buy' as const,
      price: 1000n,
      quantity: 2n,
    }
    await handle.orders.buyFromTreasury(p)
    await handle.orders.buyFromTreasury({ ...p, bidFeeRate: 50_000_000n })
    const deposited = (i: number) =>
      puresOf(call(captured.txs[i], 'deposit_coin_to_book::new'))[1]
    // The on-chain escrow rate (tier-0 max: 2.2%) by default — not the
    // indexer's pool fee, which the harness still serves as 2%.
    expect(deposited(0)).toBe(
      pure.u64(computeBidQuoteDeposit(1000n, 2n, ENTRY_TAKER)),
    )
    expect(deposited(1)).toBe(
      pure.u64(computeBidQuoteDeposit(1000n, 2n, 50_000_000n)),
    )
  })

  it('unparks from shared storage and sells atomically', async () => {
    const { handle, captured } = harness()
    await handle.orders.sellFromVault({
      storageUnitId: HUB,
      assetId: '70810',
      side: 'sell',
      price: 1000n,
      quantity: 5n,
      vaultQuantity: 3n,
      vaultId: VAULT,
    })
    const tx = captured.txs[0]
    expect(commandNames(tx)).toEqual([
      'deposit_from_ou_vault_to_book::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_deposit_from_ou_vault_to_book',
      'place_limit_order::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_limit_order',
    ])
    expect(puresOf(call(tx, 'deposit_from_ou_vault_to_book::new'))[3]).toBe(
      pure.u64(3n),
    )
  })

  it('deposits any coin on its own', async () => {
    const { handle, captured } = harness()
    await handle.orders.deposit({ amount: 5n, coinType: BASE })
    const tx = captured.txs[0]
    expect(call(tx, 'deposit_coin_to_book::new').typeArgs).toEqual([BASE])
  })

  it('coin-pool limit order, funded from the treasury with the BASE coin on an ask', async () => {
    const { handle, captured } = harness()
    await handle.orders.limitCoin({
      poolId: COIN_POOL,
      baseType: BASE,
      side: 'sell',
      price: 7n,
      quantity: 9n,
      depositAmount: 9n,
    })
    const tx = captured.txs[0]
    expect(commandNames(tx)).toEqual([
      'deposit_coin_to_book::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_deposit_coin_to_book',
      'place_limit_order_coin::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_limit_order_coin',
    ])
    expect(call(tx, 'deposit_coin_to_book::new').typeArgs).toEqual([BASE])
    expect(call(tx, 'place_limit_order_coin::new').typeArgs).toEqual([
      BASE,
      CRED,
    ])
  })

  it('coin-pool cancel', async () => {
    const { handle, captured } = harness()
    await handle.orders.cancelCoin({
      poolId: COIN_POOL,
      baseType: BASE,
      orderId: 5n,
    })
    expect(commandNames(captured.txs[0])).toEqual([
      'cancel_order_coin::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_cancel_order_coin',
    ])
  })

  it('blocks a coin-pool order whose pair is not enabled', async () => {
    const { handle, executor } = harness({
      keys: tradingProposalTypes(TRADING, CRED),
    })
    const outcome = await handle.orders.limitCoin({
      poolId: COIN_POOL,
      baseType: BASE,
      side: 'buy',
      price: 1n,
      quantity: 1n,
    })
    expect(outcome).toMatchObject({ status: 'blocked' })
    expect(executor).not.toHaveBeenCalled()
  })

  it('blocks the WHOLE bundle when any step is not enabled', async () => {
    // DepositCoinToBook enabled, PlaceLimitOrder not: resolving only the first
    // step would sign a transaction that aborts on the second.
    const { handle, executor } = harness({
      keys: tradingProposalTypes(TRADING, CRED).filter(
        (e) => !e.moveType.includes('place_limit_order'),
      ),
    })
    const outcome = await handle.orders.buyFromTreasury({
      storageUnitId: HUB,
      assetId: '70810',
      side: 'buy',
      price: 1000n,
      quantity: 2n,
    })
    expect(outcome).toMatchObject({ status: 'blocked' })
    expect(executor).not.toHaveBeenCalled()
  })

  it('resolves under the display key the OU actually used', async () => {
    // The pair is enabled under the legacy generics-free key.
    const legacy = coinPairProposalTypes(TRADING, BASE, CRED).map((e) => ({
      ...e,
      typeKey: e.typeKey.replace(/<.*$/, ''),
    }))
    const { handle, captured } = harness({
      keys: [...tradingProposalTypes(TRADING, CRED), ...legacy],
    })
    const outcome = await handle.orders.cancelCoin({
      poolId: COIN_POOL,
      baseType: BASE,
      orderId: 1n,
    })
    expect(outcome.status).toBe('executed')
    expect(captured.txs).toHaveLength(1)
  })

  it('creates an item market paid from the acting treasury', async () => {
    const { handle, captured } = harness()
    const outcome = await handle.orders.createPool({
      storageUnitId: HUB,
      assetId: 70810n,
    })
    expect(outcome.status).toBe('executed')
    const tx = captured.txs[0]
    expect(
      objectsOf(call(tx, 'trading_ops::execute_create_multicoin_pool')),
    ).toEqual([
      ids.triexRegistry,
      ids.triexFeePolicy,
      COLLECTION,
      TREASURY,
      '<ticket>',
    ])
  })

  it('createPool needs a storage unit or a collection', async () => {
    const { handle } = harness()
    await expect(
      handle.orders.createPool({ assetId: 1n }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })

  it('claims settled proceeds BEFORE sweeping, in the same transaction', async () => {
    const { handle, captured } = harness()
    await handle.orders.sweepCoin({ amount: 500n, claimFromPool: POOL })
    const tx = captured.txs[0]
    expect(commandNames(tx)).toEqual([
      'multicoin_pool::withdraw_settled_amounts_permissionless',
      'sweep_coin_to_treasury::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_sweep_coin_to_treasury',
    ])
    const claim = calls(tx)[0]
    expect(claim.typeArgs).toEqual([CRED])
    expect(objectsOf(claim)).toEqual([POOL, ACCOUNT])
  })

  it('claims from a coin pool with <Base, Quote> before sweeping the base', async () => {
    const { handle, captured } = harness()
    await handle.orders.sweepCoin({
      amount: 5n,
      coinType: BASE,
      claimFromCoinPool: { poolId: COIN_POOL, baseType: BASE },
    })
    const tx = captured.txs[0]
    const claim = calls(tx)[0]
    expect(claim.fn).toBe('pool::withdraw_settled_amounts_permissionless')
    expect(claim.typeArgs).toEqual([BASE, CRED])
    expect(call(tx, 'sweep_coin_to_treasury::new').typeArgs).toEqual([BASE])
  })

  it('sweeps without a claim when no pool is named', async () => {
    const { handle, captured } = harness()
    await handle.orders.sweepCoin({ amount: 500n })
    expect(commandNames(captured.txs[0])[0]).toBe('sweep_coin_to_treasury::new')
  })

  it('BLOCKS rather than deferring a funded buy when quorum needs a real vote', async () => {
    const { handle, executor } = harness({ quorum: 10_001 })
    const outcome = await handle.orders.buyFromTreasury({
      storageUnitId: HUB,
      assetId: '70810',
      side: 'buy',
      price: 1000n,
      quantity: 2n,
    })
    // The whole point of single-vote-only: never split a funded order into two
    // independent proposals.
    expect(outcome).toMatchObject({
      status: 'blocked',
      code: 'needs-slow-tier',
    })
    expect(executor).not.toHaveBeenCalled()
  })

  it('refuses to trade before the organization has an account', async () => {
    const { handle } = harness({ hasAccount: false })
    await expect(
      handle.orders.limit({
        storageUnitId: HUB,
        assetId: '1',
        side: 'buy',
        price: 1n,
        quantity: 1n,
      }),
    ).rejects.toMatchObject({ code: TriexError.TradingAccountNotFound })
  })

  it('ensureAccount refuses when one already exists', async () => {
    const { handle } = harness()
    await expect(handle.orders.ensureAccount()).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
    })
  })

  it('ensureAccount sets one up, reports its ids, and refuses a second in the indexer lag', async () => {
    const { handle, captured } = harness({
      hasAccount: false,
      createdObjects: [
        {
          objectId: CUSTODY,
          objectType: `${TRADING}::trading_custody::TradingCustody`,
        },
        {
          objectId: ACCOUNT,
          objectType: `${ids.triex}::trading_account::TradingAccount`,
        },
      ],
    })
    const res = await handle.orders.ensureAccount()
    expect(res).toEqual({
      status: 'executed',
      digest: 'D1',
      tradingCustodyId: CUSTODY,
      tradingAccountId: ACCOUNT,
    })
    expect(commandNames(captured.txs[0])).toEqual([
      'setup_trading_account::new',
      'board_voting::submit_vote_execute_readonly',
      'trading_ops::execute_setup_trading_account',
    ])
    // The tree still shows no account (indexer lag) — a second call must not
    // open an orphan, and orders already work against the new one.
    await expect(handle.orders.ensureAccount()).rejects.toMatchObject({
      code: TriexError.ValidationFailed,
    })
    await handle.orders.sweepCoin({ amount: 1n })
    expect(
      objectsOf(
        call(captured.txs[1], 'trading_ops::execute_sweep_coin_to_treasury'),
      ),
    ).toEqual([TREASURY, CUSTODY, ACCOUNT, '<ticket>'])
  })

  it('enableCoinPair enables only the missing pair types', async () => {
    const { handle, captured } = harness({
      keys: tradingProposalTypes(TRADING, CRED),
    })
    await handle.orders.enableCoinPair({ baseType: BASE })
    const names = commandNames(captured.txs[0])
    // EnableProposalType has cooldown 0 here, so runBatch takes `_readonly`.
    expect(
      names.filter((n) => n === 'board_voting::submit_vote_execute_readonly'),
    ).toHaveLength(2)
  })

  it('enableCoinPair refuses when the pair is already enabled', async () => {
    const { handle } = harness()
    await expect(
      handle.orders.enableCoinPair({ baseType: BASE }),
    ).rejects.toMatchObject({ code: TriexError.ValidationFailed })
  })
})

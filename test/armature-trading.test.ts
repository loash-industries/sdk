import { jest } from '@jest/globals'
import type { Transaction } from '@mysten/sui/transactions'

import { OrgHandle } from '../src/armature/OrgClient'
import { buildPlanTx } from '../src/armature/plan'
import {
  cancelOrderAction,
  depositCoinToBookAction,
  depositFromDaoVaultToBookAction,
  placeLimitOrderAction,
  setupTradingAccountAction,
  sweepCoinToTreasuryAction,
  sweepMulticoinToDaoVaultAction,
} from '../src/armature/trading'
import type { Org, OuExecContext } from '../src/armature/types'
import { resolvePackageIds } from '../src/config'
import { TriexError } from '../src/errors'
import { GTC_EXPIRE } from '../src/money'

const hex = (pair: string) => `0x${pair.repeat(32)}`
const ids = resolvePackageIds('testnet')
const TRADING = ids.armatureTrading

const ROOT = hex('c1')
const OFFICERS = hex('c2')
const ALICE = hex('11')
const BM = hex('b0')
const CAPS = hex('e5')
const TREASURY = hex('44')
const VAULT = hex('47')
const POOL = hex('50')
const COLLECTION = hex('51')
const HUB = hex('52')
const CRED = ids.credCoinType

const ctx: OuExecContext = {
  daoId: OFFICERS,
  board: [ALICE],
  emergencyFreezeId: hex('e4'),
}
const tctx = {
  armatureTrading: TRADING,
  capVaultId: CAPS,
  tradingAccountId: BM,
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

describe('trading actions are single-vote-only', () => {
  it('every one refuses to degrade into a deferred proposal', () => {
    const actions = [
      setupTradingAccountAction({ armatureTrading: TRADING }, CAPS),
      depositCoinToBookAction(tctx, {
        quoteType: CRED,
        amount: 1n,
        treasuryVaultId: TREASURY,
      }),
      depositFromDaoVaultToBookAction(tctx, {
        daoVaultId: VAULT,
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
      cancelOrderAction(tctx, { quoteType: CRED, poolId: POOL, orderId: 1n }),
      sweepCoinToTreasuryAction(tctx, {
        quoteType: CRED,
        amount: 1n,
        treasuryVaultId: TREASURY,
      }),
      sweepMulticoinToDaoVaultAction(tctx, {
        daoVaultId: VAULT,
        collectionId: COLLECTION,
        assetId: 1n,
        amount: 1n,
      }),
    ]
    for (const a of actions) {
      expect(a.fallbackPolicy).toBe('single-vote-only')
      // Trading is own-DAO only; there is no Control* form of an order.
      expect(a.control).toBeUndefined()
    }
  })
})

describe('trading PTB shapes', () => {
  const shape = (a: Parameters<typeof buildPlanTx>[1]) =>
    commandNames(buildPlanTx('own-execute', a, ctx, ids.armature))

  it('place limit order', () => {
    expect(
      shape(
        placeLimitOrderAction(tctx, {
          quoteType: CRED,
          poolId: POOL,
          price: 100n,
          quantity: 5n,
          isBid: false,
          expireTimestamp: GTC_EXPIRE,
        }),
      ),
    ).toEqual([
      'place_limit_order::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_limit_order',
    ])
  })

  it('cancel order', () => {
    expect(
      shape(
        cancelOrderAction(tctx, { quoteType: CRED, poolId: POOL, orderId: 9n }),
      ),
    ).toEqual([
      'cancel_order::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_cancel_order',
    ])
  })

  it('setup trading account takes no payload arguments', () => {
    expect(
      shape(setupTradingAccountAction({ armatureTrading: TRADING }, CAPS)),
    ).toEqual([
      'setup_trading_account::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_setup_trading_account',
    ])
  })

  it('sweep coin to treasury', () => {
    expect(
      shape(
        sweepCoinToTreasuryAction(tctx, {
          quoteType: CRED,
          amount: 10n,
          treasuryVaultId: TREASURY,
        }),
      ),
    ).toEqual([
      'sweep_coin_to_treasury::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_sweep_coin_to_treasury',
    ])
  })

  it('sweep items to shared storage passes the acting DAO to the handler', () => {
    const tx = buildPlanTx(
      'own-execute',
      sweepMulticoinToDaoVaultAction(tctx, {
        daoVaultId: VAULT,
        collectionId: COLLECTION,
        assetId: 70810n,
        amount: 3n,
      }),
      ctx,
      ids.armature,
    )
    expect(commandNames(tx)).toEqual([
      'sweep_multicoin_to_dao_vault::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_sweep_multicoin_to_dao_vault',
    ])
    const objectIds = (tx.getData().inputs as any[])
      .map(
        (i) =>
          i?.UnresolvedObject?.objectId ??
          i?.Object?.ImmOrOwnedObject?.objectId,
      )
      .filter(Boolean)
    expect(objectIds).toEqual(
      expect.arrayContaining([VAULT, BM, CAPS, OFFICERS]),
    )
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

const TRADING_KEYS = [
  'deposit_coin_to_book::DepositCoinToBook',
  'deposit_from_dao_vault_to_book::DepositFromDaoVaultToBook',
  'place_limit_order::PlaceLimitOrder',
  'cancel_order::CancelOrder',
  'sweep_coin_to_treasury::SweepCoinToTreasury',
  'sweep_multicoin_to_dao_vault::SweepMulticoinToDaoVault',
  'setup_trading_account::SetupTradingAccount',
].map((t) => `${TRADING}::${t}`)

function daoJson(keys: string[], quorum = 1) {
  return {
    enabled_proposal_types: { contents: keys },
    proposal_configs: {
      contents: keys.map((key) => ({
        key,
        value: {
          quorum,
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

function harness(opts: { quorum?: number; hasBm?: boolean } = {}) {
  const captured: { txs: Transaction[] } = { txs: [] }
  const executor = jest.fn(async (tx: unknown) => {
    captured.txs.push(tx as Transaction)
    return { digest: 'D1', objectChanges: [] }
  })
  const handle = new OrgHandle(
    {
      suiClient: {
        core: {
          getObject: async () => ({
            object: { json: daoJson(TRADING_KEYS, opts.quorum ?? 1) },
          }),
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
      members: [ALICE],
      ous: [
        unit(OFFICERS, {
          emergencyFreezeId: hex('e4'),
          capabilityVaultId: CAPS,
          treasuryId: TREASURY,
          members: [ALICE],
          subdaoControlCapId: hex('e7'),
          tradingAccountId: opts.hasBm === false ? null : BM,
        }),
      ],
    }),
    OFFICERS,
  )
  return { handle, executor, captured }
}

describe('orders through the handle', () => {
  it('resolves the pool and places the order', async () => {
    const { handle, captured } = harness()
    const outcome = await handle.orders.limit({
      storageUnitId: HUB,
      assetId: '70810',
      side: 'sell',
      price: 1000n,
      quantity: 2n,
    })
    expect(outcome).toEqual({ status: 'executed', digest: 'D1' })
    expect(commandNames(captured.txs[0])).toEqual([
      'place_limit_order::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_limit_order',
    ])
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
    expect(commandNames(captured.txs[0])).toEqual([
      'deposit_coin_to_book::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_deposit_coin_to_book',
      'place_limit_order::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_limit_order',
    ])
  })

  it('unparks from shared storage and sells atomically', async () => {
    const { handle, captured } = harness()
    await handle.orders.sellFromDaoVault({
      storageUnitId: HUB,
      assetId: '70810',
      side: 'sell',
      price: 1000n,
      quantity: 5n,
      vaultQuantity: 3n,
      daoVaultId: VAULT,
    })
    expect(commandNames(captured.txs[0])).toEqual([
      'deposit_from_dao_vault_to_book::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_deposit_from_dao_vault_to_book',
      'place_limit_order::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_place_limit_order',
    ])
  })

  it('claims settled proceeds BEFORE sweeping, in the same transaction', async () => {
    const { handle, captured } = harness()
    await handle.orders.sweepCoin({ amount: 500n, claimFromPool: POOL })
    expect(commandNames(captured.txs[0])).toEqual([
      'multicoin_pool::withdraw_settled_amounts_permissionless',
      'sweep_coin_to_treasury::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_sweep_coin_to_treasury',
    ])
  })

  it('sweeps without a claim when no pool is named', async () => {
    const { handle, captured } = harness()
    await handle.orders.sweepCoin({ amount: 500n })
    expect(commandNames(captured.txs[0])[0]).toBe('sweep_coin_to_treasury::new')
  })

  it('BLOCKS rather than deferring a funded buy when quorum needs a real vote', async () => {
    // quorum 6600 on a 1-member board still passes (6600 ≤ 10000), so use a
    // board where it cannot: two members at 6600 → 13200.
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
    const { handle } = harness({ hasBm: false })
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

  it('ensureAccount sets one up when there is none', async () => {
    const { handle, captured } = harness({ hasBm: false })
    await handle.orders.ensureAccount()
    expect(commandNames(captured.txs[0])).toEqual([
      'setup_trading_account::new',
      'board_voting::submit_vote_execute',
      'trading_ops::execute_setup_trading_account',
    ])
  })
})

describe('treasury through the handle', () => {
  it('deposits permissionlessly — a plain TxResult, not a RunOutcome', async () => {
    const { handle, captured } = harness()
    const res = await handle.treasury.deposit({ amount: 100n })
    expect(res.digest).toBe('D1')
    expect(commandNames(captured.txs[0])).toContain('treasury_vault::deposit')
  })

  it('rejects a non-positive deposit', async () => {
    const { handle } = harness()
    await expect(handle.treasury.deposit({ amount: 0n })).rejects.toMatchObject(
      {
        code: TriexError.ValidationFailed,
      },
    )
  })

  it('pays out through governance and blocks when the type is not enabled', async () => {
    const { handle, executor } = harness()
    // SendCoin<CRED> is not in TRADING_KEYS, so nothing enables the payout.
    const outcome = await handle.treasury.send({
      recipient: ALICE,
      amount: 10n,
    })
    expect(outcome).toMatchObject({ status: 'blocked' })
    expect(executor).not.toHaveBeenCalled()
  })
})

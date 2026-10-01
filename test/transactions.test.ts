/**
 * Builder-level tests for the low-level PTB builders that have no facade
 * method (swaps, cap-gated deposits/withdrawals, alternative constructors,
 * permissionless maintenance): each pins the Move target, type arguments and
 * argument order against the trinary-exchange `main` signatures.
 */
import { fromBase64 } from '@mysten/sui/utils'
import { Transaction } from '@mysten/sui/transactions'

import { STILLNESS_PACKAGE_IDS } from '../src/config'
import * as t from '../src/transactions'

const IDS = STILLNESS_PACKAGE_IDS
const POOL = '0x' + '10'.repeat(32)
const BM = '0x' + 'b1'.repeat(32)
const CAP = '0x' + 'ca'.repeat(32)
const COLLECTION = '0x' + 'f1'.repeat(32)
const OWNER = '0x' + 'ab'.repeat(32)
const CLOCK = '0x' + '6'.padStart(64, '0')

/** Every MoveCall as `{ target, typeArgs, args }`, args described like writes.test.ts. */
function calls(tx: Transaction) {
  const data = tx.getData()
  return data.commands
    .filter((c: any) => c.$kind === 'MoveCall')
    .map((c: any) => ({
      target: `${c.MoveCall.module}::${c.MoveCall.function}`,
      typeArgs: c.MoveCall.typeArguments,
      args: c.MoveCall.arguments.map((arg: any) => {
        if (arg.$kind !== 'Input') return 'result'
        const input = (data.inputs as any[])[arg.Input]
        if (input?.Pure) return `pure:${fromBase64(input.Pure.bytes).length}`
        return input?.UnresolvedObject?.objectId ?? 'unknown'
      }),
    }))
}

const fresh = () => {
  const tx = new Transaction()
  return { tx, bm: tx.object(BM), cap: tx.object(CAP) }
}

describe('trading account builders', () => {
  it('new_with_custom_owner(_and_caps) take the owner address', () => {
    const { tx } = fresh()
    t.newTradingAccountWithOwner(tx, IDS, OWNER)
    t.newTradingAccountWithOwnerAndCaps(tx, IDS, OWNER)
    expect(calls(tx)).toEqual([
      {
        target: 'trading_account::new_with_custom_owner',
        typeArgs: [],
        args: ['pure:32'],
      },
      {
        target: 'trading_account::new_with_custom_owner_and_caps',
        typeArgs: [],
        args: ['pure:32'],
      },
    ])
  })

  it('mints each cap kind from the account', () => {
    const { tx, bm } = fresh()
    for (const kind of ['trade', 'deposit', 'withdraw'] as const) {
      t.mintTradingAccountCap(tx, IDS, bm, kind)
    }
    expect(calls(tx).map((c) => c.target)).toEqual([
      'trading_account::mint_trade_cap',
      'trading_account::mint_deposit_cap',
      'trading_account::mint_withdraw_cap',
    ])
  })

  it('generate_proof_as_trader(account, tradeCap)', () => {
    const { tx, bm, cap } = fresh()
    t.generateProofAsTrader(tx, IDS, bm, cap)
    expect(calls(tx)[0]).toEqual({
      target: 'trading_account::generate_proof_as_trader',
      typeArgs: [],
      args: [BM, CAP],
    })
  })

  it('cap-gated deposits and withdrawals', () => {
    const { tx, bm, cap } = fresh()
    const coin = tx.object('0x' + 'c0'.repeat(32))
    const bal = tx.object('0x' + 'c3'.repeat(32))
    t.depositCoinWithCap(tx, IDS, bm, cap, coin)
    t.depositMulticoinWithCap(tx, IDS, bm, cap, bal)
    t.withdrawCoinWithCap(tx, IDS, bm, cap, 5n)
    t.withdrawMulticoinWithCap(tx, IDS, bm, cap, COLLECTION, 70810n, 3n)
    expect(calls(tx)).toEqual([
      {
        target: 'trading_account::deposit_with_cap',
        typeArgs: [IDS.credCoinType],
        args: [BM, CAP, '0x' + 'c0'.repeat(32)],
      },
      {
        target: 'trading_account::deposit_multicoin_with_cap',
        typeArgs: [],
        args: [BM, CAP, '0x' + 'c3'.repeat(32)],
      },
      {
        target: 'trading_account::withdraw_with_cap',
        typeArgs: [IDS.credCoinType],
        args: [BM, CAP, 'pure:8'],
      },
      {
        target: 'trading_account::withdraw_multicoin_with_cap',
        typeArgs: [],
        args: [BM, CAP, 'pure:32', 'pure:8', 'pure:8'],
      },
    ])
  })
})

describe('item pool builders', () => {
  it('withdraw_settled_amounts_permissionless(pool, account) — no proof', () => {
    const { tx, bm } = fresh()
    t.withdrawSettledAmountsPermissionless(tx, IDS, { poolId: POOL, bm })
    expect(calls(tx)[0]).toEqual({
      target: 'multicoin_pool::withdraw_settled_amounts_permissionless',
      typeArgs: [IDS.credCoinType],
      args: [POOL, BM],
    })
  })

  it('account-less swaps: (pool, policy, in, cred_in, min_out, clock)', () => {
    const { tx } = fresh()
    const coinIn = tx.object('0x' + 'c0'.repeat(32))
    const credIn = tx.object('0x' + 'c1'.repeat(32))
    t.swapExactBaseForQuoteItem(tx, IDS, {
      poolId: POOL,
      baseIn: coinIn,
      credIn,
      minQuoteOut: 1n,
    })
    t.swapExactQuoteForBaseItem(tx, IDS, {
      poolId: POOL,
      quoteIn: coinIn,
      credIn,
      minBaseOut: 1n,
    })
    const expected = [
      POOL,
      IDS.triexFeePolicy,
      '0x' + 'c0'.repeat(32),
      '0x' + 'c1'.repeat(32),
      'pure:8',
      CLOCK,
    ]
    expect(calls(tx)).toEqual([
      {
        target: 'multicoin_pool::swap_exact_base_for_quote',
        typeArgs: [IDS.credCoinType],
        args: expected,
      },
      {
        target: 'multicoin_pool::swap_exact_quote_for_base',
        typeArgs: [IDS.credCoinType],
        args: expected,
      },
    ])
  })

  it('account swaps: (pool, policy, account, trade, deposit, withdraw caps, in, min_out, clock)', () => {
    const { tx, bm } = fresh()
    const caps = {
      tradeCap: tx.object('0x' + 'a1'.repeat(32)),
      depositCap: tx.object('0x' + 'a2'.repeat(32)),
      withdrawCap: tx.object('0x' + 'a3'.repeat(32)),
    }
    const coinIn = tx.object('0x' + 'c0'.repeat(32))
    t.swapExactBaseForQuoteWithTradingAccountItem(tx, IDS, {
      poolId: POOL,
      bm,
      ...caps,
      baseIn: coinIn,
      minQuoteOut: 1n,
    })
    t.swapExactQuoteForBaseWithTradingAccountItem(tx, IDS, {
      poolId: POOL,
      bm,
      ...caps,
      quoteIn: coinIn,
      minBaseOut: 1n,
    })
    const expected = [
      POOL,
      IDS.triexFeePolicy,
      BM,
      '0x' + 'a1'.repeat(32),
      '0x' + 'a2'.repeat(32),
      '0x' + 'a3'.repeat(32),
      '0x' + 'c0'.repeat(32),
      'pure:8',
      CLOCK,
    ]
    expect(calls(tx).map((c) => [c.target, c.args])).toEqual([
      [
        'multicoin_pool::swap_exact_base_for_quote_with_trading_account',
        expected,
      ],
      [
        'multicoin_pool::swap_exact_quote_for_base_with_trading_account',
        expected,
      ],
    ])
  })

  it('update_pool_allowed_versions(pool, registry)', () => {
    const { tx } = fresh()
    t.updatePoolAllowedVersionsItem(tx, IDS, { poolId: POOL })
    expect(calls(tx)[0]).toEqual({
      target: 'multicoin_pool::update_pool_allowed_versions',
      typeArgs: [IDS.credCoinType],
      args: [POOL, IDS.triexRegistry],
    })
  })

  it('pins the on-chain pool creation fee (constants::pool_creation_fee)', () => {
    expect(t.POOL_CREATION_FEE).toBe(500n * 1_000_000n)
  })
})

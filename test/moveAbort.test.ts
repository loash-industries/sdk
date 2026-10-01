import {
  explainMoveAbort,
  explainMoveAbortDetailed,
  parseMoveAbort,
  unpackAbortCode,
} from '../src/errors'
import { MOVE_ABORT_CATALOG } from '../src/moveAbortCatalog.generated'

const PKG = '0xdbf259ed33d70666379492199137e2ad50fcc1ed1e56acd5780329f7fe982945'

// The shapes Sui errors actually reach the SDK in.
const MODERN = `Move Runtime Abort. Location: ${PKG}::order_info::place_order (function index 3) at offset 45, Abort Code: 5 in command 0`
const LEGACY = `MoveAbort(MoveLocation { module: ModuleId { address: dbf259ed, name: Identifier("order_info") }, function: 3, instruction: 45, function_name: Some("place_order") }, 5) in command 0`
const JSON_ESCAPED = `{"error":"MoveAbort(MoveLocation { module: ModuleId { address: dbf259ed, name: Identifier(\\"order_info\\") }, function: 3, instruction: 45 }, 5) in command 0"}`
const PRE_SUBMIT = `MoveAbort in 1st command, abort code: 5, in '${PKG}::order_info::place_order'`

describe('parseMoveAbort', () => {
  it('handles every rendering Sui uses for the same abort', () => {
    for (const text of [MODERN, LEGACY, JSON_ESCAPED, PRE_SUBMIT]) {
      const parsed = parseMoveAbort(text)
      expect(parsed).not.toBeNull()
      expect(parsed!.module).toBe('order_info')
      expect(parsed!.rawCode).toBe('5')
    }
  })

  it('returns null for non-abort failures', () => {
    expect(parseMoveAbort('InsufficientGas')).toBeNull()
  })
})

describe('unpackAbortCode', () => {
  it('reads a plain abort code', () => {
    expect(unpackAbortCode(5)).toEqual({
      clever: false,
      code: 5,
      sourceLine: null,
    })
  })

  it('does not misread the largest non-clever code', () => {
    expect(unpackAbortCode('9223372036854775807').clever).toBe(false) // 2^63 - 1
    expect(unpackAbortCode('9223372036854775808').clever).toBe(true) // 2^63
  })

  it('unpacks an explicit clever error code and its source line', () => {
    const code = (1n << 63n) | (12n << 48n) | (96n << 32n) | (1n << 16n) | 0n
    expect(unpackAbortCode(code)).toEqual({
      clever: true,
      code: 12,
      sourceLine: 96,
    })
  })

  it('treats a clever error with no explicit code as unkeyed', () => {
    // 0x8000_0007_0001_0000 — the example from the Move reference.
    expect(unpackAbortCode(0x8000000700010000n)).toEqual({
      clever: true,
      code: null,
      sourceLine: 7,
    })
  })
})

describe('explainMoveAbortDetailed', () => {
  it('resolves an abort to its contract constant', () => {
    const d = explainMoveAbortDetailed(MODERN)!
    expect(d.resolution).toBe('resolved')
    expect(d.module).toBe('order_info')
    expect(d.constant).toBe('EPOSTOrderCrossesOrderbook')
    expect(d.explanation).toBe(
      'POST-ONLY order would cross the book — use a plain limit order',
    )
    expect(d.source).toContain('order_info.move')
  })

  it('resolves the same abort identically across renderings', () => {
    const constants = [MODERN, LEGACY, JSON_ESCAPED, PRE_SUBMIT].map(
      (t) => explainMoveAbortDetailed(t)!.constant,
    )
    expect(constants).toEqual(Array(4).fill('EPOSTOrderCrossesOrderbook'))
  })

  it('distinguishes the same code in different modules', () => {
    const inTradingAccount = explainMoveAbortDetailed(
      MODERN.replace(/order_info/g, 'trading_account'),
    )!
    expect(inTradingAccount.constant).toBe('ECapNotInList')
    expect(inTradingAccount.constant).not.toBe('EPOSTOrderCrossesOrderbook')
  })

  it('resolves a clever abort through its explicit code', () => {
    const code = (1n << 63n) | (12n << 48n) | (123n << 32n) | (5n << 16n) | 2n
    const d = explainMoveAbortDetailed(
      `Move Runtime Abort. Location: ${PKG}::pool::place_limit_order (function index 9) at offset 12, Abort Code: ${code} in command 0`,
    )!
    expect(d.clever).toBe(true)
    expect(d.code).toBe(12)
    expect(d.sourceLine).toBe(123)
    expect(d.constant).toBe('EMinimumQuantityOutNotMet')
  })

  it('flags aborts from dependency packages instead of guessing', () => {
    const d = explainMoveAbortDetailed(
      'Move Runtime Abort. Location: 0x2::coin::split (function index 1) at offset 2, Abort Code: 2 in command 0',
    )!
    expect(d.resolution).toBe('external-module')
    expect(d.constant).toBeNull()
  })

  it('flags an unmapped code in a known module', () => {
    const d = explainMoveAbortDetailed(
      `Move Runtime Abort. Location: ${PKG}::multicoin_vault::settle (function index 1) at offset 2, Abort Code: 999 in command 0`,
    )!
    expect(d.resolution).toBe('unknown-code')
    expect(d.constant).toBeNull()
  })

  it('returns null for non-aborts', () => {
    expect(explainMoveAbortDetailed('InsufficientGas')).toBeNull()
    expect(explainMoveAbortDetailed(new Error('network down'))).toBeNull()
  })
})

describe('explainMoveAbort', () => {
  it('keeps the "<explanation> (<Constant>)" shape callers already render', () => {
    expect(explainMoveAbort(MODERN)).toBe(
      'POST-ONLY order would cross the book — use a plain limit order (EPOSTOrderCrossesOrderbook)',
    )
  })

  it('accepts a thrown Error as well as a raw string', () => {
    expect(explainMoveAbort(new Error(PRE_SUBMIT))).toContain(
      'EPOSTOrderCrossesOrderbook',
    )
  })

  it('explains aborts the old hand-kept map did not cover', () => {
    const d = explainMoveAbort(
      `Move Runtime Abort. Location: ${PKG}::registry::create_pool (function index 1) at offset 2, Abort Code: 10 in command 0`,
    )
    expect(d).toBe('That quote currency is not approved (EQuoteNotApproved)')
  })

  it('returns null when the error is not a Move abort', () => {
    expect(explainMoveAbort('InsufficientGas')).toBeNull()
  })
})

describe('catalog', () => {
  it('covers the modules the SDK transacts against', () => {
    for (const m of [
      'pool',
      'multicoin_pool',
      'book',
      'order_info',
      'trading_account',
      'registry',
      'multicoin_vault',
      'coin_vault',
      'fee_policy',
      'state',
      // Armature: framework, proposals, vault, trading
      'governance',
      'board_voting',
      'proposal',
      'treasury_vault',
      'emergency',
      'ou_receipt_vault',
      'trading_ops',
    ]) {
      expect(Object.keys(MOVE_ABORT_CATALOG[m]).length).toBeGreaterThan(0)
    }
  })

  it('no longer references the pre-rename balance_manager module', () => {
    expect(MOVE_ABORT_CATALOG['balance_manager']).toBeUndefined()
    expect(MOVE_ABORT_CATALOG['trading_account']['3'].name).toBe(
      'ETradingAccountBalanceTooLow',
    )
  })
})

describe('Armature aborts', () => {
  const ARMATURE =
    '0x0a9eee47251a9f8a264a18804b1d5e553514720c4f4f765a481d1f12b492624c'

  // Verbatim from simulating org writes against testnet (cycle 7).
  it('explains a board-membership abort from the framework', () => {
    const d = explainMoveAbortDetailed(
      `MoveAbort in 3rd command, abort code: 2, in '${ARMATURE}::governance::assert_board_member' (instruction 6)`,
    )!
    expect(d.resolution).toBe('resolved')
    expect(d.constant).toBe('ENotBoardMember')
    expect(d.explanation).toContain('not on this unit’s board')
  })

  it('explains an empty-treasury abort', () => {
    expect(
      explainMoveAbort(
        `MoveAbort in 3rd command, abort code: 0, in '${ARMATURE}::treasury_vault::withdraw' (instruction 46)`,
      ),
    ).toContain('treasury holds too little')
  })

  it('resolves an explicit #[error(code = 0)] where the module has no bare errors', () => {
    // ou_receipt_vault declares every error with an explicit code, so a clever
    // abort with zero code bits can only be ENotAuthorized (code 0).
    const clever = (1n << 63n) | (67n << 32n)
    const d = explainMoveAbortDetailed(
      `Move Runtime Abort. Location: 0xf447::ou_receipt_vault::withdraw_receipt (function index 3) at offset 4, Abort Code: ${clever}`,
    )!
    expect(d.clever).toBe(true)
    expect(d.code).toBe(0)
    expect(d.constant).toBe('ENotAuthorized')
    expect(d.resolution).toBe('resolved')
  })
})

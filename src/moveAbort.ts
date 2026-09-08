/**
 * Decoding of on-chain Move aborts into developer-readable explanations.
 *
 * A failed transaction's `effects.status.error` is not structured data — it is the
 * `Display` impl of Sui's `ExecutionFailureStatus`, which renders the abort location
 * and the raw `u64` code and nothing else. Resolving a constant *name* on-chain needs
 * `sui-package-resolver`, which fetches the module's constant pool; `SuiClient` does
 * not do it. So the SDK parses that string and looks the code up in a catalog
 * generated from the contract sources (`scripts/generate-error-codes.mjs`).
 *
 * Codes are keyed by `(module, code)` rather than globally, because every abort
 * carries its module — `EInvalidFee = 1` in `pool` and in `multicoin_pool` do not
 * collide.
 */
import {
  MOVE_ABORT_CATALOG,
  type MoveAbortEntry,
  type MoveAbortName,
} from './moveAbortCatalog.generated'

export interface MoveAbortExplanation {
  /** Module the abort came from, e.g. `order_info`. */
  module: string
  /** Package address, when the error string carried one. */
  address: string | null
  /** Function the abort came from, when the error string carried one. */
  function: string | null
  /** The abort code used for lookup (the explicit code for clever errors). */
  code: number | null
  /** The raw `u64` exactly as it appeared, which may exceed `Number.MAX_SAFE_INTEGER`. */
  rawCode: string
  /** Whether the raw code is a clever-error bitset. */
  clever: boolean
  /** Contract source line, available only for clever errors. */
  sourceLine: number | null
  /** The Move constant, when the code is in the catalog. */
  constant: string | null
  /** Best available human explanation: curated text, else the generated label. */
  explanation: string | null
  /** Where the constant is declared in the contracts, for debugging. */
  source: string | null
  /**
   * - `resolved` — matched a known constant
   * - `unknown-code` — our module, but the code is not in the catalog (regenerate)
   * - `external-module` — the abort came from a dependency such as `sui::coin`
   */
  resolution: 'resolved' | 'unknown-code' | 'external-module'
}

/**
 * Curated, trader-facing text for the aborts a caller is likely to hit, overriding
 * the label derived from the constant name.
 *
 * Keys are checked against the generated catalog by the type system: renaming or
 * removing a constant in the contracts turns the stale key here into a compile
 * error, which is how the `balance_manager` → `trading_account` rename was caught.
 */
const CURATED: Partial<Record<MoveAbortName, string>> = {
  'pool::EMinimumQuantityOutNotMet':
    'Slippage too high — the order price moved',
  'multicoin_pool::EMinimumQuantityOutNotMet':
    'Slippage too high — the order price moved',
  'book::EEmptyOrderbook': 'No liquidity available',
  'book::ENewQuantityMustBeLessThanOriginal':
    'Modified quantity must be less than the original',
  'book::EBookOrderNotFound': 'Order not found — already filled or canceled?',
  'order_info::EPOSTOrderCrossesOrderbook':
    'POST-ONLY order would cross the book — use a plain limit order',
  'order_info::EFOKOrderCannotBeFullyFilled':
    'Not enough liquidity to fully fill a FOK order',
  'order_info::ESelfMatchingCancelTaker': 'Self-match would cancel your order',
  'order_info::EInvalidOrderType': 'Invalid order restriction value',
  'order_info::EOrderInvalidPrice': 'Price out of valid range',
  'order_info::EInvalidExpireTimestamp': 'Expire timestamp is in the past',
  'order_info::EMarketOrderCannotBePostOnly':
    'A market order cannot be POST-ONLY',
  'trading_account::ETradingAccountBalanceTooLow':
    'Trading account holds insufficient currency — deposit more',
  'trading_account::EMultiCoinBalanceTooLow':
    'Trading account holds insufficient items',
  'state::EMaxOpenOrders':
    'Max 100 open orders per trading account per pool reached',
  'registry::EQuoteNotApproved': 'That quote currency is not approved',
  'vault::ENoBalanceToSettle': 'Nothing to settle or claim',
}

export interface AbortCodeBits {
  clever: boolean
  /** Explicit `#[error(code = N)]` value, or the plain code for a non-clever abort. */
  code: number | null
  sourceLine: number | null
}

/**
 * Unpack a raw abort code.
 *
 * Clever errors pack `| 1-bit tag | 15-bit explicit code | 16-bit source line |
 * 16-bit identifier index | 16-bit constant index |` into the `u64`. The explicit
 * code and the line number come out with pure arithmetic — only resolving the
 * constant's *name* would need the package bytes, and the catalog covers that.
 */
export function unpackAbortCode(raw: string | number | bigint): AbortCodeBits {
  const c = BigInt(raw)
  if (((c >> 63n) & 1n) !== 1n) {
    return { clever: false, code: Number(c), sourceLine: null }
  }
  const explicit = (c >> 48n) & 0x7fffn
  return {
    clever: true,
    // 0 is also what a bare `#[error]` leaves here, so it cannot be told apart from
    // a literal `#[error(code = 0)]`; the generator rejects code 0 for that reason.
    code: explicit === 0n ? null : Number(explicit),
    sourceLine: Number((c >> 32n) & 0xffffn),
  }
}

interface ParsedAbort {
  module: string
  rawCode: string
  address: string | null
  function: string | null
}

/**
 * Pull the module and code out of a Sui error string.
 *
 * Sui's rendering is not a stable API and reaches the SDK in several shapes: the
 * current `Display` form, the older `Debug` form (sometimes with backslash-escaped
 * quotes, when it has been through `JSON.stringify`), and the pre-submit resolution
 * form the v2 client throws before anything reaches the chain.
 */
export function parseMoveAbort(text: string): ParsedAbort | null {
  // `Move Runtime Abort. Location: 0x…::pool::place_order (function index 3) at offset 4, Abort Code: 12`
  let m =
    /Move Runtime Abort\.\s*Location:\s*(0x[0-9a-fA-F]+)::([a-z0-9_]+)(?:::([a-z0-9_]+))?[^,]*,\s*Abort Code:\s*(\d+)/i.exec(
      text,
    )
  if (m) {
    return {
      address: m[1],
      module: m[2],
      function: m[3] ?? null,
      rawCode: m[4],
    }
  }

  // `MoveAbort(MoveLocation { … name: Identifier("book") … }, 2)`
  m = /Identifier\(\\*"([a-z0-9_]+)\\*"\)[\s\S]*?},?\s*(\d+)\)/.exec(text)
  if (m) {
    const address =
      /address:\s*(?:0x)?([0-9a-fA-F]{2,})/.exec(text)?.[1] ?? null
    return {
      address: address ? `0x${address.replace(/^0+/, '') || '0'}` : null,
      module: m[1],
      function:
        /function_name:\s*Some\(\\*"([a-z0-9_]+)\\*"\)/.exec(text)?.[1] ?? null,
      rawCode: m[2],
    }
  }

  // `…::book::fn…, abort code: 2`
  m = /::([a-z0-9_]+)::([a-z0-9_]+)[^,]*,\s*abort code:?\s*(\d+)/i.exec(text)
  if (m) return { address: null, module: m[1], function: m[2], rawCode: m[3] }

  // Reversed: `MoveAbort in 1st command, abort code: 8, in '0x…::book::fn'`
  m = /abort code:?\s*(\d+)[\s\S]*?::([a-z0-9_]+)::([a-z0-9_]+)/i.exec(text)
  if (m) return { address: null, module: m[2], function: m[3], rawCode: m[1] }

  // Structured: `module: "book" … abort_code: 2`
  m = /module:?\s*'?"?([a-z0-9_]+)'?"?[\s\S]*?abort_code:?\s*"?(\d+)"?/i.exec(
    text,
  )
  if (m) return { address: null, module: m[1], function: null, rawCode: m[2] }

  return null
}

/** Coerce anything the SDK might be handed into the error text to parse. */
function toText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return JSON.stringify(error ?? '')
}

/**
 * Explain a Move abort in full. Returns null when the input is not a recognizable
 * abort (a network failure, a user rejection, `InsufficientGas`, …).
 *
 * Feed it anything: the thrown error, `effects.status.error`, or a string.
 */
export function explainMoveAbortDetailed(
  error: unknown,
): MoveAbortExplanation | null {
  const parsed = parseMoveAbort(toText(error))
  if (!parsed) return null

  const bits = unpackAbortCode(parsed.rawCode)
  const moduleTable = MOVE_ABORT_CATALOG[parsed.module] as
    Record<number, MoveAbortEntry> | undefined
  const entry = bits.code === null ? undefined : moduleTable?.[bits.code]

  let resolution: MoveAbortExplanation['resolution']
  if (entry) resolution = 'resolved'
  else if (!moduleTable) resolution = 'external-module'
  else resolution = 'unknown-code'

  const curated = entry
    ? CURATED[`${parsed.module}::${entry.name}` as MoveAbortName]
    : undefined

  return {
    module: parsed.module,
    address: parsed.address,
    function: parsed.function,
    code: bits.code,
    rawCode: parsed.rawCode,
    clever: bits.clever,
    sourceLine: bits.sourceLine,
    constant: entry?.name ?? null,
    explanation: curated ?? entry?.message ?? entry?.label ?? null,
    source: entry?.source ?? null,
    resolution,
  }
}

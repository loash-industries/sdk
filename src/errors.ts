/**
 * Typed error surface for the SDK. Every failure the SDK raises is a
 * {@link TriexClientError} carrying a stable {@link TriexError} `code`, so
 * callers can branch on `code` without string-matching messages.
 */
export enum TriexError {
  /** A write was attempted but no `executor` was configured. */
  ExecutorRequired = 'TRIEX_EXECUTOR_REQUIRED',
  /** The operation needs the player address (set `address` in config). */
  AddressRequired = 'TRIEX_ADDRESS_REQUIRED',
  /** A read was attempted but no `apiKey` was configured. */
  ApiKeyRequired = 'TRIEX_API_KEY_REQUIRED',
  /**
   * The API key was rejected (HTTP 401/403) — missing, revoked, or lacking
   * access to this route. Check `TRINARY_API_KEY` / the key's tier.
   */
  Unauthorized = 'TRIEX_UNAUTHORIZED',
  /**
   * Compute-unit budget exhausted (HTTP 429). Back off and retry —
   * `retryAfterMs` carries the server's Retry-After hint when present.
   * Discovery is the most expensive read (150 CU).
   */
  RateLimited = 'TRIEX_RATE_LIMITED',
  /** The indexer returned an unexpected non-2xx response (5xx, unmapped 4xx). */
  IndexerError = 'TRIEX_INDEXER_ERROR',
  /** The indexer response did not match the expected schema. */
  UnexpectedResponse = 'TRIEX_UNEXPECTED_RESPONSE',
  /** Local input validation failed. */
  ValidationFailed = 'TRIEX_VALIDATION_FAILED',
  /** Not enough wallet / hangar / balance-manager funds to build the PTB. */
  InsufficientBalance = 'TRIEX_INSUFFICIENT_BALANCE',
  /**
   * Owned item receipts exist but in a different MultiCoin collection than
   * the market trades (wrong deployment/network, or re-initialized registry).
   */
  CollectionMismatch = 'TRIEX_COLLECTION_MISMATCH',
  /** No balance manager found for the player (and one was expected). */
  BalanceManagerNotFound = 'TRIEX_BALANCE_MANAGER_NOT_FOUND',
  /** No pool exists for the requested item + storage unit. */
  PoolNotFound = 'TRIEX_POOL_NOT_FOUND',
  /** The requested trade hub / storage unit could not be resolved. */
  HubNotFound = 'TRIEX_HUB_NOT_FOUND',
  /** The requested solar system (by name or numeric id) does not exist. */
  SolarSystemNotFound = 'TRIEX_SOLAR_SYSTEM_NOT_FOUND',
  /** The player's on-chain character could not be resolved. */
  CharacterNotFound = 'TRIEX_CHARACTER_NOT_FOUND',
  /** The transaction executed but failed (aborted) on-chain. */
  TransactionFailed = 'TRIEX_TRANSACTION_FAILED',
  /** A wait helper (`untilIndexed`) gave up before the condition held. */
  Timeout = 'TRIEX_TIMEOUT',
  /** Placeholder — the code path is scaffolded but not yet implemented. */
  NotImplemented = 'TRIEX_NOT_IMPLEMENTED',
}

export class TriexClientError extends Error {
  constructor(
    public readonly code: TriexError,
    message: string,
    public readonly cause?: unknown,
    /** HTTP status, when the failure was an HTTP response. */
    public readonly status?: number,
    /** Server-suggested wait before retrying (`RateLimited` only). */
    public readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'TriexClientError'
  }
}

/** Small helper for the many `throw new TriexClientError(...)` sites. */
export function fail(
  code: TriexError,
  message: string,
  cause?: unknown,
): never {
  throw new TriexClientError(code, message, cause)
}

/** Marks an intentionally-unimplemented scaffold method. */
export function notImplemented(what: string): never {
  throw new TriexClientError(
    TriexError.NotImplemented,
    `${what} is not implemented yet (scaffold).`,
  )
}

// ─── On-chain abort translation ──────────────────────────────────────────────

/**
 * Known CLOB Move abort codes (contracts:
 * https://github.com/loash-industries/trinary-exchange) → developer-facing
 * explanations, keyed by `module::code` (TRIEX_SYSTEM_DESIGN §11 —
 * Transaction Abort Codes).
 */
const MOVE_ABORTS: Record<string, string> = {
  'pool::12':
    'Slippage too high — the order price moved (EMinimumQuantityOutNotMet)',
  'book::2': 'No liquidity available (EEmptyOrderbook)',
  'order_info::5':
    'POST-ONLY order would cross the book — use a plain limit order (EPOSTOrderCrossesOrderbook)',
  'order_info::6':
    'Not enough liquidity to fully fill a FOK order (EFOKOrderCannotBeFullyFilled)',
  'order_info::8':
    'Self-match would cancel your order (ESelfMatchingCancelTaker)',
  'balance_manager::3':
    'Balance manager holds insufficient currency — deposit more (EBalanceManagerBalanceTooLow)',
  'balance_manager::7':
    'Balance manager holds insufficient items (EMultiCoinBalanceTooLow)',
  'state::2':
    'Max 100 open orders per balance manager per pool reached (EMaxOpenOrders)',
  'book::7':
    'Modified quantity must be less than the original (ENewQuantityMustBeLessThanOriginal)',
  'book::8':
    'Order not found — already filled or canceled? (EBookOrderNotFound)',
  'order_info::4': 'Invalid order restriction value (EInvalidOrderType)',
  'order_info::0': 'Price out of valid range (EOrderInvalidPrice)',
  'order_info::3': 'Expire timestamp is in the past (EInvalidExpireTimestamp)',
}

/**
 * Translate a raw Sui execution error into a developer-readable explanation of
 * the CLOB abort, or null when the error is not a recognized Move abort.
 * Feed it anything: the thrown error, `effects.status.error`, or a string.
 */
export function explainMoveAbort(error: unknown): string | null {
  const text =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : JSON.stringify(error ?? '')
  // Matches the shapes Sui errors arrive in:
  //  - `MoveAbort(MoveLocation { … name: Identifier("book") … }, 2)` (quotes
  //    possibly backslash-escaped inside JSON-stringified errors)
  //  - `…::book::fn…, abort code: 2` and the reversed pre-submit resolution
  //    form `MoveAbort in Nth command, abort code: 8, in '0x…::book::fn'`
  //  - structured `module … book … abort_code: 2`
  let module: string | undefined
  let code: string | undefined
  let m = /Identifier\(\\*"([a-z_]+)\\*"\)[\s\S]*?},?\s*(\d+)\)/.exec(text)
  if (m) [, module, code] = m
  if (!module) {
    m = /::([a-z_]+)::[a-z_]+[^,]*,\s*abort code:?\s*(\d+)/i.exec(text)
    if (m) [, module, code] = m
  }
  if (!module) {
    m = /abort code:?\s*(\d+)[\s\S]*?::([a-z_]+)::[a-z_]+/i.exec(text)
    if (m) [, code, module] = m
  }
  if (!module) {
    m = /module:?\s*'?"?([a-z_]+)'?"?[\s\S]*?abort_code:?\s*"?(\d+)"?/i.exec(
      text,
    )
    if (m) [, module, code] = m
  }
  if (!module || !code) return null
  return MOVE_ABORTS[`${module}::${code}`] ?? null
}

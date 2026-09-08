import {
  explainMoveAbortDetailed,
  parseMoveAbort,
  unpackAbortCode,
  type MoveAbortExplanation,
  type AbortCodeBits,
} from './moveAbort'

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
 * Translate a raw Sui execution error into a developer-readable explanation of the
 * CLOB abort, or null when the error is not a recognized Move abort.
 * Feed it anything: the thrown error, `effects.status.error`, or a string.
 *
 * Backed by a catalog generated from the contract sources, so it covers every abort
 * constant the contracts declare rather than a hand-kept subset. Use
 * {@link explainMoveAbortDetailed} when you need the module, code and constant
 * separately instead of one prose string.
 */
export function explainMoveAbort(error: unknown): string | null {
  const detail = explainMoveAbortDetailed(error)
  if (!detail || !detail.explanation) return null
  return detail.constant
    ? `${detail.explanation} (${detail.constant})`
    : detail.explanation
}

export { explainMoveAbortDetailed, parseMoveAbort, unpackAbortCode }
export type { MoveAbortExplanation, AbortCodeBits }

/**
 * Typed error surface for the SDK. Every failure the SDK raises is a
 * {@link TriexClientError} carrying a stable {@link TriexError} `code`, so
 * callers can branch on `code` without string-matching messages.
 */
export enum TriexError {
  /** A write was attempted but no `executor` was configured. */
  ExecutorRequired = 'TRIEX_EXECUTOR_REQUIRED',
  /** A read was attempted but no `apiKey` was configured. */
  ApiKeyRequired = 'TRIEX_API_KEY_REQUIRED',
  /** The indexer returned a non-2xx response. */
  IndexerError = 'TRIEX_INDEXER_ERROR',
  /** The indexer response did not match the expected schema. */
  UnexpectedResponse = 'TRIEX_UNEXPECTED_RESPONSE',
  /** Local input validation (zod) failed. */
  ValidationFailed = 'TRIEX_VALIDATION_FAILED',
  /** Not enough wallet / hangar / balance-manager funds to build the PTB. */
  InsufficientBalance = 'TRIEX_INSUFFICIENT_BALANCE',
  /** No balance manager found for the player (and one was expected). */
  BalanceManagerNotFound = 'TRIEX_BALANCE_MANAGER_NOT_FOUND',
  /** No pool exists for the requested item + storage unit. */
  PoolNotFound = 'TRIEX_POOL_NOT_FOUND',
  /** The requested trade hub / storage unit could not be resolved. */
  HubNotFound = 'TRIEX_HUB_NOT_FOUND',
  /** The player's on-chain character could not be resolved. */
  CharacterNotFound = 'TRIEX_CHARACTER_NOT_FOUND',
  /** Placeholder — the code path is scaffolded but not yet implemented. */
  NotImplemented = 'TRIEX_NOT_IMPLEMENTED',
}

export class TriexClientError extends Error {
  constructor(
    public readonly code: TriexError,
    message: string,
    public readonly cause?: unknown,
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

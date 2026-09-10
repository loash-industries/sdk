import type { Transaction } from '@mysten/sui/transactions'
import type { TransactionExecutor } from '@trinaryex/sdk'

/**
 * Signal thrown by the capture executor to unwind an SDK write call once the
 * transaction has been fully built, *before* anything is signed or submitted.
 *
 * The SDK's `executeAndNormalize` rethrows unrecognized executor errors
 * untouched (it only wraps `TriexClientError` and Move-abort-shaped messages),
 * so this class must never carry a message matching `/MoveAbort|abort code/i`.
 */
export class TransactionCaptured extends Error {
  readonly transaction: Transaction

  constructor(transaction: Transaction) {
    super('triex-mcp: transaction captured for preparation')
    this.name = 'TransactionCaptured'
    this.transaction = transaction
  }
}

/**
 * Raised when an SDK call completed without ever handing a transaction to the
 * executor — meaning there was nothing to prepare (e.g. `account.ensure()` on
 * an address that already has a balance manager).
 */
export class NothingToPrepare extends Error {
  readonly result: unknown

  constructor(result: unknown) {
    super('triex-mcp: the requested action needs no transaction')
    this.name = 'NothingToPrepare'
    this.result = result
  }
}

/**
 * An executor that never executes. Handed to a `TriexClient` in place of a
 * signing executor, it intercepts the fully-built PTB and aborts the call.
 *
 * This is what makes the server keyless: transaction *construction* runs here,
 * transaction *commitment* stays with whoever holds the private key.
 */
export const captureExecutor: TransactionExecutor = (tx: Transaction) => {
  throw new TransactionCaptured(tx)
}

/**
 * Run an SDK write call and return the transaction it built instead of
 * executing it.
 *
 * @throws {NothingToPrepare} when the call finished without building a tx.
 */
export async function captureTransaction(
  run: () => Promise<unknown>,
): Promise<Transaction> {
  let result: unknown
  try {
    result = await run()
  } catch (e) {
    if (e instanceof TransactionCaptured) return e.transaction
    throw e
  }
  throw new NothingToPrepare(result)
}

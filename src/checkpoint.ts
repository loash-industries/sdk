import { TriexClientError, TriexError } from './errors'

/**
 * The fullnode surface this needs: a gRPC client's ledger service. The v2 core
 * API (`getTransaction`) does not report the checkpoint a transaction landed
 * in; `SuiGrpcClient.ledgerService` does.
 */
interface LedgerServiceLike {
  ledgerService?: {
    getTransaction(input: {
      digest?: string
      readMask?: { paths: string[] }
    }): PromiseLike<{
      response: { transaction?: { checkpoint?: bigint } }
    }>
  }
}

/**
 * The checkpoint a transaction was included in, from the fullnode — the
 * number to pass as `minCheckpoint` so the next indexer read reflects it.
 *
 * A transaction is final (effects certified) slightly before it is
 * checkpointed, so this polls briefly until the fullnode reports one.
 *
 * ```ts
 * const placed = await client.orders.limit({ … })
 * const minCheckpoint = await client.checkpointOf(placed)
 * const { orders } = await client.orders.openOrders({ minCheckpoint })
 * ```
 *
 * @throws `ValidationFailed` when `suiClient` is not a gRPC client
 *   (`SuiGrpcClient`); `Timeout` when no checkpoint is reported in time.
 */
export async function transactionCheckpoint(
  suiClient: unknown,
  digest: string,
  options?: {
    /** Give up after this long (default 15_000ms). */
    timeoutMs?: number
    /** Delay between polls (default 500ms). */
    intervalMs?: number
  },
): Promise<bigint> {
  const ledger = (suiClient as LedgerServiceLike | undefined)?.ledgerService
  if (!ledger || typeof ledger.getTransaction !== 'function') {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      'checkpointOf needs a gRPC fullnode client (SuiGrpcClient from @mysten/sui/grpc): the core client API does not report checkpoints.',
    )
  }
  const timeoutMs = options?.timeoutMs ?? 15_000
  const intervalMs = options?.intervalMs ?? 500
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const { response } = await ledger.getTransaction({
        digest,
        readMask: { paths: ['checkpoint'] },
      })
      const checkpoint = response.transaction?.checkpoint
      if (checkpoint !== undefined && checkpoint !== null) {
        return BigInt(checkpoint)
      }
    } catch (e) {
      // NOT_FOUND until the fullnode has the transaction; anything else is real.
      const text = e instanceof Error ? e.message : String(e)
      if (!/not.?found/i.test(text)) throw e
    }
    if (Date.now() + intervalMs > deadline) {
      throw new TriexClientError(
        TriexError.Timeout,
        `Timed out after ${timeoutMs}ms waiting for transaction ${digest} to be checkpointed.`,
      )
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

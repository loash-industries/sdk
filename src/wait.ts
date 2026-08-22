import { TriexClientError, TriexError } from './errors'

/**
 * Read-your-writes helper for the indexer's eventual consistency (it trails
 * the chain by a few seconds). Polls `probe` until it returns a truthy value
 * and resolves with it — the pattern every bot otherwise hand-rolls after a
 * write:
 *
 * ```ts
 * await client.orders.limit({ … })
 * const order = await untilIndexed(async () => {
 *   const { orders } = await client.orders.openOrders({ limit: 20 })
 *   return orders.find((o) => o.assetId === assetId && o.price === price)
 * })
 * ```
 *
 * Remember each probe billed against the API key costs compute units — keep
 * `intervalMs` modest.
 *
 * @throws `Timeout` when `timeoutMs` elapses without a truthy probe result.
 */
export async function untilIndexed<T>(
  probe: () => Promise<T | null | undefined | false>,
  options?: {
    /** Give up after this long (default 30_000ms). */
    timeoutMs?: number
    /** Delay between probes (default 2_000ms). */
    intervalMs?: number
    /** Names the wait in the timeout error message. */
    label?: string
  },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 30_000
  const intervalMs = options?.intervalMs ?? 2_000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await probe()
    if (result) return result
    if (Date.now() + intervalMs > deadline) {
      throw new TriexClientError(
        TriexError.Timeout,
        `Timed out after ${timeoutMs}ms waiting for ${options?.label ?? 'the indexer to reflect the change'} — the indexer lags the chain by seconds; the on-chain write itself is unaffected.`,
      )
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

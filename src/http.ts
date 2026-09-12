import { TriexClientError, TriexError } from './errors'

/** Query values accepted by {@link indexerGet}; `undefined` keys are dropped. */
export type QueryParams = Record<string, string | number | boolean | undefined>

/**
 * GET a path on the indexer (+ optional query) and return parsed JSON, mapping
 * HTTP failures onto specific `TriexError` codes: 401/403 → `Unauthorized`,
 * 429 → `RateLimited` (with `retryAfterMs`), 404 → the endpoint's `notFound`
 * code when given, everything else → `IndexerError`.
 *
 * Extracted from `IndexerClient` so every read surface — trading and Armature
 * alike — maps failures identically rather than re-deriving the ladder.
 */
export async function indexerGet<T = unknown>(
  baseUrl: string,
  apiKey: string,
  path: string,
  query?: QueryParams,
  notFound?: TriexError,
): Promise<T> {
  if (!apiKey) {
    throw new TriexClientError(
      TriexError.ApiKeyRequired,
      'An apiKey is required for indexer reads.',
    )
  }
  const url = new URL(path, baseUrl)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
  })
  if (!res.ok) {
    // Surface the API's own message when it sent one (NestJS-style bodies).
    let detail = ''
    try {
      const body: any = await res.json()
      const msg = body?.message ?? body?.error ?? body?.reason
      if (msg)
        detail = ` — ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`
    } catch {
      // non-JSON body — ignore
    }
    const base = `Indexer ${res.status} ${res.statusText} for GET ${url.pathname}${detail}`

    if (res.status === 401 || res.status === 403) {
      throw new TriexClientError(
        TriexError.Unauthorized,
        `${base}. Check TRINARY_API_KEY and the key's access tier.`,
        undefined,
        res.status,
      )
    }
    if (res.status === 429) {
      const retryAfter = res.headers?.get?.('retry-after')
      let retryAfterMs: number | undefined
      if (retryAfter) {
        const secs = Number(retryAfter)
        retryAfterMs = Number.isFinite(secs)
          ? secs * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now()) || undefined
      }
      throw new TriexClientError(
        TriexError.RateLimited,
        `${base}. Compute-unit budget exhausted — back off${retryAfterMs ? ` ~${retryAfterMs}ms` : ''} and retry.`,
        undefined,
        res.status,
        retryAfterMs,
      )
    }
    if (res.status === 404 && notFound) {
      throw new TriexClientError(notFound, base, undefined, res.status)
    }
    throw new TriexClientError(
      TriexError.IndexerError,
      base,
      undefined,
      res.status,
    )
  }
  return (await res.json()) as T
}

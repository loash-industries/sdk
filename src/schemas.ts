import { z } from 'zod'
import { TriexClientError, TriexError } from './errors'

/**
 * Zod schemas for indexer (etl-api) responses.
 *
 * These are intentionally PROVISIONAL and lenient — the exact response shapes
 * are pinned in Phase 1 against etl-api's `/docs-json` (DESIGN.md RQ-1). Tighten
 * each schema, then let the domain types in `types.ts` be inferred from here.
 *
 * Convention: numeric on-chain quantities arrive as strings (to survive JSON /
 * u64) and are coerced to `bigint` via `bigintString`. Timestamps are epoch ms.
 */

/** A u64-ish value that may arrive as a JSON string or number → bigint. */
export const bigintString = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return BigInt(v)
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `not an integer: ${v}`,
      })
      return z.NEVER
    }
  })

export const OrderbookLevelSchema = z.object({
  price: bigintString,
  quantity: bigintString,
})

export const OrderbookSchema = z.object({
  poolId: z.string(),
  bids: z.array(OrderbookLevelSchema).default([]),
  asks: z.array(OrderbookLevelSchema).default([]),
})

export const PoolMetadataSchema = z.object({
  poolId: z.string(),
  baseCollectionId: z.string(),
  assetId: z.string(),
  quoteCoinType: z.string(),
  feeBps: z.number().default(0),
  version: z.number().default(1),
})

export const DiscoveryOrderSchema = z.object({
  poolId: z.string(),
  hubId: z.string(),
  typeId: z.string(),
  side: z.enum(['buy', 'sell']),
  price: bigintString,
  quantity: bigintString,
  createdAt: z.number(),
})

export const DiscoveryResultSchema = z.object({
  orders: z.array(DiscoveryOrderSchema).default([]),
  nextCursor: z.string().optional(),
})

/**
 * Validate an indexer payload, wrapping zod failures as a typed SDK error so
 * callers never see a raw ZodError.
 */
export function parseWith<T>(
  schema: z.ZodType<T>,
  data: unknown,
  what: string,
): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new TriexClientError(
      TriexError.UnexpectedResponse,
      `Unexpected indexer response for ${what}: ${result.error.message}`,
      result.error,
    )
  }
  return result.data
}

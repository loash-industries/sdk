import { z } from 'zod'
import { bigintString } from '../schemas'

/**
 * Zod schemas for the coin surface of the gateway, pinned against the
 * published swagger (`GET /v1/coins` → `CoinResponse[]`, vendored in
 * test/fixtures/gateway-openapi.json). Same conventions as `schemas.ts`:
 * snake_case wire → camelCase domain, raw on-chain integers → bigint,
 * timestamps → epoch-ms numbers. Supply figures are WHOLE coins (floats) on
 * the wire and stay numbers.
 */

/** A raw integer that may be null (empty side / never traded / unknown). */
const nullableBigint = bigintString.nullable()

/**
 * `CoinMarketResponse` — the coin's most active pool, appended when it has
 * one. The base coin is the coin this entry describes, so `CoinInfoSchema`
 * fills the `base*` fields from it. Fields the gateway stopped sending in
 * 2026-11 (`pool_name`, the base/quote names and the entry fee) are still
 * read when present but are null on the current contract — read fees from
 * `coins.tradeParams()` (the live `FeePolicy`).
 */
export const CoinMarketSchema = z
  .object({
    pool_id: z.string(),
    quote_asset_id: z.string().nullable(),
    quote_asset_symbol: z.string().nullable(),
    quote_asset_decimals: z.number().nullable(),
    best_bid: nullableBigint,
    best_ask: nullableBigint,
    last_price: nullableBigint,
    last_traded_at: z.number().nullable(),
    open_orders: z.number(),
    traders: z.number(),
    price_change_24h: z.number().nullable().optional(),
    // Dropped upstream in 2026-11; kept optional for older gateways.
    pool_name: z.string().nullable().optional(),
    quote_asset_name: z.string().nullable().optional(),
    fee: nullableBigint.optional(),
    fee_rate: z.number().nullable().optional(),
  })
  .transform((v) => ({
    /** The representative (most active) pool for this coin. */
    poolId: v.pool_id,
    poolName: v.pool_name ?? null,
    /** Fully-qualified quote coin type (CRED for permissionless pools). */
    quoteCoinType: v.quote_asset_id,
    quoteSymbol: v.quote_asset_symbol,
    quoteName: v.quote_asset_name ?? null,
    quoteDecimals: v.quote_asset_decimals,
    /**
     * Entry-tier TAKER rate, 1e9-scaled; null on the current contract. Order
     * funding reads the live `FeePolicy` on-chain (`coins.tradeParams`).
     */
    feeRateScaled: v.fee ?? null,
    /** `feeRateScaled / 1e9`; null on the current contract. */
    feeRate: v.fee_rate ?? null,
    /** Raw 1e9-scaled prices; null when that side is empty / never traded. */
    bestBid: v.best_bid,
    bestAsk: v.best_ask,
    lastPrice: v.last_price,
    /** Epoch ms of the last trade; null if never traded. */
    lastTradedAt: v.last_traded_at,
    openOrders: v.open_orders,
    traders: v.traders,
    /** 24h price change as a fraction (0.0372 = +3.72%); null if unknown. */
    priceChange24h: v.price_change_24h ?? null,
  }))

export const CoinTreasuryHoldingSchema = z
  .object({
    address: z.string(),
    label: z.string().nullable(),
    type: z.string(),
    amount: z.number(),
  })
  .transform((v) => ({
    address: v.address,
    label: v.label,
    /** Holding kind, e.g. treasury / team / vesting / locked. */
    type: v.type,
    /** Whole coins. */
    amount: v.amount,
  }))

export const CoinMintPolicySchema = z
  .object({
    kind: z.enum(['fixed', 'mintable']),
    capped: z.boolean().nullable().optional(),
  })
  .transform((v) => ({ kind: v.kind, capped: v.capped ?? null }))

/** `CoinResponse` — one coin from the token registry, pooled or not. */
export const CoinInfoSchema = z
  .object({
    coin_type: z.string(),
    symbol: z.string().nullable(),
    name: z.string().nullable(),
    decimals: z.number().nullable(),
    icon_url: z.string().nullable(),
    total_supply: z.number().nullable(),
    circulating: z.number().nullable(),
    treasury_holdings: z.array(CoinTreasuryHoldingSchema).nullable(),
    max_supply: z.number().nullable(),
    mint_policy: CoinMintPolicySchema.nullable(),
    immutable: z.boolean().nullable(),
    upgradeable: z.boolean().nullable(),
    // Not on the 2026-11 contract; kept for older gateways.
    verified: z.boolean().nullish(),
    market: CoinMarketSchema.nullable(),
  })
  .transform((v) => ({
    coinType: v.coin_type,
    symbol: v.symbol,
    name: v.name,
    decimals: v.decimals,
    iconUrl: v.icon_url,
    /** Whole coins. */
    totalSupply: v.total_supply,
    /** Whole coins: total minus known treasury holdings. */
    circulating: v.circulating,
    treasuryHoldings: v.treasury_holdings,
    /** Whole coins; null when uncapped. */
    maxSupply: v.max_supply,
    mintPolicy: v.mint_policy,
    /** Metadata cap deleted — metadata can no longer change. */
    immutable: v.immutable,
    upgradeable: v.upgradeable,
    /** Supply facts were read from chain; null when not reported. */
    verified: v.verified ?? null,
    /** The coin's pool (usually vs CRED); null when it has none. */
    market: v.market
      ? {
          ...v.market,
          /** The coin this entry describes is the pool's base. */
          baseCoinType: v.coin_type,
          baseSymbol: v.symbol,
          baseName: v.name,
          baseDecimals: v.decimals,
        }
      : null,
  }))

export const CoinListSchema = z.array(CoinInfoSchema)

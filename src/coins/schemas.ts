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

/** `CoinMarket` — the coin's pool, appended when it has one. */
export const CoinMarketSchema = z
  .object({
    base_asset_id: z.string(),
    base_asset_symbol: z.string().nullable(),
    base_asset_name: z.string().nullable(),
    base_asset_decimals: z.number(),
    quote_asset_id: z.string(),
    quote_asset_symbol: z.string().nullable(),
    quote_asset_name: z.string().nullable(),
    quote_asset_decimals: z.number(),
    pool_id: z.string(),
    pool_name: z.string().nullable(),
    fee: nullableBigint,
    fee_rate: z.number().nullable(),
    best_bid: nullableBigint,
    best_ask: nullableBigint,
    open_orders: z.number(),
    traders: z.number(),
    last_price: nullableBigint,
    last_traded_at: z.number().nullable(),
  })
  .transform((v) => ({
    poolId: v.pool_id,
    poolName: v.pool_name,
    /** Fully-qualified base coin type (the coin this entry describes). */
    baseCoinType: v.base_asset_id,
    baseSymbol: v.base_asset_symbol,
    baseName: v.base_asset_name,
    baseDecimals: v.base_asset_decimals,
    /** Fully-qualified quote coin type (CRED for permissionless pools). */
    quoteCoinType: v.quote_asset_id,
    quoteSymbol: v.quote_asset_symbol,
    quoteName: v.quote_asset_name,
    quoteDecimals: v.quote_asset_decimals,
    /**
     * Entry-tier TAKER rate, 1e9-scaled (11_000_000 = 1.10%); null if unknown.
     * Display only — order funding reads the live `FeePolicy` on-chain
     * (`coins.tradeParams`), which also carries the maker rate.
     */
    feeRateScaled: v.fee,
    /** `feeRateScaled / 1e9`. */
    feeRate: v.fee_rate,
    /** Raw 1e9-scaled prices; null when that side is empty / never traded. */
    bestBid: v.best_bid,
    bestAsk: v.best_ask,
    lastPrice: v.last_price,
    /** Epoch ms of the last trade; null if never traded. */
    lastTradedAt: v.last_traded_at,
    openOrders: v.open_orders,
    traders: v.traders,
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
    verified: z.boolean().nullable(),
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
    /** Supply facts were read from chain. */
    verified: v.verified,
    /** The coin's pool (usually vs CRED); null when it has none. */
    market: v.market,
  }))

export const CoinListSchema = z.array(CoinInfoSchema)

import { z } from 'zod'
import { TriexClientError, TriexError } from './errors'

/**
 * Zod schemas for gateway responses (etl-api, location-api and the public
 * CDN behind `api.trinary.exchange`), pinned against the gateway's published
 * OpenAPI document (`test/fixtures/gateway-openapi.json`, re-audited field by
 * field 2026-10-01) — resolves RQ-1.
 *
 * Each schema validates the snake_case wire shape and TRANSFORMS it into the
 * SDK's camelCase domain shape; the domain types in `types.ts` are inferred
 * from these schemas (single source of truth).
 *
 * Conventions (per the spec): raw on-chain integers (prices, quantities,
 * amounts) arrive as decimal strings → `bigint`. Timestamps are epoch-ms
 * integers → `number`, except order-book expiries which can be MAX_U64 for
 * good-til-cancelled → `bigint`. A few feeds also carry HUMAN-READABLE
 * decimals (already shifted by the quote currency's decimals) — those stay
 * strings and say so on the field.
 *
 * Strictness: a field the SDK computes with (ids, amounts, sides) is required
 * and typed exactly. Enumerations the gateway may extend (order status, price
 * tiers, route modes) are {@link openEnum}s — known values autocomplete, a new
 * one still parses rather than failing the whole response. Unknown extra
 * fields are dropped (zod's default), so additive gateway changes never break
 * a parse.
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

/**
 * A string the spec enumerates but may extend. The output type keeps the known
 * literals for autocomplete and narrowing, while `string & NonNullable<unknown>`
 * (the `string & {}` idiom) admits a
 * value added upstream after this SDK shipped — a new order status must not
 * turn every order read into an `UnexpectedResponse`.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(
  _known: T,
) {
  return z
    .string()
    .transform((v) => v as T[number] | (string & NonNullable<unknown>))
}

// ─── Discovery (#6) ──────────────────────────────────────────────────────────

export const DiscoveryOrderSchema = z
  .object({
    pool_id: z.string(),
    order_id: z.string(),
    price: bigintString,
    is_bid: z.boolean(),
    trading_account_id: z.string(),
    remaining_quantity: bigintString,
    filled_quantity: bigintString,
    expires_at: z.number().nullable(),
    last_activity_at: z.number(),
    asset_id: z.string(),
    collection_id: z.string(),
    hub_id: z.string().nullable(),
    hub_name: z.string().nullable(),
    hub_state: z.string().nullable(),
    quote_asset_id: z.string().nullable(),
    quote_asset_symbol: z.string().nullable(),
    quote_asset_decimals: z.number().nullable(),
    trader_address: z.string().nullable(),
    trader_name: z.string().nullable(),
  })
  .transform((v) => ({
    poolId: v.pool_id,
    orderId: v.order_id,
    price: v.price,
    isBid: v.is_bid,
    tradingAccountId: v.trading_account_id,
    remainingQuantity: v.remaining_quantity,
    filledQuantity: v.filled_quantity,
    /** Epoch ms; null = good-til-cancelled. */
    expiresAt: v.expires_at,
    lastActivityAt: v.last_activity_at,
    assetId: v.asset_id,
    collectionId: v.collection_id,
    hubId: v.hub_id,
    hubName: v.hub_name,
    hubState: v.hub_state,
    quoteAssetId: v.quote_asset_id,
    quoteAssetSymbol: v.quote_asset_symbol,
    quoteAssetDecimals: v.quote_asset_decimals,
    traderAddress: v.trader_address,
    traderName: v.trader_name,
  }))

export const DiscoveryResultSchema = z
  .object({
    data: z.array(DiscoveryOrderSchema),
    next_cursor: z.string().nullable(),
    prev_cursor: z.string().nullable(),
  })
  .transform((v) => ({
    orders: v.data,
    nextCursor: v.next_cursor,
    prevCursor: v.prev_cursor,
  }))

// ─── Pools (#9, #10, #11) ────────────────────────────────────────────────────

export const PoolResolveSchema = z
  .object({ pool_id: z.string().nullable() })
  .transform((v) => ({ poolId: v.pool_id }))

/** One resting order on the book (the indexer returns orders, not levels). */
export const OrderbookOrderSchema = z
  .object({
    encodedOrderId: z.string(),
    quantity: bigintString,
    filledQuantity: bigintString,
    expireTimestamp: bigintString,
    lastUpdatedTimestamp: bigintString,
    status: z.number(),
    price: bigintString,
  })
  .transform((v) => ({
    orderId: v.encodedOrderId,
    /** Original order quantity (= remaining + filled). */
    quantity: v.quantity,
    filledQuantity: v.filledQuantity,
    remainingQuantity: v.quantity - v.filledQuantity,
    /** Epoch ms as bigint — MAX_U64 for good-til-cancelled. */
    expireTimestamp: v.expireTimestamp,
    lastUpdatedTimestamp: v.lastUpdatedTimestamp,
    status: v.status,
    price: v.price,
  }))

export const OrderbookSchema = z.object({
  /** Bids, highest first. */
  bids: z.array(OrderbookOrderSchema),
  /** Asks, lowest first. */
  asks: z.array(OrderbookOrderSchema),
})

export const PoolMetadataSchema = z
  .object({
    pool_id: z.string(),
    pool_name: z.string(),
    base_asset_symbol: z.string(),
    base_asset_name: z.string().nullable(),
    base_asset_decimals: z.number(),
    quote_asset_symbol: z.string(),
    quote_asset_name: z.string().nullable(),
    quote_asset_decimals: z.number(),
    storage_unit_id: z.string().nullable(),
    asset_id: z.string().nullable(),
    collection_id: z.string().nullable(),
    fee: z.string().nullable(),
    fee_rate: z.number().nullable(),
  })
  .transform((v) => ({
    poolId: v.pool_id,
    poolName: v.pool_name,
    baseAssetSymbol: v.base_asset_symbol,
    baseAssetName: v.base_asset_name,
    baseAssetDecimals: v.base_asset_decimals,
    quoteAssetSymbol: v.quote_asset_symbol,
    quoteAssetName: v.quote_asset_name,
    quoteAssetDecimals: v.quote_asset_decimals,
    storageUnitId: v.storage_unit_id,
    assetId: v.asset_id,
    collectionId: v.collection_id,
    /**
     * Entry-tier TAKER rate of the pool's fee class, scaled by 1e9
     * (22_000_000 = 2.2%) — what an account with no turnover pays; 0n when
     * unknown. While a class change is pending it is the higher of the old and
     * new entry rates. Maker rates and an account's own tier are on-chain
     * only: `orders.fees()`; a bid deposit should use its `bidEscrowFeeRate`.
     * The rate a fill actually charged is on the fill (`fee`,
     * `makerFee`/`takerFee`, `feeRateBps`).
     */
    feeRateScaled: v.fee === null ? 0n : BigInt(v.fee),
    /** Decimal form of `feeRateScaled` (fee / 1e9), for display. */
    feeRate: v.fee_rate,
  }))

/**
 * One-call market read for an item at a trade hub: vault linkage, resolved
 * pool, resting book, and pool metadata in a single response. `pool_id` is
 * null when the hub trades but no market exists for the item yet (the book
 * is then empty and `metadata` null).
 */
export const HubItemOrderbookSchema = z
  .object({
    hub_id: z.string(),
    collection_id: z.string(),
    vault_config_id: z.string().nullable(),
    pool_id: z.string().nullable(),
    metadata: PoolMetadataSchema.nullable(),
    bids: z.array(OrderbookOrderSchema),
    asks: z.array(OrderbookOrderSchema),
  })
  .transform((v) => ({
    hubId: v.hub_id,
    collectionId: v.collection_id,
    vaultConfigId: v.vault_config_id,
    poolId: v.pool_id,
    metadata: v.metadata,
    bids: v.bids,
    asks: v.asks,
  }))

// ─── Hubs (#4, #7, #8) ───────────────────────────────────────────────────────

export const HubVaultSchema = z
  .object({
    hub_id: z.string(),
    collection_id: z.string(),
    vault_config_id: z.string(),
  })
  .transform((v) => ({
    hubId: v.hub_id,
    collectionId: v.collection_id,
    vaultConfigId: v.vault_config_id,
  }))

/**
 * The placement fields every hub-location read returns, shared verbatim by
 * `/hubs/{id}/location`, `/hubs/locations`, `/items/{id}/locations`,
 * `/hubs/*nearby*` and `/hubs/enriched`. Each of those adds its own fields on
 * top (a resolved system name, a distance, market counts) — the common core is
 * factored out so the five stay in step when the gateway extends it.
 */
const hubPlacementShape = {
  hub_id: z.string(),
  assembly_item_id: z.string(),
  assembly_tenant: z.string(),
  type_id: z.string(),
  owner_cap_id: z.string(),
  owner: z.string().nullable(),
  solar_system: z.string(),
  x: z.string(),
  y: z.string(),
  z: z.string(),
  updated_at: z.number(),
  tx_digest: z.string(),
  is_public: z.boolean(),
  region_id: z.number().nullable(),
}

type HubPlacementWire = z.infer<z.ZodObject<typeof hubPlacementShape>>

/** Wire → domain for the shared placement core. */
function hubPlacement(v: HubPlacementWire) {
  return {
    hubId: v.hub_id,
    assemblyItemId: v.assembly_item_id,
    assemblyTenant: v.assembly_tenant,
    typeId: v.type_id,
    ownerCapId: v.owner_cap_id,
    owner: v.owner,
    /** Numeric solar-system id as a string; empty when unindexed. */
    solarSystemId: v.solar_system,
    /** Coordinates in metres, as decimal strings (they exceed f64 precision). */
    x: v.x,
    y: v.y,
    z: v.z,
    updatedAt: v.updated_at,
    txDigest: v.tx_digest,
    isPublic: v.is_public,
    regionId: v.region_id,
  }
}

export const HubLocationSchema = z
  .object({
    ...hubPlacementShape,
    solar_system_name: z.string().nullable(),
  })
  .transform((v) => ({
    ...hubPlacement(v),
    solarSystemName: v.solar_system_name,
  }))

/** A cursor-paged list of hub locations, as both listing endpoints return. */
export const HubLocationPageSchema = z
  .object({
    data: z.array(HubLocationSchema),
    next_cursor: z.string().nullable(),
  })
  .transform((v) => ({ locations: v.data, nextCursor: v.next_cursor }))

/** A hub location plus its distance from the search origin. */
export const NearbyHubSchema = z
  .object({
    ...hubPlacementShape,
    solar_system_name: z.string().nullable(),
    distance_ly: z.string(),
  })
  .transform((v) => ({
    ...hubPlacement(v),
    solarSystemName: v.solar_system_name,
    /** Distance from the search origin in light years, as a decimal string. */
    distanceLy: v.distance_ly,
  }))

/**
 * A hub location plus market counts and last storage activity. Note the
 * gateway does NOT resolve `solar_system_name` on this endpoint — pair it with
 * `solarSystemNames()` when a display name is needed.
 */
export const HubEnrichedSchema = z
  .object({
    ...hubPlacementShape,
    pool_count: z.number(),
    last_activity_at: z.number().nullable(),
  })
  .transform((v) => ({
    ...hubPlacement(v),
    poolCount: v.pool_count,
    lastActivityAt: v.last_activity_at,
  }))

export const HubItemSchema = z
  .object({
    asset_id: z.string(),
    has_bids: z.boolean(),
    has_asks: z.boolean(),
  })
  .transform((v) => ({
    assetId: v.asset_id,
    hasBids: v.has_bids,
    hasAsks: v.has_asks,
  }))

export const HubItemsPageSchema = z
  .object({
    data: z.array(HubItemSchema),
    next_cursor: z.string().nullable(),
  })
  .transform((v) => ({ items: v.data, nextCursor: v.next_cursor }))

export const CollectionHubSchema = z
  .object({ hub_id: z.string(), collection_id: z.string() })
  .transform((v) => ({ hubId: v.hub_id, collectionId: v.collection_id }))

// ─── Locations: on-chain resolution helpers ─────────────────────────────────
//
// The gateway's location surface answers "where is this / who owns this" for
// three id families. Each is a batch read (max 200 ids, server-side cache), so
// the SDK exposes them as list-in/list-out rather than per-id calls.

export const AssemblyOwnerSchema = z
  .object({ assembly_id: z.string(), owner: z.string().nullable() })
  .transform((v) => ({ assemblyId: v.assembly_id, owner: v.owner }))

export const AssemblyEnrichedSchema = z
  .object({
    assembly_id: z.string(),
    owner: z.string().nullable(),
    owner_character_name: z.string().nullable(),
    owner_character_id: z.string().nullable(),
    assembly_name: z.string().nullable(),
  })
  .transform((v) => ({
    assemblyId: v.assembly_id,
    owner: v.owner,
    ownerCharacterName: v.owner_character_name,
    ownerCharacterId: v.owner_character_id,
    assemblyName: v.assembly_name,
  }))

export const TradingAccountOwnerSchema = z
  .object({
    trading_account_id: z.string(),
    owner: z.string().nullable(),
    owner_name: z.string().nullable(),
    root_ou_id: z.string().nullable(),
  })
  .transform((v) => ({
    tradingAccountId: v.trading_account_id,
    /**
     * TAGGED, not a bare address: `player:<wallet>` for a character-owned
     * trading account, `ou:<org_id>` for an organization-owned one. Null when
     * the indexer could not resolve it.
     */
    owner: v.owner,
    ownerName: v.owner_name,
    /** Top-level org when `owner` is a sub-organization; null otherwise. */
    rootOuId: v.root_ou_id,
  }))

export const SolarSystemNameSchema = z
  .object({
    solar_system_id: z.number(),
    solar_system_name: z.string().nullable(),
  })
  .transform((v) => ({
    solarSystemId: v.solar_system_id,
    solarSystemName: v.solar_system_name,
  }))

// ─── Spatial: the star map ──────────────────────────────────────────────────
//
// Coordinates are METRES as decimal strings, never JSON numbers — the values
// run past 2^53 and an IEEE-754 double silently rounds them. Distances and
// radii are light years, also as decimal strings on the way back. This is the
// same representation the hub-location reads use.

export const CoordinatesSchema = z
  .object({ x: z.string(), y: z.string(), z: z.string() })
  .transform((v) => ({ x: v.x, y: v.y, z: v.z }))

// Solar system names are PLAYER-REPORTED in cycle 7: the star map ships with
// ids, coordinates, constellations, regions and stargates, but a system's
// name is known only once a player reports it (location-api syncs reports
// from the EF-Map community map), and a reported name can later change.
// Until then location-api sends `solar_system_name: null`, so every name read
// here is nullable, and a NAME lookup for an unreported system 404s even
// though the same system resolves by id. Key on `solar_system_id`, and
// display the id when the name is null.

export const SolarSystemSchema = z
  .object({
    solar_system_id: z.number(),
    // Nullable since location-api's cycle-7 names change. The gateway spec
    // still documents a plain string, so `.nullish()` accepts both the
    // currently-published and the post-deploy shape (and a missing key).
    solar_system_name: z.string().nullish(),
    location: CoordinatesSchema,
    constellation_id: z.number().nullish(),
    region_id: z.number().nullish(),
  })
  .transform((v) => ({
    solarSystemId: v.solar_system_id,
    /** Null until a player has reported the system's name. */
    solarSystemName: v.solar_system_name ?? null,
    /** Position in metres from the galactic origin. */
    location: v.location,
    constellationId: v.constellation_id ?? null,
    /** Matches `regionId` on the hub-location reads. */
    regionId: v.region_id ?? null,
  }))

/**
 * A system found by a radius search. Only the id and the distance are
 * guaranteed: a system can be in the stargate graph but absent from the
 * coordinate index, in which case the gateway omits `location` and
 * `solar_system_name` entirely rather than sending nulls.
 */
export const NearbySystemSchema = z
  .object({
    solar_system_id: z.number(),
    distance_ly: z.string(),
    solar_system_name: z.string().nullish(),
    location: CoordinatesSchema.nullish(),
  })
  .transform((v) => ({
    solarSystemId: v.solar_system_id,
    /** Straight-line distance from the search origin, in light years. */
    distanceLy: v.distance_ly,
    solarSystemName: v.solar_system_name ?? null,
    location: v.location ?? null,
  }))

export const BatchSystemsSchema = z
  .object({ count: z.number(), systems: z.array(SolarSystemSchema) })
  .transform((v) => ({
    /**
     * How many resolved. Identifiers that matched nothing are OMITTED rather
     * than returned as nulls, so a count below the number asked for is how a
     * miss is detected.
     */
    count: v.count,
    systems: v.systems,
  }))

export const NearbySystemsSchema = z
  .object({
    solar_system_id: z.number(),
    // See SolarSystemSchema: nullable post-deploy, a string in today's spec.
    solar_system_name: z.string().nullish(),
    radius_ly: z.string(),
    count: z.number(),
    systems: z.array(NearbySystemSchema),
  })
  .transform((v) => ({
    /** The system searched from; it is excluded from `systems`. */
    originSolarSystemId: v.solar_system_id,
    /** Null until a player has reported the origin's name. */
    originSolarSystemName: v.solar_system_name ?? null,
    radiusLy: v.radius_ly,
    count: v.count,
    systems: v.systems,
  }))

export const CoordinateSearchSchema = z
  .object({
    location: CoordinatesSchema,
    radius_ly: z.string(),
    count: z.number(),
    systems: z.array(NearbySystemSchema),
  })
  .transform((v) => ({
    /** The origin point, echoed back in metres. */
    origin: v.location,
    radiusLy: v.radius_ly,
    count: v.count,
    systems: v.systems,
  }))

/**
 * Autocomplete only ever suggests REPORTED names, so the name is always
 * present here — but the index only covers systems a player has named, so a
 * prefix that matches nothing today may match tomorrow.
 */
export const SolarSystemSuggestionSchema = z
  .object({ solar_system_id: z.number(), solar_system_name: z.string() })
  .transform((v) => ({
    solarSystemId: v.solar_system_id,
    solarSystemName: v.solar_system_name,
  }))

export const AutocompleteSystemsSchema = z
  .object({
    count: z.number(),
    systems: z.array(SolarSystemSuggestionSchema),
  })
  .transform((v) => ({ count: v.count, systems: v.systems }))

export const SpatialStatsSchema = z
  .object({
    total_systems: z.number(),
    // Added by location-api's cycle-7 names change; absent from older builds.
    known_solar_system_names: z.number().nullish(),
    status: z.string(),
  })
  .transform((v) => ({
    totalSystems: v.total_systems,
    /**
     * How many systems have a player-reported name cached — only these can
     * be looked up BY NAME (ids always work). Null when the deployed
     * location-api predates name reporting.
     */
    knownSolarSystemNames: v.known_solar_system_names ?? null,
    /** `operational` when the coordinate index is loaded and queryable. */
    status: v.status,
  }))

// ─── Item search (#8a) ───────────────────────────────────────────────────────

export const ItemRecipeComponentSchema = z
  .object({ asset_id: z.string(), quantity: z.number() })
  .transform((v) => ({ assetId: v.asset_id, quantity: v.quantity }))

export const ItemRecipeSchema = z
  .object({
    output_quantity: z.number(),
    components: z.array(ItemRecipeComponentSchema),
  })
  .transform((v) => ({
    outputQuantity: v.output_quantity,
    components: v.components,
  }))

export const ItemSearchResultSchema = z
  .object({
    asset_id: z.string(),
    name: z.string().nullable(),
    symbol: z.string().nullable(),
    mass: z.number(),
    recipes: z.array(ItemRecipeSchema),
  })
  .transform((v) => ({
    assetId: v.asset_id,
    name: v.name,
    symbol: v.symbol,
    mass: v.mass,
    recipes: v.recipes,
  }))

export const ItemSearchPageSchema = z
  .object({ data: z.array(ItemSearchResultSchema) })
  .transform((v) => ({ items: v.data }))

// ─── Inventory balances (#2) ─────────────────────────────────────────────────

export const AssetBalanceSchema = z
  .object({ asset_id: z.string(), amount: bigintString })
  .transform((v) => ({ assetId: v.asset_id, amount: v.amount }))

/**
 * `GET /v1/inventory/balances` — hub-scoped ITEM balances. Currency (CRED)
 * balances are not served by the indexer at all; see `balances.currency()`
 * (fullnode). Sections are empty unless their selecting parameter was passed.
 */
export const InventoryBalancesSchema = z
  .object({
    storage_unit_id: z.string(),
    collection_id: z.string(),
    warehouse: z.array(AssetBalanceSchema),
    marketplace: z.array(AssetBalanceSchema),
    hangar: z.array(AssetBalanceSchema),
    org_vaults: z.record(z.string(), z.array(AssetBalanceSchema)),
  })
  .transform((v) => ({
    storageUnitId: v.storage_unit_id,
    collectionId: v.collection_id,
    /** Wallet-held receipt balances for `ownerAddress`. */
    warehouse: v.warehouse,
    /** Balance-manager-held balances for `tradingAccountId`. */
    marketplace: v.marketplace,
    /** Hangar contents for `inventoryKey` (an owner_cap_id). */
    hangar: v.hangar,
    /** Per-vault balances keyed by vault id, for `vaultIds`. */
    orgVaults: v.org_vaults,
  }))

// ─── Order status (#14) ──────────────────────────────────────────────────────

export const OpenOrderSchema = z
  .object({
    pool_id: z.string(),
    order_id: z.string(),
    encoded_order_id: z.string().optional(),
    side: z.enum(['buy', 'sell']),
    price: bigintString,
    remaining_quantity: bigintString,
    filled_quantity: bigintString,
    expires_at: z.number(),
    updated_at: z.number(),
    asset_id: z.string(),
    storage_unit_id: z.string(),
    quote_asset_symbol: z.string().nullable(),
    quote_asset_decimals: z.number().nullable(),
  })
  .transform((v) => ({
    poolId: v.pool_id,
    orderId: v.order_id,
    encodedOrderId: v.encoded_order_id,
    side: v.side,
    price: v.price,
    remainingQuantity: v.remaining_quantity,
    filledQuantity: v.filled_quantity,
    expiresAt: v.expires_at,
    updatedAt: v.updated_at,
    assetId: v.asset_id,
    storageUnitId: v.storage_unit_id,
    quoteAssetSymbol: v.quote_asset_symbol,
    quoteAssetDecimals: v.quote_asset_decimals,
  }))

export const OpenOrdersPageSchema = z
  .object({
    data: z.array(OpenOrderSchema),
    next_cursor: z.string().nullable(),
  })
  .transform((v) => ({ orders: v.data, nextCursor: v.next_cursor }))

export const FillSchema = z
  .object({
    event_digest: z.string(),
    pool_id: z.string(),
    order_id: z.string(),
    counterparty_trading_account_id: z.string(),
    price: bigintString,
    base_quantity: bigintString,
    quote_quantity: bigintString,
    fee: bigintString,
    role: z.enum(['maker', 'taker']),
    taker_is_bid: z.boolean(),
    filled_at: z.number(),
  })
  .transform((v) => ({
    eventDigest: v.event_digest,
    poolId: v.pool_id,
    orderId: v.order_id,
    counterpartyTradingAccountId: v.counterparty_trading_account_id,
    price: v.price,
    baseQuantity: v.base_quantity,
    quoteQuantity: v.quote_quantity,
    /** Fee paid by the queried account, in raw quote units. */
    fee: v.fee,
    role: v.role,
    takerIsBid: v.taker_is_bid,
    filledAt: v.filled_at,
  }))

export const FillsPageSchema = z
  .object({
    data: z.array(FillSchema),
    next_cursor: z.string().nullable(),
  })
  .transform((v) => ({ fills: v.data, nextCursor: v.next_cursor }))

export const TradeSchema = z
  .object({
    event_digest: z.string(),
    pool_id: z.string(),
    order_id: z.string(),
    counterparty_trading_account_id: z.string(),
    price: bigintString,
    base_quantity: bigintString,
    quote_quantity: bigintString,
    fee: bigintString,
    role: z.enum(['maker', 'taker']),
    side: z.enum(['buy', 'sell']),
    traded_at: z.number(),
    asset_id: z.string(),
    storage_unit_id: z.string(),
  })
  .transform((v) => ({
    eventDigest: v.event_digest,
    poolId: v.pool_id,
    orderId: v.order_id,
    counterpartyTradingAccountId: v.counterparty_trading_account_id,
    price: v.price,
    baseQuantity: v.base_quantity,
    quoteQuantity: v.quote_quantity,
    fee: v.fee,
    role: v.role,
    side: v.side,
    tradedAt: v.traded_at,
    assetId: v.asset_id,
    storageUnitId: v.storage_unit_id,
  }))

export const TradesPageSchema = z
  .object({
    data: z.array(TradeSchema),
    next_cursor: z.string().nullable(),
  })
  .transform((v) => ({ trades: v.data, nextCursor: v.next_cursor }))

// ─── Sweepable (claimable proceeds + idle BM items) ──────────────────────────

export const SweepableBalancesSchema = z
  .object({ base: bigintString, quote: bigintString, cred: bigintString })
  .transform((v) => ({ base: v.base, quote: v.quote, cred: v.cred }))

export const SweepablePoolSchema = z
  .object({
    pool_id: z.string(),
    collection_id: z.string(),
    asset_id: z.string(),
    quote_asset_id: z.string().nullable(),
    storage_unit_id: z.string(),
    vault_config_id: z.string(),
    settled: SweepableBalancesSchema,
    owed: SweepableBalancesSchema,
    open_order_count: z.number(),
  })
  .transform((v) => ({
    poolId: v.pool_id,
    collectionId: v.collection_id,
    assetId: v.asset_id,
    /** Quote coin type — the type argument for withdraw_settled_amounts. */
    quoteAssetId: v.quote_asset_id,
    storageUnitId: v.storage_unit_id,
    vaultConfigId: v.vault_config_id,
    /** Claimable into the trading account. */
    settled: v.settled,
    /** Informational: currently owed by the account. */
    owed: v.owed,
    openOrderCount: v.open_order_count,
  }))

export const SweepableItemSchema = z
  .object({
    collection_id: z.string(),
    asset_id: z.string(),
    amount: bigintString,
    // Nullable on the wire: the collection → hub linkage may not be indexed
    // yet. Requiring them made one unlinked item fail the whole manifest.
    storage_unit_id: z.string().nullable(),
    vault_config_id: z.string().nullable(),
  })
  .transform((v) => ({
    collectionId: v.collection_id,
    assetId: v.asset_id,
    amount: v.amount,
    /**
     * Hub backing the item's collection. EMPTY STRING while the indexer has
     * not linked the collection to a hub yet (wire `null`) — the same
     * "empty = not indexed" convention as `HubLocation.solarSystemId`. Such
     * an item cannot be withdrawn to a hub until the link appears.
     */
    storageUnitId: v.storage_unit_id ?? '',
    /** The hub vault's config object; empty string while unindexed (see above). */
    vaultConfigId: v.vault_config_id ?? '',
  }))

/**
 * `GET /v1/trading-accounts/{bm}/sweepable` — everything claimable /
 * withdrawable: per-pool settled (post-fill) proceeds and idle item balances
 * already sitting in the trading account. Note: BM-resident CRED is
 * deliberately NOT in this manifest — read it via `balances.currency()`.
 */
export const SweepableSchema = z
  .object({
    trading_account_id: z.string(),
    as_of_checkpoint: z.string().nullable(),
    pools: z.array(SweepablePoolSchema),
    items: z.array(SweepableItemSchema),
  })
  .transform((v) => ({
    tradingAccountId: v.trading_account_id,
    asOfCheckpoint: v.as_of_checkpoint,
    pools: v.pools,
    items: v.items,
  }))

// ─── Orders & fills: point lookups ───────────────────────────────────────────

/** Known order lifecycle states (`OrderDetail.status`). */
export const ORDER_STATUSES = ['open', 'filled', 'cancelled'] as const
/** Known order types — market/limit combined with direction. */
export const ORDER_TYPES = [
  'market_buy',
  'market_sell',
  'limit_buy',
  'limit_sell',
] as const

/** A character as embedded in order-detail parties. */
export const OrderCharacterSchema = z
  .object({
    character_id: z.string(),
    item_id: z.string(),
    tenant: z.string(),
    tribe_id: z.number().nullable(),
    character_address: z.string(),
    name: z.string(),
    description: z.string(),
    url: z.string(),
  })
  .transform((v) => ({
    characterId: v.character_id,
    itemId: v.item_id,
    tenant: v.tenant,
    tribeId: v.tribe_id,
    characterAddress: v.character_address,
    name: v.name,
    description: v.description,
    /** Portrait / metadata URL; empty when none is published. */
    url: v.url,
  }))

/** The trading account on one side of an order or fill. */
export const OrderPartySchema = z
  .object({
    id: z.string(),
    owner: z.string().nullable(),
    character: OrderCharacterSchema.nullable(),
  })
  .transform((v) => ({
    /** Trading account object id. */
    tradingAccountId: v.id,
    /** Wallet that owns the trading account; null when unresolved. */
    owner: v.owner,
    character: v.character,
  }))

/**
 * The trade hub an order rests at. Note the raw system field is spelled
 * `solarsystem` on this endpoint (not `solar_system` as on the location
 * reads); the numeric id and resolved name come alongside it.
 */
export const OrderHubSchema = z
  .object({
    hub_id: z.string(),
    assembly_item_id: z.string(),
    assembly_tenant: z.string(),
    type_id: z.string(),
    owner_cap_id: z.string(),
    owner: z.string().nullable(),
    solarsystem: z.string(),
    x: z.string(),
    y: z.string(),
    z: z.string(),
    solar_system_id: z.number().nullable(),
    solar_system_name: z.string().nullable(),
    is_public: z.boolean(),
    region_id: z.number().nullable(),
  })
  .transform((v) => ({
    hubId: v.hub_id,
    assemblyItemId: v.assembly_item_id,
    assemblyTenant: v.assembly_tenant,
    typeId: v.type_id,
    ownerCapId: v.owner_cap_id,
    owner: v.owner,
    /** Raw solar system identifier as indexed (string). */
    solarSystem: v.solarsystem,
    /** Coordinates in metres, as decimal strings. */
    x: v.x,
    y: v.y,
    z: v.z,
    solarSystemId: v.solar_system_id,
    /** Null until a player has reported the system's name (cycle 7). */
    solarSystemName: v.solar_system_name,
    isPublic: v.is_public,
    regionId: v.region_id,
  }))

export const OrderCurrencySchema = z
  .object({
    type_string: z.string(),
    name: z.string().nullable(),
    decimals: z.number(),
    icon_url: z.string().nullable(),
  })
  .transform((v) => ({
    /** Fully-qualified coin type (`<address>::<module>::<STRUCT>`). */
    coinType: v.type_string,
    name: v.name,
    decimals: v.decimals,
    iconUrl: v.icon_url,
  }))

/** One fill of an order, from that order's perspective. */
export const OrderDetailFillSchema = z
  .object({
    event_digest: z.string(),
    price: bigintString,
    base_quantity: bigintString,
    quote_quantity: bigintString,
    fee: bigintString,
    role: z.enum(['maker', 'taker']),
    counterparty_trading_account_id: z.string(),
    counterparty: OrderPartySchema.nullable(),
    traded_at: z.number(),
  })
  .transform((v) => ({
    eventDigest: v.event_digest,
    price: v.price,
    baseQuantity: v.base_quantity,
    quoteQuantity: v.quote_quantity,
    /** Fee THIS order paid on the fill, raw quote units. */
    fee: v.fee,
    role: v.role,
    counterpartyTradingAccountId: v.counterparty_trading_account_id,
    counterparty: v.counterparty,
    tradedAt: v.traded_at,
  }))

/**
 * `GET /v1/pools/{pool_id}/orders/{order_id}` — one order with its status,
 * owner, hub, quote currency and fill history. Unlike the open-orders feed
 * this also answers for FILLED and CANCELLED orders, so it is how a bot
 * learns what became of an order that left the book.
 */
export const OrderDetailSchema = z
  .object({
    order_id: z.string(),
    pool_id: z.string(),
    side: z.enum(['buy', 'sell']),
    order_type: openEnum(ORDER_TYPES).nullable(),
    status: openEnum(ORDER_STATUSES),
    price: bigintString,
    quantity: bigintString,
    remaining_quantity: bigintString,
    filled_quantity: bigintString,
    expires_at: z.number(),
    updated_at: z.number(),
    asset_id: z.string(),
    asset_name: z.string().nullable(),
    trading_account: OrderPartySchema,
    hub: OrderHubSchema.nullable(),
    currency: OrderCurrencySchema.nullable(),
    fills: z.array(OrderDetailFillSchema),
  })
  .transform((v) => ({
    /** Order id (Move `u128`) as a decimal string — unique within its pool. */
    orderId: v.order_id,
    poolId: v.pool_id,
    side: v.side,
    /** Null when the indexer has no placement metadata for the order. */
    orderType: v.order_type,
    status: v.status,
    price: v.price,
    /** Original quantity (= remaining + filled). */
    quantity: v.quantity,
    remainingQuantity: v.remaining_quantity,
    filledQuantity: v.filled_quantity,
    /** Epoch ms. */
    expiresAt: v.expires_at,
    updatedAt: v.updated_at,
    assetId: v.asset_id,
    assetName: v.asset_name,
    tradingAccount: v.trading_account,
    /** Null when the hub's location data is unavailable. */
    hub: v.hub,
    /** Null when pool metadata is unavailable. */
    currency: v.currency,
    /** Oldest first; empty for an open order with no fills. */
    fills: v.fills,
  }))

/**
 * `GET /v1/fills/{event_digest}` — one fill event with NO account
 * perspective: both sides' trading accounts and both fees. `assetId` and
 * `storageUnitId` are null until the market's metadata is indexed.
 */
export const FillDetailSchema = z
  .object({
    event_digest: z.string(),
    pool_id: z.string(),
    asset_id: z.string().nullable(),
    storage_unit_id: z.string().nullable(),
    price: bigintString,
    base_quantity: bigintString,
    quote_quantity: bigintString,
    maker_fee: bigintString,
    taker_fee: bigintString,
    taker_is_bid: z.boolean(),
    maker_trading_account_id: z.string(),
    taker_trading_account_id: z.string(),
    filled_at: z.number(),
  })
  .transform((v) => ({
    eventDigest: v.event_digest,
    poolId: v.pool_id,
    assetId: v.asset_id,
    storageUnitId: v.storage_unit_id,
    price: v.price,
    baseQuantity: v.base_quantity,
    quoteQuantity: v.quote_quantity,
    /** Raw quote units. Cycle 7 can charge the maker as well as the taker. */
    makerFee: v.maker_fee,
    takerFee: v.taker_fee,
    takerIsBid: v.taker_is_bid,
    makerTradingAccountId: v.maker_trading_account_id,
    takerTradingAccountId: v.taker_trading_account_id,
    filledAt: v.filled_at,
  }))

// ─── Market-wide feeds & rankings ────────────────────────────────────────────

/**
 * One executed trade on the universe-wide feed (`GET /v1/trades/recent`).
 *
 * UNITS DIFFER from the per-account `Trade`: `price`, `quantity` and
 * `feeAmount` here are HUMAN-READABLE decimal strings, already shifted by
 * `quoteCurrencyDecimals` — not raw integers. They stay strings (decimals do
 * not survive a float); feed them to `toBase(…, quoteCurrencyDecimals)` to
 * get raw units back.
 */
export const RecentTradeSchema = z
  .object({
    price: z.string(),
    quantity: z.string(),
    side: z.enum(['buy', 'sell']),
    order_type: openEnum(ORDER_TYPES).nullable(),
    traded_at: z.number(),
    tx_digest: z.string(),
    fee_rate_bps: z.number(),
    fee_amount: z.string(),
    asset_id: z.string(),
    hub_id: z.string(),
    quote_currency: z.string(),
    quote_currency_decimals: z.number(),
    region_id: z.number().nullable(),
    solar_system_id: z.number().nullable(),
    solar_system_name: z.string().nullable(),
  })
  .transform((v) => ({
    /** Execution price, human-readable quote units per item. */
    price: v.price,
    /** Items exchanged, human-readable. */
    quantity: v.quantity,
    /** The TAKER's side: `buy` when the incoming order was a bid. */
    side: v.side,
    /** The taker order's type; null when its metadata is unavailable. */
    orderType: v.order_type,
    tradedAt: v.traded_at,
    txDigest: v.tx_digest,
    /**
     * The fill's own effective TAKER rate in basis points — derived as
     * `round(taker_fee × 10000 / quote_quantity)`, not read from pool
     * config. In cycle 7 it depends on the pool's fee class and the taker's
     * turnover tier, so two trades on one pool can differ.
     */
    feeRateBps: v.fee_rate_bps,
    /** Total fee on the trade (maker + taker), human-readable quote units. */
    feeAmount: v.fee_amount,
    assetId: v.asset_id,
    hubId: v.hub_id,
    quoteCurrency: v.quote_currency,
    quoteCurrencyDecimals: v.quote_currency_decimals,
    regionId: v.region_id,
    /** Null when the hub has no indexed location. */
    solarSystemId: v.solar_system_id,
    /** Null when unavailable — including names no player has reported yet. */
    solarSystemName: v.solar_system_name,
  }))

export const RecentTradesPageSchema = z
  .object({
    data: z.array(RecentTradeSchema),
    next_cursor: z.string().nullable(),
  })
  .transform((v) => ({
    trades: v.data,
    /**
     * Epoch-ms bound for the next (older) page — pass it back as `before`.
     * Null when this was the last page.
     */
    nextCursor: v.next_cursor,
  }))

/** Known display-price waterfall tiers. */
export const DISPLAY_PRICE_TIERS = [
  'traded',
  'item',
  'book',
  'estimated',
  'unknown',
] as const

/**
 * A display price for an item, optionally at one hub. This is the PLAIN
 * MARKET PRICE — no trading fee is applied (etl-api changed this in cycle 7);
 * a client that shows a fee applies the viewer's own rate for the pool.
 */
export const DisplayPriceSchema = z
  .object({
    item_id: z.string(),
    storage_unit_id: z.string().nullable(),
    collection_id: z.string().nullable(),
    pool_id: z.string().nullable(),
    quote_currency: z.string().nullable(),
    quote_decimals: z.number().nullable(),
    tier: openEnum(DISPLAY_PRICE_TIERS),
    price: z.string().nullable(),
    price_raw: bigintString.nullable(),
    best_bid: z.string().nullable(),
    best_ask: z.string().nullable(),
    fills_here: z.number(),
    fills_this_item: z.number(),
  })
  .transform((v) => ({
    /** The requested item, echoed back. */
    itemId: v.item_id,
    /** The requested hub (pair mode); null in item-only mode. */
    storageUnitId: v.storage_unit_id,
    /** Vault collection; null when no pool matched. */
    collectionId: v.collection_id,
    /** Null in item-only mode or when no pool matched (incl. a fallback). */
    poolId: v.pool_id,
    /**
     * Coin type `price` is in; null when unresolved. Usually CRED but NOT
     * guaranteed — check before treating the price as CRED.
     */
    quoteCurrency: v.quote_currency,
    quoteDecimals: v.quote_decimals,
    /**
     * Where the price came from: `traded` (recent fills at this pool), `item`
     * (vault-independent item price), `book` (resting-book mid),
     * `estimated` (derived from recipe component costs) or `unknown`
     * (no price anywhere — `price` is null).
     */
    tier: v.tier,
    /** Human-readable price (quote units, decimals applied); null = unknown. */
    price: v.price,
    /** Raw integer quote units per item; null = unknown. */
    priceRaw: v.price_raw,
    /** Human-readable best bid / ask; null in item-only mode or one-sided. */
    bestBid: v.best_bid,
    bestAsk: v.best_ask,
    /** Recent fills at THIS pool that fed the `traded` tier. */
    fillsHere: v.fills_here,
    /** Recent fills for the item across all hubs that fed the `item` tier. */
    fillsThisItem: v.fills_this_item,
  }))

export const DisplayPricesSchema = z
  .object({ prices: z.array(DisplayPriceSchema) })
  .transform((v) => v.prices)

/** `GET /v1/hubs/economics` — fee reserve and depth per hub (raw integers). */
export const HubEconomicsSchema = z
  .object({
    hub_id: z.string(),
    fee_reserve: bigintString,
    liquidity_depth: bigintString,
    unique_items: z.number(),
  })
  .transform((v) => ({
    hubId: v.hub_id,
    /** Fees deposited minus withdrawn across the hub's markets (raw quote units). */
    feeReserve: v.fee_reserve,
    /** Total remaining quantity across the hub's open orders (raw). */
    liquidityDepth: v.liquidity_depth,
    /** Distinct item types with open orders at the hub. */
    uniqueItems: v.unique_items,
  }))

/** `GET /v1/pools/top-by-fees` — pools ranked by unclaimed fee balance. */
export const PoolFeesSchema = z
  .object({
    pool_id: z.string(),
    quote_type: z.string(),
    total_deposited: bigintString,
    total_withdrawn: bigintString,
    fees_available_to_claim: bigintString,
  })
  .transform((v) => ({
    poolId: v.pool_id,
    /**
     * Quote coin type AS INDEXED — verified live without the `0x` prefix
     * (`fbcb…::cred::CRED`), unlike the `0x…` form elsewhere. Normalise
     * before comparing against a configured coin type.
     */
    quoteType: v.quote_type,
    totalDeposited: v.total_deposited,
    totalWithdrawn: v.total_withdrawn,
    /** `totalDeposited − totalWithdrawn`, raw quote units. */
    feesAvailableToClaim: v.fees_available_to_claim,
  }))

// ─── Platform statistics (`GET /v1/stats`) ───────────────────────────────────

export const StatsQuoteVolumeSchema = z
  .object({
    quote_type: z.string(),
    symbol: z.string(),
    decimals: z.number(),
    raw: bigintString,
    human: z.string(),
    trades: z.number(),
  })
  .transform((v) => ({
    quoteType: v.quote_type,
    symbol: v.symbol,
    decimals: v.decimals,
    /** Volume in raw quote units. */
    raw: v.raw,
    /** Volume in human-readable quote units (`raw` shifted by `decimals`). */
    human: v.human,
    trades: v.trades,
  }))

export const StatsTopItemSchema = z
  .object({
    asset_id: z.string(),
    trades: z.number(),
    units: bigintString,
    volume_raw: bigintString,
    volume: z.string(),
    quote_symbol: z.string(),
  })
  .transform((v) => ({
    assetId: v.asset_id,
    trades: v.trades,
    /** Items exchanged. */
    units: v.units,
    volumeRaw: v.volume_raw,
    /** Human-readable volume in `quoteSymbol`. */
    volume: v.volume,
    quoteSymbol: v.quote_symbol,
  }))

export const StatsTopOrgSchema = z
  .object({ org_id: z.string(), name: z.string(), member_count: z.number() })
  .transform((v) => ({
    orgId: v.org_id,
    name: v.name,
    memberCount: v.member_count,
  }))

export const PlatformStatsSchema = z
  .object({
    computed_at: z.number(),
    marketplace: z.object({
      trades: z.object({
        all_time: z.number(),
        h24: z.number(),
        d7: z.number(),
      }),
      active_traders: z.object({ all_time: z.number(), d7: z.number() }),
      open_orders: z.number(),
      traders_with_open_orders: z.number(),
      items_with_markets: z.number(),
      trade_hubs: z.number(),
      volume_all_time: z.array(StatsQuoteVolumeSchema),
      volume_d7: z.array(StatsQuoteVolumeSchema),
      top_items_d7: z.array(StatsTopItemSchema),
    }),
    organizations: z.object({
      total: z.number(),
      pilots_in_orgs: z.number(),
      org_units: z.number(),
      largest: z.array(StatsTopOrgSchema),
    }),
    storage: z.object({
      org_vaults: z.number(),
      orgs_with_vaults: z.number(),
      hubs_with_storage: z.number(),
      pilots_with_access: z.number(),
    }),
    pilots: z.object({ total: z.number(), new_d7: z.number() }),
    series: z.object({
      trades_daily_30d: z.array(
        z.object({ day_at: z.number(), trades: z.number() }),
      ),
      new_pilots_daily_30d: z.array(
        z.object({ day_at: z.number(), pilots: z.number() }),
      ),
    }),
  })
  .transform((v) => ({
    /** When the aggregates were computed (cached up to 60 s), epoch ms. */
    computedAt: v.computed_at,
    marketplace: {
      trades: {
        allTime: v.marketplace.trades.all_time,
        h24: v.marketplace.trades.h24,
        d7: v.marketplace.trades.d7,
      },
      activeTraders: {
        allTime: v.marketplace.active_traders.all_time,
        d7: v.marketplace.active_traders.d7,
      },
      openOrders: v.marketplace.open_orders,
      tradersWithOpenOrders: v.marketplace.traders_with_open_orders,
      itemsWithMarkets: v.marketplace.items_with_markets,
      tradeHubs: v.marketplace.trade_hubs,
      /** Per quote currency, largest first. */
      volumeAllTime: v.marketplace.volume_all_time,
      volumeD7: v.marketplace.volume_d7,
      topItemsD7: v.marketplace.top_items_d7,
    },
    organizations: {
      /** Root organizations. */
      total: v.organizations.total,
      pilotsInOrgs: v.organizations.pilots_in_orgs,
      orgUnits: v.organizations.org_units,
      /** Largest organizations by member count. */
      largest: v.organizations.largest,
    },
    storage: {
      orgVaults: v.storage.org_vaults,
      orgsWithVaults: v.storage.orgs_with_vaults,
      hubsWithStorage: v.storage.hubs_with_storage,
      pilotsWithAccess: v.storage.pilots_with_access,
    },
    pilots: { total: v.pilots.total, newD7: v.pilots.new_d7 },
    series: {
      /** Oldest first; `dayAt` is the UTC day start, epoch ms. */
      tradesDaily30d: v.series.trades_daily_30d.map((d) => ({
        dayAt: d.day_at,
        trades: d.trades,
      })),
      newPilotsDaily30d: v.series.new_pilots_daily_30d.map((d) => ({
        dayAt: d.day_at,
        pilots: d.pilots,
      })),
    },
  }))

// ─── Characters & tribes ─────────────────────────────────────────────────────

export const CharacterSchema = z
  .object({
    object_id: z.string(),
    item_id: z.string(),
    tenant: z.string(),
    tribe_id: z.number().nullable(),
    address: z.string(),
    name: z.string(),
    description: z.string(),
    url: z.string(),
    checkpoint_at: z.number(),
    owner_cap_id: z.string().optional(),
    assembly_id: z.string().optional(),
  })
  .transform((v) => ({
    /** Character object id. */
    characterId: v.object_id,
    /** Numeric in-game item id of the character. */
    itemId: v.item_id,
    tenant: v.tenant,
    /** Null when the character has no tribe. */
    tribeId: v.tribe_id,
    /** Wallet that owns the character. */
    address: v.address,
    name: v.name,
    description: v.description,
    /** Portrait URL; empty when none is published. */
    url: v.url,
    /** When the record last changed, epoch ms. */
    checkpointAt: v.checkpoint_at,
    /** Character owner-cap id — only with `enrich: true`, else null. */
    ownerCapId: v.owner_cap_id ?? null,
    /** Character assembly id — only with `enrich: true`, else null. */
    assemblyId: v.assembly_id ?? null,
  }))

/**
 * One row of a batch address → character resolution. Every requested address
 * comes back (echoed in `address`); an address with no character has every
 * other field null.
 */
export const CharacterLookupSchema = z
  .object({
    address: z.string(),
    object_id: z.string().nullable(),
    character_address: z.string().nullable(),
    name: z.string().nullable(),
    tribe_id: z.number().nullable(),
    tribe_name: z.string().nullable(),
  })
  .transform((v) => ({
    /** The queried address, echoed back — map results by this, not order. */
    address: v.address,
    characterId: v.object_id,
    characterAddress: v.character_address,
    name: v.name,
    tribeId: v.tribe_id,
    /** Null when the character has no tribe or its name is unresolved. */
    tribeName: v.tribe_name,
  }))

/** A tribe — a game-world faction, distinct from on-chain organizations. */
export const TribeSchema = z
  .object({
    tribe_id: z.number(),
    name: z.string(),
    name_short: z.string(),
    description: z.string(),
    tax_rate: z.number(),
    tribe_url: z.string(),
  })
  .transform((v) => ({
    tribeId: v.tribe_id,
    name: v.name,
    /** Short name / ticker. */
    nameShort: v.name_short,
    description: v.description,
    taxRate: v.tax_rate,
    tribeUrl: v.tribe_url,
  }))

// ─── World reference data (items, recipes) ───────────────────────────────────
//
// `/v1/world/items` and `/v1/world/recipes` are static JSON on the public CDN
// and are camelCase on the wire with numeric ids. The SDK keys items by
// `assetId` STRINGS everywhere else (order books, balances, search), so the
// ids are converted here — `assetId` from this list joins straight onto every
// other read.

/** One item from the curated world item list. */
export const WorldItemSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    description: z.string().optional(),
    mass: z.number().optional(),
    radius: z.number().optional(),
    volume: z.number().optional(),
    portionSize: z.number().optional(),
    groupId: z.number(),
    groupName: z.string(),
    categoryId: z.number(),
    categoryName: z.string(),
    iconUrl: z.string().optional(),
  })
  .transform((v) => ({
    /** Item type id as a string (the wire's numeric `id`). */
    assetId: String(v.id),
    name: v.name,
    description: v.description ?? '',
    /** Kilograms; null when the list omits it. */
    mass: v.mass ?? null,
    /** Metres. */
    radius: v.radius ?? null,
    /** Cubic metres. */
    volume: v.volume ?? null,
    /** Units produced/consumed per action. */
    portionSize: v.portionSize ?? null,
    groupId: v.groupId,
    groupName: v.groupName,
    categoryId: v.categoryId,
    /** e.g. `Commodity`, `Module`, `Asteroid`. */
    categoryName: v.categoryName,
    /** Icon on the public CDN; null when none is published (wire `""`). */
    iconUrl: v.iconUrl ? v.iconUrl : null,
  }))

/** `GET /v1/world/items/{asset_id}` — display name and group for one item. */
export const ItemInfoSchema = z
  .object({
    asset_id: z.string(),
    name: z.string().nullable(),
    symbol: z.string().nullable(),
  })
  .transform((v) => ({
    assetId: v.asset_id,
    name: v.name,
    /** The item's GROUP name (e.g. `Raw Materials`); null when ungrouped. */
    symbol: v.symbol,
  }))

export const RecipeMaterialSchema = z
  .object({
    id: z.number(),
    name: z.string().optional(),
    quantity: z.number(),
  })
  .transform((v) => ({
    assetId: String(v.id),
    name: v.name ?? null,
    /** Units consumed per run. */
    quantity: v.quantity,
  }))

/** One crafting recipe: a production run of a product item. */
export const RecipeSchema = z
  .object({
    productId: z.number(),
    productName: z.string(),
    outputQuantity: z.number(),
    time: z.number(),
    materials: z.array(RecipeMaterialSchema),
  })
  .transform((v) => ({
    /** The crafted item's type id, as a string (joins to `assetId`). */
    productAssetId: String(v.productId),
    productName: v.productName,
    /** Units produced per run. */
    outputQuantity: v.outputQuantity,
    /** Craft time in seconds; null when unknown (wire `-1`). */
    craftTimeSeconds: v.time < 0 ? null : v.time,
    /** Bill of materials per run. */
    materials: v.materials,
  }))

// ─── Routing (location-api) ──────────────────────────────────────────────────
//
// Unlike the spatial reads, routing distances are JSON NUMBERS (doubles) in
// light years — they are path lengths, not coordinates, so the precision of
// a double is plenty.

/** Known route modes as the RESPONSE names them (requests use fuel/time). */
export const ROUTE_OPTIMIZATIONS = [
  'fuel_efficient',
  'fastest',
  'balanced',
] as const
/** Known hop kinds. */
export const JUMP_TYPES = ['start', 'stargate', 'jump_drive'] as const

export const WaypointSchema = z
  .object({
    solar_system_id: z.number(),
    solar_system_name: z.string().nullish(),
    jump_type: openEnum(JUMP_TYPES),
    distance_ly: z.number().nullish(),
  })
  .transform((v) => ({
    solarSystemId: v.solar_system_id,
    /** Null for systems no player has reported a name for yet. */
    solarSystemName: v.solar_system_name ?? null,
    /** `start` on the first waypoint, then `stargate` or `jump_drive`. */
    jumpType: v.jump_type,
    /** Hop length in ly — `jump_drive` hops only; null otherwise. */
    distanceLy: v.distance_ly ?? null,
  }))

export const RouteSchema = z
  .object({
    optimization: openEnum(ROUTE_OPTIMIZATIONS),
    total_cost: z.object({
      drive_distance_ly: z.number(),
      total_distance_ly: z.number(),
      gate_jumps: z.number(),
      drive_jumps: z.number(),
      total_jumps: z.number(),
    }),
    waypoints: z.array(WaypointSchema),
  })
  .transform((v) => ({
    /** The mode the search actually used (`fuel_efficient`, `fastest`, `balanced`). */
    optimization: v.optimization,
    /** Hop count a player sees (= gateJumps + driveJumps). */
    totalJumps: v.total_cost.total_jumps,
    gateJumps: v.total_cost.gate_jumps,
    driveJumps: v.total_cost.drive_jumps,
    /** Whole path, light years. */
    totalDistanceLy: v.total_cost.total_distance_ly,
    /** Jump-drive portion only, light years. */
    driveDistanceLy: v.total_cost.drive_distance_ly,
    /** Origin first, destination last. */
    waypoints: v.waypoints,
  }))

export const RouteComparisonSchema = z
  .object({
    fuel_efficient: RouteSchema,
    fastest: RouteSchema,
    balanced: RouteSchema,
  })
  .transform((v) => ({
    /** Minimises fuel (prefers stargates). */
    fuelEfficient: v.fuel_efficient,
    /** Minimises travel time (prefers jump drives). */
    fastest: v.fastest,
    /** Interpolates between the two by `gateWeight`. */
    balanced: v.balanced,
  }))

export const RoutingStatsSchema = z
  .object({
    connected_systems: z.number(),
    stargate_edges: z.number(),
    jump_drive_edges: z.number(),
    max_jump_range_ly: z.number(),
  })
  .transform((v) => ({
    /** Systems reachable over the stargate network. */
    connectedSystems: v.connected_systems,
    /** Stargate links, counted once per bidirectional pair. */
    stargateEdges: v.stargate_edges,
    /** Jump-drive edges within the default maximum range. */
    jumpDriveEdges: v.jump_drive_edges,
    /** The range the default jump-drive graph was built with, ly. */
    maxJumpRangeLy: v.max_jump_range_ly,
  }))

// ─── Parse helper ────────────────────────────────────────────────────────────

/**
 * Validate an indexer payload, wrapping zod failures as a typed SDK error so
 * callers never see a raw ZodError.
 */
export function parseWith<Schema extends z.ZodType>(
  schema: Schema,
  data: unknown,
  what: string,
): z.output<Schema> {
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

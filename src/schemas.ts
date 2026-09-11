import { z } from 'zod'
import { TriexClientError, TriexError } from './errors'

/**
 * Zod schemas for indexer (etl-api) responses, pinned against the committed
 * upstream spec (`dynamic-config-registry/upstream-specs/etl-api.json`,
 * refreshed 2026-08-21) — resolves RQ-1.
 *
 * Each schema validates the snake_case wire shape and TRANSFORMS it into the
 * SDK's camelCase domain shape; the domain types in `types.ts` are inferred
 * from these schemas (single source of truth).
 *
 * Conventions (per the spec): raw on-chain integers (prices, quantities,
 * amounts) arrive as decimal strings → `bigint`. Timestamps are epoch-ms
 * integers → `number`, except order-book expiries which can be MAX_U64 for
 * good-til-cancelled → `bigint`.
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

// ─── Discovery (#6) ──────────────────────────────────────────────────────────

export const DiscoveryOrderSchema = z
  .object({
    pool_id: z.string(),
    order_id: z.string(),
    price: bigintString,
    is_bid: z.boolean(),
    balance_manager_id: z.string(),
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
    balanceManagerId: v.balance_manager_id,
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
    /** Raw taker fee rate scaled by 1e9 (20_000_000 = 2%); 0n when unknown. */
    feeRateScaled: v.fee === null ? 0n : BigInt(v.fee),
    /** Decimal form of the fee (fee / 1e9), for display. */
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

export const BalanceManagerOwnerSchema = z
  .object({
    balance_manager_id: z.string(),
    owner: z.string().nullable(),
    owner_name: z.string().nullable(),
    root_ou_id: z.string().nullable(),
  })
  .transform((v) => ({
    balanceManagerId: v.balance_manager_id,
    /**
     * TAGGED, not a bare address: `player:<wallet>` for a character-owned
     * balance manager, `ou:<org_id>` for an organization-owned one. Null when
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

export const SolarSystemSchema = z
  .object({
    solar_system_id: z.number(),
    solar_system_name: z.string(),
    location: CoordinatesSchema,
    constellation_id: z.number().nullish(),
    region_id: z.number().nullish(),
  })
  .transform((v) => ({
    solarSystemId: v.solar_system_id,
    solarSystemName: v.solar_system_name,
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
    solar_system_name: z.string(),
    radius_ly: z.string(),
    count: z.number(),
    systems: z.array(NearbySystemSchema),
  })
  .transform((v) => ({
    /** The system searched from; it is excluded from `systems`. */
    originSolarSystemId: v.solar_system_id,
    originSolarSystemName: v.solar_system_name,
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
  .object({ total_systems: z.number(), status: z.string() })
  .transform((v) => ({
    totalSystems: v.total_systems,
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
    /** Balance-manager-held balances for `balanceManagerId`. */
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
    counterparty_balance_manager_id: z.string(),
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
    counterpartyBalanceManagerId: v.counterparty_balance_manager_id,
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
    counterparty_balance_manager_id: z.string(),
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
    counterpartyBalanceManagerId: v.counterparty_balance_manager_id,
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
    /** Claimable into the balance manager. */
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
    storage_unit_id: z.string(),
    vault_config_id: z.string(),
  })
  .transform((v) => ({
    collectionId: v.collection_id,
    assetId: v.asset_id,
    amount: v.amount,
    storageUnitId: v.storage_unit_id,
    vaultConfigId: v.vault_config_id,
  }))

/**
 * `GET /v1/balance-managers/{bm}/sweepable` — everything claimable /
 * withdrawable: per-pool settled (post-fill) proceeds and idle item balances
 * already sitting in the balance manager. Note: BM-resident CRED is
 * deliberately NOT in this manifest — read it via `balances.currency()`.
 */
export const SweepableSchema = z
  .object({
    balance_manager_id: z.string(),
    as_of_checkpoint: z.string().nullable(),
    pools: z.array(SweepablePoolSchema),
    items: z.array(SweepableItemSchema),
  })
  .transform((v) => ({
    balanceManagerId: v.balance_manager_id,
    asOfCheckpoint: v.as_of_checkpoint,
    pools: v.pools,
    items: v.items,
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

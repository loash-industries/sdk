import { z } from 'zod'
import { OrgQueries } from './armature/queries'
import { TriexClientError, TriexError } from './errors'
import { indexerGet } from './http'
import type { QueryParams } from './http'
import {
  AssemblyEnrichedSchema,
  AssemblyOwnerSchema,
  AutocompleteSystemsSchema,
  TradingAccountOwnerSchema,
  BatchSystemsSchema,
  CoordinateSearchSchema,
  CollectionHubSchema,
  DiscoveryResultSchema,
  FillsPageSchema,
  HubEnrichedSchema,
  HubItemOrderbookSchema,
  HubItemsPageSchema,
  ItemSearchPageSchema,
  HubLocationPageSchema,
  HubLocationSchema,
  HubVaultSchema,
  InventoryBalancesSchema,
  NearbyHubSchema,
  NearbySystemsSchema,
  OpenOrdersPageSchema,
  OrderbookSchema,
  PoolMetadataSchema,
  PoolResolveSchema,
  SolarSystemNameSchema,
  SolarSystemSchema,
  SpatialStatsSchema,
  SweepableSchema,
  TradesPageSchema,
  CharacterLookupSchema,
  CharacterSchema,
  DisplayPricesSchema,
  FillDetailSchema,
  HubEconomicsSchema,
  ItemInfoSchema,
  OrderDetailSchema,
  PlatformStatsSchema,
  PoolFeesSchema,
  RecentTradesPageSchema,
  RecipeSchema,
  RouteComparisonSchema,
  RouteSchema,
  RoutingStatsSchema,
  TribeSchema,
  WorldItemSchema,
  parseWith,
} from './schemas'
import type {
  AssemblyEnriched,
  AssemblyOwner,
  AutocompleteSystems,
  TradingAccountOwner,
  BatchSystems,
  BatchSystemsParams,
  CoordinateSearch,
  CoordinateSearchParams,
  BalancesAtHubParams,
  CollectionHub,
  DiscoveryFilters,
  DiscoveryResult,
  FillsPage,
  FillsParams,
  HistoryPageParams,
  HubEnriched,
  HubItemMarket,
  HubItemsPage,
  ItemSearchPage,
  HubLocation,
  HubLocationFilters,
  HubLocationPage,
  HubVaultInfo,
  InventoryBalances,
  LocationPageParams,
  NearbyHub,
  NearbyHubsParams,
  NearbyHubsBySystemParams,
  NearbySystems,
  NearbySystemsParams,
  OpenOrdersPage,
  Orderbook,
  PoolMetadata,
  SolarSystem,
  SolarSystemName,
  SpatialStats,
  Sweepable,
  TradesPage,
  TradesParams,
  Character,
  CharacterLookup,
  DisplayPrice,
  DisplayPriceParams,
  DisplayPricesParams,
  FillDetail,
  HubEconomics,
  ItemInfo,
  OrderDetail,
  OrderLookupParams,
  PlatformStats,
  PoolFees,
  RecentTradesPage,
  RecentTradesParams,
  Recipe,
  Route,
  RouteComparison,
  RouteParams,
  RouteShipParams,
  RoutingStats,
  Tribe,
  WorldItem,
} from './types'

const MAX_U128 = (1n << 128n) - 1n

/**
 * Normalise an order id (Move `u128`) to the decimal string the gateway takes
 * in a path. Accepts a bigint or a decimal / `0x`-hex string; anything else —
 * including a JS number, which cannot hold a u128 — is a `ValidationFailed`
 * before any request is spent.
 */
function u128Decimal(id: bigint | string): string {
  const text = typeof id === 'string' ? id.trim() : null
  const value =
    typeof id === 'bigint'
      ? id
      : text !== null && /^(\d+|0x[0-9a-fA-F]+)$/.test(text)
        ? BigInt(text)
        : -1n
  if (value < 0n || value > MAX_U128) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      `Invalid order id ${String(id)}: expected a u128 integer (decimal string or bigint).`,
    )
  }
  return value.toString()
}

/**
 * Thin HTTP client for the Trinary Exchange indexer (etl-api behind the sluice
 * gateway). All reads go through here; auth is the `x-api-key` header.
 *
 * Endpoints and shapes are pinned against the published gateway surface
 * (RQ-1 resolved — see schemas.ts). Hub-scoped book reads go through
 * `hubItemOrderbook()` (one call, pool + metadata resolved server-side);
 * `resolvePool` remains for callers that already hold a `collection_id`.
 */
export class IndexerClient {
  /**
   * Armature (organizations & governance) reads. Kept in its own module so the
   * trading surface stays readable; shares this client's base URL + API key.
   */
  readonly orgs: OrgQueries

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.orgs = new OrgQueries(baseUrl, apiKey)
  }

  /**
   * GET `path` (+ optional query) and return parsed JSON. Delegates to the
   * shared `indexerGet` so the trading and Armature read surfaces map HTTP
   * failures onto `TriexError` codes identically.
   */
  private get<T = unknown>(
    path: string,
    query?: QueryParams,
    notFound?: TriexError,
  ): Promise<T> {
    return indexerGet<T>(this.baseUrl, this.apiKey, path, query, notFound)
  }

  // ─── Discovery / market data ──────────────────────────────────────────────

  /** #6 — open orders across the universe, most-recent activity first. 150 CU. */
  async discovery(filters?: DiscoveryFilters): Promise<DiscoveryResult> {
    const data = await this.get('/v1/discovery', {
      storage_unit_ids: filters?.storageUnitIds?.join(','),
      asset_id: filters?.assetId,
      trading_account_id: filters?.tradingAccountId,
      side: filters?.side,
      public_only: filters?.publicOnly,
      cursor: filters?.cursor,
      limit: filters?.limit,
    })
    return parseWith(DiscoveryResultSchema, data, 'discovery')
  }

  /**
   * #9a — resolve a pool from its vault collection + item. Returns null when
   * no pool exists (creating one is permissionless but out of SDK scope).
   * 30 CU.
   */
  async resolvePool(params: {
    collectionId: string
    assetId: string
    quoteType?: string
  }): Promise<string | null> {
    const data = await this.get('/v1/pools/resolve', {
      collection_id: params.collectionId,
      asset_id: params.assetId,
      quote_type: params.quoteType,
    })
    return parseWith(PoolResolveSchema, data, 'resolvePool').poolId
  }

  /**
   * #9 — one-call order book for an item at a trade hub: the gateway resolves
   * the vault collection and pool server-side and returns the resting book
   * with the pool metadata embedded. `poolId` is null (empty book, null
   * metadata) when the hub trades but no market exists for the item yet.
   * 404s (`HubNotFound`) when the hub has no trading vault. 50 CU.
   */
  async hubItemOrderbook(params: {
    hubId: string
    assetId: string
    quoteType?: string
  }): Promise<HubItemMarket> {
    const data = await this.get(
      `/v1/hubs/${encodeURIComponent(params.hubId)}/items/${encodeURIComponent(params.assetId)}/orderbook`,
      { quote_type: params.quoteType },
      TriexError.HubNotFound,
    )
    return parseWith(HubItemOrderbookSchema, data, 'hubItemOrderbook')
  }

  /** #9b — resting orders for a pool (bids high-first, asks low-first). 30 CU. */
  async orderbook(poolId: string): Promise<Orderbook> {
    const data = await this.get(
      `/v1/pools/${encodeURIComponent(poolId)}/orderbook`,
      undefined,
      TriexError.PoolNotFound,
    )
    return { poolId, ...parseWith(OrderbookSchema, data, 'orderbook') }
  }

  /**
   * #10/#11 — pool metadata (decimals, fee rate, hub linkage). The fee is the
   * pool's fee-class ENTRY tier — an upper bound on any taker's rate (see
   * `PoolMetadata.feeRateScaled`). 20 CU.
   */
  async poolMetadata(poolId: string): Promise<PoolMetadata> {
    const data = await this.get(
      `/v1/pools/${encodeURIComponent(poolId)}/metadata`,
      undefined,
      TriexError.PoolNotFound,
    )
    return parseWith(PoolMetadataSchema, data, 'poolMetadata')
  }

  // ─── Hubs ─────────────────────────────────────────────────────────────────

  /**
   * Vault descriptor for a trade hub — `collectionId` (pool resolution + §6.1)
   * and `vaultConfigId` (item deposit/withdraw PTBs). 20 CU.
   */
  async hubVault(hubId: string): Promise<HubVaultInfo> {
    const data = await this.get(
      `/v1/hubs/${encodeURIComponent(hubId)}/vault`,
      undefined,
      TriexError.HubNotFound,
    )
    return parseWith(HubVaultSchema, data, 'hubVault')
  }

  /**
   * #7 — indexed location / ownership / visibility for a trade hub. Returns
   * null for hubs whose location is not revealed/indexed — etl-api 404s those
   * semantically (verified live: "No location found for assembly …"), and most
   * hubs are private. 20 CU.
   */
  async hubLocation(hubId: string): Promise<HubLocation | null> {
    try {
      const data = await this.get(
        `/v1/hubs/${encodeURIComponent(hubId)}/location`,
        undefined,
        TriexError.HubNotFound,
      )
      return parseWith(HubLocationSchema, data, 'hubLocation')
    } catch (e) {
      if (e instanceof TriexClientError && e.status === 404) return null
      throw e
    }
  }

  /**
   * Every indexed hub location, cursor-paged. The counterpart to
   * `hubLocation()`: that answers "where is this hub", this answers "which
   * hubs are there". Filters narrow by solar system, tenant, or whether the
   * hub has trading initialised at all. 50 CU per page; `iterateHubLocations`
   * walks every page.
   */
  async hubLocations(filters?: HubLocationFilters): Promise<HubLocationPage> {
    const data = await this.get('/v1/hubs/locations', {
      limit: filters?.limit,
      cursor: filters?.cursor,
      solar_system: filters?.solarSystemId,
      tenant: filters?.tenant,
      has_vault: filters?.hasVault,
    })
    return parseWith(HubLocationPageSchema, data, 'hubLocations')
  }

  /**
   * Hub locations currently offering an item for sale, cursor-paged — the
   * "where can I buy this" read. `assetId` is the item's numeric type id.
   * 50 CU per page; `iterateItemLocations` walks every page.
   */
  async itemLocations(
    assetId: string,
    params?: LocationPageParams,
  ): Promise<HubLocationPage> {
    const data = await this.get(
      `/v1/items/${encodeURIComponent(assetId)}/locations`,
      { limit: params?.limit, cursor: params?.cursor },
    )
    return parseWith(HubLocationPageSchema, data, 'itemLocations')
  }

  /**
   * Hubs within a light-year radius of another hub, optionally restricted to
   * hubs with open orders for one item. The gateway does NOT sort by distance
   * (verified live) — sort on `distanceLy` if order matters.
   *
   * Requires the origin hub to publish a location — a private hub 404s
   * (`HubNotFound`); `nearbyHubsBySystem()` is the way in for those. 50 CU.
   */
  async nearbyHubs(params: NearbyHubsParams): Promise<NearbyHub[]> {
    const data = await this.get(
      `/v1/hubs/${encodeURIComponent(params.hubId)}/nearby`,
      { range: params.rangeLy, type_id: params.assetId },
      TriexError.HubNotFound,
    )
    return parseWith(z.array(NearbyHubSchema), data, 'nearbyHubs')
  }

  /**
   * Same search as `nearbyHubs()`, centred on a solar system id or name.
   *
   * etl-api answers `null` (rather than `[]`) when a name can't be resolved —
   * unknown, or (cycle 7) not yet reported by any player — and that is
   * surfaced as `SolarSystemNotFound`, so `[]` always means "no hubs in
   * range". Prefer a numeric id: an id always resolves, a name only once a
   * player has reported it. 50 CU.
   */
  async nearbyHubsBySystem(
    params: NearbyHubsBySystemParams,
  ): Promise<NearbyHub[]> {
    const data = await this.get('/v1/hubs/nearby-by-system', {
      system_id: params.solarSystem,
      range: params.rangeLy,
      type_id: params.assetId,
    })
    const hubs = parseWith(
      z.array(NearbyHubSchema).nullable(),
      data,
      'nearbyHubsBySystem',
    )
    if (hubs === null) {
      throw new TriexClientError(
        TriexError.SolarSystemNotFound,
        `Could not resolve solar system "${params.solarSystem}" — pass a numeric solar system id.`,
      )
    }
    return hubs
  }

  /**
   * Location, market count, and last storage activity for up to 200 hubs in
   * one call — the batch form of `hubLocation()`, for scanning a watchlist.
   * Unlike the single-hub read this one does NOT resolve `solarSystemName`.
   * 50 CU.
   */
  async hubsEnriched(hubIds: string[]): Promise<HubEnriched[]> {
    if (hubIds.length === 0) return []
    const data = await this.get('/v1/hubs/enriched', { ids: hubIds.join(',') })
    return parseWith(z.array(HubEnrichedSchema), data, 'hubsEnriched')
  }

  /** #8 — items with open orders at a trade hub (one page, cached 30 s). 20 CU. */
  async hubItems(hubId: string): Promise<HubItemsPage> {
    const data = await this.get(
      `/v1/hubs/${encodeURIComponent(hubId)}/items`,
      undefined,
      TriexError.HubNotFound,
    )
    return parseWith(HubItemsPageSchema, data, 'hubItems')
  }

  /** #8a — search item types by partial name or exact numeric ID. 50 CU. */
  async searchItems(query: string, limit?: number): Promise<ItemSearchPage> {
    const data = await this.get('/v1/world/items/search', { q: query, limit })
    return parseWith(ItemSearchPageSchema, data, 'searchItems')
  }

  /** #7 — reverse lookup: vault collection → its trade hub. 20 CU. */
  async collectionHub(collectionId: string): Promise<CollectionHub> {
    const data = await this.get(
      `/v1/collections/${encodeURIComponent(collectionId)}/hub`,
      undefined,
      TriexError.HubNotFound,
    )
    return parseWith(CollectionHubSchema, data, 'collectionHub')
  }

  // ─── Locations: batch on-chain resolution (max 200 ids each) ──────────────

  /**
   * Owner wallet for each assembly object id — the on-chain lookup behind
   * "whose structure is this". Cached upstream for five minutes. 50 CU.
   */
  async assemblyOwners(assemblyIds: string[]): Promise<AssemblyOwner[]> {
    if (assemblyIds.length === 0) return []
    const data = await this.get('/v1/assemblies/owners', {
      ids: assemblyIds.join(','),
    })
    return parseWith(z.array(AssemblyOwnerSchema), data, 'assemblyOwners')
  }

  /** `assemblyOwners()` plus the owner's character and the assembly's name. 50 CU. */
  async assembliesEnriched(assemblyIds: string[]): Promise<AssemblyEnriched[]> {
    if (assemblyIds.length === 0) return []
    const data = await this.get('/v1/assemblies/enriched', {
      ids: assemblyIds.join(','),
    })
    return parseWith(
      z.array(AssemblyEnrichedSchema),
      data,
      'assembliesEnriched',
    )
  }

  /**
   * Owner for each trading account id, tagged `player:<wallet>` or
   * `ou:<org_id>` — how a counterparty on the book is put to a name. 50 CU.
   */
  async tradingAccountOwners(
    tradingAccountIds: string[],
  ): Promise<TradingAccountOwner[]> {
    if (tradingAccountIds.length === 0) return []
    const data = await this.get('/v1/trading-accounts/owners', {
      ids: tradingAccountIds.join(','),
    })
    return parseWith(
      z.array(TradingAccountOwnerSchema),
      data,
      'tradingAccountOwners',
    )
  }

  /**
   * Display names for numeric solar system ids. The paged location reads
   * resolve their own names; `hubsEnriched()` does not, so this is how that
   * result set gets human-readable. A name is null until a player has
   * reported it (cycle 7). 50 CU.
   */
  async solarSystemNames(solarSystemIds: number[]): Promise<SolarSystemName[]> {
    if (solarSystemIds.length === 0) return []
    const data = await this.get('/v1/solar-systems/names', {
      ids: solarSystemIds.join(','),
    })
    return parseWith(z.array(SolarSystemNameSchema), data, 'solarSystemNames')
  }

  // ─── Spatial: the star map ────────────────────────────────────────────────

  /**
   * One solar system by name or numeric id. The gateway treats the segment as
   * an id when it parses as an integer and as a case-insensitive name
   * otherwise, so `"EHK-KH7"` and `"30000142"` both work — but since cycle 7
   * a NAME resolves only once a player has reported it; an id always does.
   * 20 CU.
   */
  async solarSystem(solarSystem: string): Promise<SolarSystem> {
    const data = await this.get(
      `/v1/spatial/systems/${encodeURIComponent(solarSystem)}`,
      undefined,
      TriexError.SolarSystemNotFound,
    )
    return parseWith(SolarSystemSchema, data, 'solarSystem')
  }

  /**
   * Up to 100 solar systems in one call, by id or by name. Unmatched
   * identifiers are omitted from `systems` rather than returned as nulls —
   * including names no player has reported yet. 50 CU.
   */
  async solarSystems(params: BatchSystemsParams): Promise<BatchSystems> {
    const byId = params.solarSystemIds?.length ? 1 : 0
    const byName = params.solarSystemNames?.length ? 1 : 0
    if (byId + byName !== 1) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Batch system lookup takes exactly one of solarSystemIds or solarSystemNames.',
      )
    }
    const data = await this.get('/v1/spatial/systems', {
      solar_system_ids: params.solarSystemIds?.join(','),
      solar_system_names: params.solarSystemNames?.join(','),
    })
    return parseWith(BatchSystemsSchema, data, 'solarSystems')
  }

  /**
   * Solar systems within `radiusLy` of another system, nearest first. The
   * origin system itself is excluded. 50 CU.
   */
  async nearbySystems(params: NearbySystemsParams): Promise<NearbySystems> {
    const data = await this.get(
      `/v1/spatial/systems/${encodeURIComponent(params.solarSystem)}/nearby`,
      { radius_ly: params.radiusLy, limit: params.limit },
      TriexError.SolarSystemNotFound,
    )
    return parseWith(NearbySystemsSchema, data, 'nearbySystems')
  }

  /** Solar systems within `radiusLy` of a point in space, nearest first. 50 CU. */
  async systemsNearCoordinates(
    params: CoordinateSearchParams,
  ): Promise<CoordinateSearch> {
    const data = await this.get('/v1/spatial/coordinates/nearby', {
      x: params.x,
      y: params.y,
      z: params.z,
      radius_ly: params.radiusLy,
      limit: params.limit,
    })
    return parseWith(CoordinateSearchSchema, data, 'systemsNearCoordinates')
  }

  /**
   * Solar systems whose name starts with `query`, alphabetically. Served from
   * an in-memory prefix index and returning only identifiers, so it is much
   * cheaper than the full lookup — resolve the chosen suggestion with
   * `solarSystem()`. Only player-reported names are indexed (cycle 7), so
   * coverage grows as the map is discovered. 20 CU.
   */
  async autocompleteSystems(
    query: string,
    limit?: number,
  ): Promise<AutocompleteSystems> {
    const data = await this.get('/v1/spatial/systems/search/autocomplete', {
      q: query,
      limit,
    })
    return parseWith(AutocompleteSystemsSchema, data, 'autocompleteSystems')
  }

  /**
   * Coverage of the loaded star map — how many systems are queryable, and
   * how many have a reported (name-resolvable) name. 20 CU.
   */
  async spatialStats(): Promise<SpatialStats> {
    const data = await this.get('/v1/spatial/stats')
    return parseWith(SpatialStatsSchema, data, 'spatialStats')
  }

  // ─── Inventory (#2 — items only; CRED reads live on the fullnode) ─────────

  /**
   * Hub-scoped item balances. Sections come back empty unless their selecting
   * parameter is passed: `address` → warehouse, `tradingAccountId` →
   * marketplace, `inventoryKey` → hangar, `vaultIds` → orgVaults. 50 CU.
   */
  async inventoryBalances(
    params: BalancesAtHubParams & { tradingAccountId?: string },
  ): Promise<InventoryBalances> {
    const data = await this.get(
      '/v1/inventory/balances',
      {
        storage_unit_id: params.storageUnitId,
        owner_address: params.address,
        trading_account_id: params.tradingAccountId,
        inventory_key: params.inventoryKey,
        vault_ids: params.vaultIds?.join(','),
      },
      TriexError.HubNotFound,
    )
    return parseWith(InventoryBalancesSchema, data, 'inventoryBalances')
  }

  // ─── Order status (#14) ───────────────────────────────────────────────────

  /**
   * Orders the account has resting, newest activity first. Page backward by
   * passing `nextCursor` back as `before` (an epoch-ms bound). 30 CU.
   */
  async openOrders(
    tradingAccountId: string,
    params?: HistoryPageParams,
  ): Promise<OpenOrdersPage> {
    const data = await this.get(
      `/v1/trading-accounts/${encodeURIComponent(tradingAccountId)}/open-orders`,
      { before: params?.before, after: params?.after, limit: params?.limit },
      TriexError.TradingAccountNotFound,
    )
    return parseWith(OpenOrdersPageSchema, data, 'openOrders')
  }

  /**
   * The account's fills, newest first, from its own perspective (its order,
   * its role, the fee IT paid). Page with `nextCursor` as `before`. 30 CU.
   */
  async fills(
    tradingAccountId: string,
    params?: FillsParams,
  ): Promise<FillsPage> {
    const data = await this.get(
      `/v1/trading-accounts/${encodeURIComponent(tradingAccountId)}/fills`,
      {
        before: params?.before,
        after: params?.after,
        limit: params?.limit,
        pool_id: params?.poolId,
        side: params?.side,
      },
      TriexError.TradingAccountNotFound,
    )
    return parseWith(FillsPageSchema, data, 'fills')
  }

  /**
   * Everything claimable / withdrawable for a trading account: per-pool
   * settled proceeds + idle BM item balances. (BM-resident CRED is deliberately
   * not in this manifest — read it via `balances.currency()`.) 30 CU.
   */
  async sweepable(tradingAccountId: string): Promise<Sweepable> {
    const data = await this.get(
      `/v1/trading-accounts/${encodeURIComponent(tradingAccountId)}/sweepable`,
      undefined,
      TriexError.TradingAccountNotFound,
    )
    return parseWith(SweepableSchema, data, 'sweepable')
  }

  /**
   * The account's trades, newest first, with its side and the item/hub.
   * Page with `nextCursor` as `before`. 30 CU.
   */
  async trades(
    tradingAccountId: string,
    params?: TradesParams,
  ): Promise<TradesPage> {
    const data = await this.get(
      `/v1/trading-accounts/${encodeURIComponent(tradingAccountId)}/trades`,
      {
        before: params?.before,
        after: params?.after,
        limit: params?.limit,
        side: params?.side,
        asset_id: params?.assetId,
      },
      TriexError.TradingAccountNotFound,
    )
    return parseWith(TradesPageSchema, data, 'trades')
  }

  // ─── Orders & fills: point lookups ────────────────────────────────────────

  /**
   * One order on one pool — status (`open` / `filled` / `cancelled`),
   * quantities, owner, hub, quote currency and fill history. Answers for
   * orders that have LEFT the book too, which the open-orders feed cannot.
   * 30 CU.
   * @throws `OrderNotFound` when the pool has no such order;
   *   `ValidationFailed` for an order id that is not a u128.
   */
  async poolOrder(params: OrderLookupParams): Promise<OrderDetail> {
    const orderId = u128Decimal(params.orderId)
    const data = await this.get(
      `/v1/pools/${encodeURIComponent(params.poolId)}/orders/${encodeURIComponent(orderId)}`,
      undefined,
      TriexError.OrderNotFound,
    )
    return parseWith(OrderDetailSchema, data, 'poolOrder')
  }

  /**
   * One fill by event digest (transaction digest + event index, as the
   * `eventDigest` on fills and trades), with both sides' accounts and fees.
   * 30 CU.
   * @throws `FillNotFound` for an unknown digest.
   */
  async fill(eventDigest: string): Promise<FillDetail> {
    const data = await this.get(
      `/v1/fills/${encodeURIComponent(eventDigest)}`,
      undefined,
      TriexError.FillNotFound,
    )
    return parseWith(FillDetailSchema, data, 'fill')
  }

  // ─── Market-wide feeds, prices & rankings ─────────────────────────────────

  /**
   * The latest trades across every item market, newest first. Page backward
   * by passing `nextCursor` back as `before` (or use `iterateRecentTrades`);
   * poll with `after`. The gateway returns at most 50 rows per page whatever
   * `limit` says. Prices here are HUMAN-READABLE decimals — see
   * `RecentTrade`. 50 CU.
   */
  async recentTrades(params?: RecentTradesParams): Promise<RecentTradesPage> {
    const data = await this.get('/v1/trades/recent', {
      before: params?.before,
      after: params?.after,
      limit: params?.limit,
      public_only: params?.publicOnly,
      item_id: params?.assetId,
    })
    return parseWith(RecentTradesPageSchema, data, 'recentTrades')
  }

  /**
   * Display prices for up to 100 items, optionally per hub. The PLAIN market
   * price — no trading fee applied. One entry per requested item (or pair),
   * in request order. 50 CU.
   * @throws `ValidationFailed` over 100 items, or when `storageUnitIds` is
   *   neither one id nor one per item.
   */
  async displayPrices(params: DisplayPricesParams): Promise<DisplayPrice[]> {
    if (params.itemIds.length === 0) return []
    if (params.itemIds.length > 100) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `At most 100 item ids per display-price batch; got ${params.itemIds.length}.`,
      )
    }
    const hubs = params.storageUnitIds ?? []
    if (hubs.length > 1 && hubs.length !== params.itemIds.length) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `storageUnitIds must hold one id or one per item (${params.itemIds.length}); got ${hubs.length}.`,
      )
    }
    const data = await this.get('/v1/display-prices', {
      item_ids: params.itemIds.join(','),
      storage_unit_ids: hubs.length ? hubs.join(',') : undefined,
      fallback: params.fallback === false ? 'false' : undefined,
    })
    return parseWith(DisplayPricesSchema, data, 'displayPrices')
  }

  /**
   * Display price for one item — at a hub when `storageUnitId` is given
   * (per-hub waterfall), otherwise the vault-independent item price. No fee
   * applied. 20 CU.
   */
  async displayPrice(
    itemId: string,
    params?: DisplayPriceParams,
  ): Promise<DisplayPrice> {
    const data = await this.get(
      `/v1/display-prices/${encodeURIComponent(itemId)}`,
      {
        storage_unit_id: params?.storageUnitId,
        fallback: params?.fallback === false ? 'false' : undefined,
      },
    )
    const [price] = parseWith(DisplayPricesSchema, data, 'displayPrice')
    if (!price) {
      throw new TriexClientError(
        TriexError.UnexpectedResponse,
        `Unexpected indexer response for displayPrice: no price entry for item ${itemId}.`,
      )
    }
    return price
  }

  /**
   * Fee reserve and open-order depth for up to 200 hubs. Hubs that no
   * longer exist are omitted. Cached upstream for 30 s. 50 CU.
   */
  async hubEconomics(hubIds: string[]): Promise<HubEconomics[]> {
    if (hubIds.length === 0) return []
    const data = await this.get('/v1/hubs/economics', { ids: hubIds.join(',') })
    return parseWith(z.array(HubEconomicsSchema), data, 'hubEconomics')
  }

  /**
   * Pools ranked by unclaimed fee balance, largest first; only pools with a
   * positive balance appear. `limit` defaults to 20 (max 100). 50 CU.
   */
  async topPoolsByFees(limit?: number): Promise<PoolFees[]> {
    const data = await this.get('/v1/pools/top-by-fees', { limit })
    return parseWith(z.array(PoolFeesSchema), data, 'topPoolsByFees')
  }

  /**
   * Platform-wide aggregates — trades and traders by window, volume per
   * quote currency, top items, organization and shared-storage totals, and
   * 30-day daily series. Cached upstream up to 60 s. 50 CU.
   */
  async stats(): Promise<PlatformStats> {
    const data = await this.get('/v1/stats')
    return parseWith(PlatformStatsSchema, data, 'stats')
  }

  // ─── Characters & tribes ──────────────────────────────────────────────────

  /**
   * One character by object id. `enrich` adds the on-chain `ownerCapId` and
   * `assemblyId`. 20 CU.
   * @throws `CharacterNotFound` for an unknown id.
   */
  async character(
    characterId: string,
    params?: { enrich?: boolean },
  ): Promise<Character> {
    const data = await this.get(
      `/v1/characters/${encodeURIComponent(characterId)}`,
      { enrich: params?.enrich },
      TriexError.CharacterNotFound,
    )
    return parseWith(CharacterSchema, data, 'character')
  }

  /**
   * Every character a wallet has, newest first — `[]` when none. A wallet
   * can hold several (one per tenant / re-created character). 20 CU.
   */
  async charactersByAddress(
    address: string,
    params?: { enrich?: boolean },
  ): Promise<Character[]> {
    const data = await this.get(
      `/v1/characters/address/${encodeURIComponent(address)}`,
      { enrich: params?.enrich },
    )
    return parseWith(z.array(CharacterSchema), data, 'charactersByAddress')
  }

  /** Characters whose name EXACTLY matches, newest first. 20 CU. */
  async charactersByName(name: string): Promise<Character[]> {
    const data = await this.get(
      `/v1/characters/name/${encodeURIComponent(name)}`,
    )
    return parseWith(z.array(CharacterSchema), data, 'charactersByName')
  }

  /**
   * Resolve up to 500 wallet addresses to their characters (with tribe
   * names) in one call. Every address comes back, echoed in `address`;
   * unresolved ones have null fields. 50 CU.
   * @throws `ValidationFailed` for more than 500 addresses.
   */
  async charactersBatch(addresses: string[]): Promise<CharacterLookup[]> {
    if (addresses.length === 0) return []
    if (addresses.length > 500) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `At most 500 addresses per character batch; got ${addresses.length}.`,
      )
    }
    const data = await this.get('/v1/characters/batch', {
      addresses: addresses.join(','),
    })
    return parseWith(z.array(CharacterLookupSchema), data, 'charactersBatch')
  }

  /**
   * Tribe metadata by numeric id. Calls `/v1/world/tribes/{id}`; the legacy
   * `/v1/tribes/{id}` alias (deprecated 2026-08-20) is not used. 20 CU.
   * @throws `TribeNotFound` for an unknown id.
   */
  async tribe(tribeId: number): Promise<Tribe> {
    const data = await this.get(
      `/v1/world/tribes/${encodeURIComponent(String(tribeId))}`,
      undefined,
      TriexError.TribeNotFound,
    )
    return parseWith(TribeSchema, data, 'tribe')
  }

  // ─── World reference data ─────────────────────────────────────────────────

  /**
   * The full curated world item list (~1–2k items, ~100 KB). Static data
   * republished when game data changes — fetch once and cache. 20 CU.
   */
  async worldItems(): Promise<WorldItem[]> {
    const data = await this.get('/v1/world/items')
    return parseWith(z.array(WorldItemSchema), data, 'worldItems')
  }

  /**
   * Display name and group for one item type id. 20 CU.
   * @throws `ItemNotFound` for an unknown id.
   */
  async worldItem(assetId: string): Promise<ItemInfo> {
    const data = await this.get(
      `/v1/world/items/${encodeURIComponent(assetId)}`,
      undefined,
      TriexError.ItemNotFound,
    )
    return parseWith(ItemInfoSchema, data, 'worldItem')
  }

  /** Every crafting recipe (static data — fetch once and cache). 20 CU. */
  async recipes(): Promise<Recipe[]> {
    const data = await this.get('/v1/world/recipes')
    return parseWith(z.array(RecipeSchema), data, 'recipes')
  }

  /**
   * The recipes that produce one item (by product type id). `[]` when
   * nothing crafts it — the CDN answers that with a 404, which is the
   * ordinary "not craftable" answer rather than an error. 20 CU.
   */
  async recipesFor(productAssetId: string): Promise<Recipe[]> {
    try {
      const data = await this.get(
        `/v1/world/recipes/${encodeURIComponent(productAssetId)}`,
        undefined,
        TriexError.ItemNotFound,
      )
      return parseWith(z.array(RecipeSchema), data, 'recipesFor')
    } catch (e) {
      if (e instanceof TriexClientError && e.status === 404) return []
      throw e
    }
  }

  // ─── Routing (location-api) ───────────────────────────────────────────────

  /**
   * A* route between two systems over stargates plus jump-drive hops within
   * `maxJumpRangeLy`. Origin and destination are NAMES, and since cycle 7
   * only player-reported names resolve. 100 CU.
   * @throws `RouteNotFound` when a name is unreported/unknown, or the pair is
   *   unreachable under these ship parameters.
   */
  async route(params: RouteParams): Promise<Route> {
    const data = await this.get(
      '/v1/routing/route',
      {
        origin: params.origin,
        destination: params.destination,
        optimization: params.optimization,
        mass: params.mass,
        gate_weight: params.gateWeight,
        max_jump_range_ly: params.maxJumpRangeLy,
      },
      TriexError.RouteNotFound,
    )
    return parseWith(RouteSchema, data, 'route')
  }

  /**
   * The fuel-efficient, fastest and balanced routes for one pair in a single
   * consistent call. THREE route searches — 300 CU; prefer `route()` when
   * one mode will do.
   * @throws `RouteNotFound` as `route()` (no mode could connect the pair).
   */
  async compareRoutes(params: RouteShipParams): Promise<RouteComparison> {
    const data = await this.get(
      '/v1/routing/compare',
      {
        origin: params.origin,
        destination: params.destination,
        mass: params.mass,
        gate_weight: params.gateWeight,
        max_jump_range_ly: params.maxJumpRangeLy,
      },
      TriexError.RouteNotFound,
    )
    return parseWith(RouteComparisonSchema, data, 'compareRoutes')
  }

  /** Size of the routing graph and its default jump range. 20 CU. */
  async routingStats(): Promise<RoutingStats> {
    const data = await this.get('/v1/routing/stats')
    return parseWith(RoutingStatsSchema, data, 'routingStats')
  }
}

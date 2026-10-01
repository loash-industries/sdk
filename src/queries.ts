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
} from './types'

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

  /** #6 — open orders across the universe, most-recent activity first. */
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
   * 404s (`HubNotFound`) when the hub has no trading vault.
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

  /** #9b — resting orders for a pool (bids high-first, asks low-first). */
  async orderbook(poolId: string): Promise<Orderbook> {
    const data = await this.get(
      `/v1/pools/${encodeURIComponent(poolId)}/orderbook`,
      undefined,
      TriexError.PoolNotFound,
    )
    return { poolId, ...parseWith(OrderbookSchema, data, 'orderbook') }
  }

  /** #10/#11 — pool metadata (decimals, fee rate, hub linkage). */
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
   * and `vaultConfigId` (item deposit/withdraw PTBs).
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
   * hubs are private.
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
   * hub has trading initialised at all.
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
   * (`HubNotFound`); `nearbyHubsBySystem()` is the way in for those.
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
   * unknown, or not yet published — and that is surfaced as
   * `SolarSystemNotFound`, so `[]` always means "no hubs in range". Prefer a
   * numeric id: names are not available for every system.
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
   */
  async hubsEnriched(hubIds: string[]): Promise<HubEnriched[]> {
    if (hubIds.length === 0) return []
    const data = await this.get('/v1/hubs/enriched', { ids: hubIds.join(',') })
    return parseWith(z.array(HubEnrichedSchema), data, 'hubsEnriched')
  }

  /** #8 — items with open orders at a trade hub. */
  async hubItems(hubId: string): Promise<HubItemsPage> {
    const data = await this.get(
      `/v1/hubs/${encodeURIComponent(hubId)}/items`,
      undefined,
      TriexError.HubNotFound,
    )
    return parseWith(HubItemsPageSchema, data, 'hubItems')
  }

  /** #8a — search item types by partial name or exact numeric ID. */
  async searchItems(query: string, limit?: number): Promise<ItemSearchPage> {
    const data = await this.get('/v1/world/items/search', { q: query, limit })
    return parseWith(ItemSearchPageSchema, data, 'searchItems')
  }

  /** #7 — reverse lookup: vault collection → its trade hub. */
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
   * "whose structure is this". Cached upstream for five minutes.
   */
  async assemblyOwners(assemblyIds: string[]): Promise<AssemblyOwner[]> {
    if (assemblyIds.length === 0) return []
    const data = await this.get('/v1/assemblies/owners', {
      ids: assemblyIds.join(','),
    })
    return parseWith(z.array(AssemblyOwnerSchema), data, 'assemblyOwners')
  }

  /** `assemblyOwners()` plus the owner's character and the assembly's name. */
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
   * `ou:<org_id>` — how a counterparty on the book is put to a name.
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
   * result set gets human-readable.
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
   * otherwise, so `"EHK-KH7"` and `"30000142"` both work.
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
   * identifiers are omitted from `systems` rather than returned as nulls.
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
   * origin system itself is excluded.
   */
  async nearbySystems(params: NearbySystemsParams): Promise<NearbySystems> {
    const data = await this.get(
      `/v1/spatial/systems/${encodeURIComponent(params.solarSystem)}/nearby`,
      { radius_ly: params.radiusLy, limit: params.limit },
      TriexError.SolarSystemNotFound,
    )
    return parseWith(NearbySystemsSchema, data, 'nearbySystems')
  }

  /** Solar systems within `radiusLy` of a point in space, nearest first. */
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
   * `solarSystem()`.
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

  /** Coverage of the loaded star map — how many systems are queryable. */
  async spatialStats(): Promise<SpatialStats> {
    const data = await this.get('/v1/spatial/stats')
    return parseWith(SpatialStatsSchema, data, 'spatialStats')
  }

  // ─── Inventory (#2 — items only; CRED reads live on the fullnode) ─────────

  /**
   * Hub-scoped item balances. Sections come back empty unless their selecting
   * parameter is passed: `address` → warehouse, `tradingAccountId` →
   * marketplace, `inventoryKey` → hangar, `vaultIds` → orgVaults.
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
   * not in this manifest — read it via `balances.currency()`.)
   */
  async sweepable(tradingAccountId: string): Promise<Sweepable> {
    const data = await this.get(
      `/v1/trading-accounts/${encodeURIComponent(tradingAccountId)}/sweepable`,
      undefined,
      TriexError.TradingAccountNotFound,
    )
    return parseWith(SweepableSchema, data, 'sweepable')
  }

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
}

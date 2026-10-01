import { OrgsApi } from './armature/OrgsApi'
import { DEFAULT_INDEXER_URL, resolvePackageIds } from './config'
import { TriexClientError, TriexError } from './errors'
import { IndexerClient } from './queries'
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
  DiscoveryFilters,
  DiscoveryResult,
  FillsPage,
  FillsParams,
  HistoryPageParams,
  HubEnriched,
  HubItemOrderbook,
  HubItemsPage,
  HubLocationFilters,
  HubLocationPage,
  ItemSearchPage,
  InventoryBalances,
  LocationPageParams,
  NearbyHub,
  NearbyHubsParams,
  NearbyHubsBySystemParams,
  NearbySystems,
  NearbySystemsParams,
  OpenOrdersPage,
  PackageIds,
  PoolMetadata,
  ReadOnlyClientConfig,
  SolarSystem,
  SolarSystemName,
  SpatialStats,
  Sweepable,
  TradeHubDetail,
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

/**
 * Indexer-only client — no `executor`, no signing, no fullnode. For
 * dashboards, market scanners, and bots that only observe. Identity params
 * (address, trading account id) are always explicit here since there is no
 * configured player. Currency (CRED) balances are fullnode reads and live on
 * `TriexClient.balances.currency()` only.
 *
 * ERRORS — every method throws `TriexClientError` with a stable `code`:
 * `Unauthorized` (bad/missing key), `RateLimited` (CU budget; carries
 * `retryAfterMs`), `IndexerError`, `UnexpectedResponse`, plus per-target
 * `HubNotFound` / `PoolNotFound` / `TradingAccountNotFound` /
 * `OrderNotFound` / `FillNotFound` / `CharacterNotFound` / `TribeNotFound` /
 * `ItemNotFound` / `SolarSystemNotFound` / `RouteNotFound` on unknown ids.
 *
 * Each method's doc gives its compute-unit (CU) cost per call.
 */
export class ReadOnlyClient {
  readonly ids: PackageIds
  readonly indexer: IndexerClient
  /**
   * Organization identity & discovery (Armature). Address-taking methods
   * REQUIRE an explicit address here — this client has no configured player.
   */
  readonly orgs: OrgsApi

  constructor(config: ReadOnlyClientConfig) {
    this.ids = resolvePackageIds(config.network ?? 'testnet', config.packageIds)
    this.indexer = new IndexerClient(
      config.indexerUrl ?? DEFAULT_INDEXER_URL,
      config.apiKey,
    )
    this.orgs = new OrgsApi(this.indexer, (addr) => {
      if (!addr) {
        throw new TriexClientError(
          TriexError.AddressRequired,
          'ReadOnlyClient has no configured player — pass the address explicitly.',
        )
      }
      return addr
    })
  }

  /** #6 — discover open orders across the universe (most recent first). 150 CU. */
  discover(filters?: DiscoveryFilters): Promise<DiscoveryResult> {
    return this.indexer.discovery(filters)
  }

  /** #7 — trade-hub detail: vault descriptor + location (null if unrevealed). 2 calls, 40 CU. */
  async hub(hubId: string): Promise<TradeHubDetail> {
    const [vault, location] = await Promise.all([
      this.indexer.hubVault(hubId),
      this.indexer.hubLocation(hubId),
    ])
    return {
      hubId: vault.hubId,
      collectionId: vault.collectionId,
      vaultConfigId: vault.vaultConfigId,
      location,
    }
  }

  /** #8 — items with open orders at a trade hub. 20 CU. */
  itemsAtHub(hubId: string): Promise<HubItemsPage> {
    return this.indexer.hubItems(hubId)
  }

  /**
   * #8a — resolve an item name to its `assetId`: search item types by
   * partial, case-insensitive name (or exact numeric ID), with mass and
   * crafting recipes per match. 50 CU.
   */
  searchItems(
    query: string,
    opts?: { limit?: number },
  ): Promise<ItemSearchPage> {
    return this.indexer.searchItems(query, opts?.limit)
  }

  /** #9a — resolve the pool for an item at a trade hub. 2 calls, 50 CU. */
  async resolvePool(params: {
    storageUnitId: string
    assetId: string
  }): Promise<string> {
    const vault = await this.indexer.hubVault(params.storageUnitId)
    const poolId = await this.indexer.resolvePool({
      collectionId: vault.collectionId,
      assetId: params.assetId,
    })
    if (!poolId) {
      throw new TriexClientError(
        TriexError.PoolNotFound,
        `No pool for item ${params.assetId} at hub ${params.storageUnitId}.`,
      )
    }
    return poolId
  }

  /**
   * #9 — order book for one item at a trade hub. A single indexer call: the
   * gateway resolves the hub's pool and returns the book with pool metadata
   * embedded. 50 CU.
   */
  async orderbook(params: {
    storageUnitId: string
    assetId: string
  }): Promise<HubItemOrderbook> {
    const book = await this.indexer.hubItemOrderbook({
      hubId: params.storageUnitId,
      assetId: params.assetId,
    })
    if (!book.poolId) {
      throw new TriexClientError(
        TriexError.PoolNotFound,
        `No pool for item ${params.assetId} at hub ${params.storageUnitId}.`,
      )
    }
    return { ...book, poolId: book.poolId }
  }

  /** #10/#11 — pool metadata (decimals, entry-tier fee rate, hub linkage). 20 CU. */
  poolMetadata(poolId: string): Promise<PoolMetadata> {
    return this.indexer.poolMetadata(poolId)
  }

  /**
   * Every indexed hub location, cursor-paged — the universe-wide counterpart
   * to `hub()`. Narrow with `solarSystemId`, `tenant`, or `hasVault`. 50 CU
   * per page (`iterateHubLocations` walks them all).
   */
  hubLocations(filters?: HubLocationFilters): Promise<HubLocationPage> {
    return this.indexer.hubLocations(filters)
  }

  /** Where an item is currently for sale, cursor-paged. 50 CU per page. */
  itemLocations(
    assetId: string,
    opts?: LocationPageParams,
  ): Promise<HubLocationPage> {
    return this.indexer.itemLocations(assetId, opts)
  }

  /**
   * Hubs within `rangeLy` light years of a hub (default and max 3500). 50 CU.
   * @throws `HubNotFound` when the origin hub publishes no location.
   */
  nearbyHubs(params: NearbyHubsParams): Promise<NearbyHub[]> {
    return this.indexer.nearbyHubs(params)
  }

  /**
   * The same proximity search centred on a solar system id or name. Prefer a
   * numeric id — a name resolves only once a player has reported it. 50 CU.
   * @throws `SolarSystemNotFound` when a name can't be resolved.
   */
  nearbyHubsBySystem(params: NearbyHubsBySystemParams): Promise<NearbyHub[]> {
    return this.indexer.nearbyHubsBySystem(params)
  }

  /** Batch hub detail — location, market count, last activity (max 200). 50 CU. */
  hubsEnriched(params: { hubIds: string[] }): Promise<HubEnriched[]> {
    return this.indexer.hubsEnriched(params.hubIds)
  }

  /** Owner wallet for up to 200 assembly (structure) object ids. 50 CU. */
  assemblyOwners(params: { assemblyIds: string[] }): Promise<AssemblyOwner[]> {
    return this.indexer.assemblyOwners(params.assemblyIds)
  }

  /** `assemblyOwners()` plus owner character and assembly name. 50 CU. */
  assembliesEnriched(params: {
    assemblyIds: string[]
  }): Promise<AssemblyEnriched[]> {
    return this.indexer.assembliesEnriched(params.assemblyIds)
  }

  /**
   * Display names for up to 200 numeric solar system ids; null until a
   * player has reported the name. 50 CU.
   */
  solarSystemNames(params: {
    solarSystemIds: number[]
  }): Promise<SolarSystemName[]> {
    return this.indexer.solarSystemNames(params.solarSystemIds)
  }

  /**
   * Who owns these trading accounts (max 200). `owner` is TAGGED —
   * `player:<wallet>` or `ou:<org_id>` — since an account may belong to an
   * organization rather than a character. 50 CU.
   */
  accountOwners(params: {
    tradingAccountIds: string[]
  }): Promise<TradingAccountOwner[]> {
    return this.indexer.tradingAccountOwners(params.tradingAccountIds)
  }

  // ─── Spatial: the star map ────────────────────────────────────────────────

  /**
   * One solar system by name or numeric id. A name resolves only once a
   * player has reported it (cycle 7); an id always does. 20 CU.
   * @throws `SolarSystemNotFound` when nothing matches.
   */
  spatialSystem(solarSystem: string): Promise<SolarSystem> {
    return this.indexer.solarSystem(solarSystem)
  }

  /**
   * Up to 100 systems in one call, by id or by name (not both); unreported
   * names are omitted like any miss. 50 CU.
   * @throws `ValidationFailed` when neither or both selectors are given.
   */
  spatialSystems(params: BatchSystemsParams): Promise<BatchSystems> {
    return this.indexer.solarSystems(params)
  }

  /**
   * Systems within `radiusLy` of another system, nearest first (origin
   * excluded). 50 CU.
   * @throws `SolarSystemNotFound` for an unknown origin.
   */
  spatialNearbySystems(params: NearbySystemsParams): Promise<NearbySystems> {
    return this.indexer.nearbySystems(params)
  }

  /** The same radius search around an arbitrary point in space. 50 CU. */
  spatialSystemsNearCoordinates(
    params: CoordinateSearchParams,
  ): Promise<CoordinateSearch> {
    return this.indexer.systemsNearCoordinates(params)
  }

  /** Name-prefix autocomplete over REPORTED solar system names. 20 CU. */
  spatialAutocompleteSystems(
    query: string,
    opts?: { limit?: number },
  ): Promise<AutocompleteSystems> {
    return this.indexer.autocompleteSystems(query, opts?.limit)
  }

  /** Coverage of the loaded star map, incl. how many names are known. 20 CU. */
  spatialStats(): Promise<SpatialStats> {
    return this.indexer.spatialStats()
  }

  /** #2 — hub-scoped item balances for an explicit address / BM / hangar key. 50 CU. */
  balancesAtHub(
    params: BalancesAtHubParams & { tradingAccountId?: string },
  ): Promise<InventoryBalances> {
    return this.indexer.inventoryBalances(params)
  }

  /** #14 — open orders for an explicit trading account. 30 CU. */
  openOrders(
    tradingAccountId: string,
    params?: HistoryPageParams,
  ): Promise<OpenOrdersPage> {
    return this.indexer.openOrders(tradingAccountId, params)
  }

  /** #14 — fills for an explicit trading account. 30 CU. */
  fills(tradingAccountId: string, params?: FillsParams): Promise<FillsPage> {
    return this.indexer.fills(tradingAccountId, params)
  }

  /** #14 — trades for an explicit trading account. 30 CU. */
  trades(tradingAccountId: string, params?: TradesParams): Promise<TradesPage> {
    return this.indexer.trades(tradingAccountId, params)
  }

  /** Claimable proceeds + idle BM items for an explicit trading account. 30 CU. */
  sweepable(tradingAccountId: string): Promise<Sweepable> {
    return this.indexer.sweepable(tradingAccountId)
  }

  // ─── Orders & fills: point lookups ────────────────────────────────────────

  /**
   * One order on one pool, whatever its state — open, filled or cancelled —
   * with owner, hub, currency and fill history. 30 CU.
   * @throws `OrderNotFound`; `ValidationFailed` for a non-u128 order id.
   */
  order(params: OrderLookupParams): Promise<OrderDetail> {
    return this.indexer.poolOrder(params)
  }

  /**
   * One fill by event digest, with both sides' accounts and fees. 30 CU.
   * @throws `FillNotFound`.
   */
  fill(eventDigest: string): Promise<FillDetail> {
    return this.indexer.fill(eventDigest)
  }

  // ─── Market-wide feeds, prices & rankings ─────────────────────────────────

  /**
   * Latest trades across every item market, newest first (≤ 50 per page;
   * page with `nextCursor` as `before`, or `iterateRecentTrades`). Prices are
   * HUMAN-READABLE decimals. 50 CU.
   */
  recentTrades(params?: RecentTradesParams): Promise<RecentTradesPage> {
    return this.indexer.recentTrades(params)
  }

  /**
   * Plain market display prices (no fee) for up to 100 items, optionally per
   * hub. 50 CU.
   */
  displayPrices(params: DisplayPricesParams): Promise<DisplayPrice[]> {
    return this.indexer.displayPrices(params)
  }

  /** Display price for one item, optionally at one hub. 20 CU. */
  displayPrice(
    itemId: string,
    opts?: DisplayPriceParams,
  ): Promise<DisplayPrice> {
    return this.indexer.displayPrice(itemId, opts)
  }

  /** Fee reserve and open-order depth for up to 200 hubs. 50 CU. */
  hubEconomics(params: { hubIds: string[] }): Promise<HubEconomics[]> {
    return this.indexer.hubEconomics(params.hubIds)
  }

  /** Pools ranked by unclaimed fees (default 20, max 100). 50 CU. */
  topPoolsByFees(opts?: { limit?: number }): Promise<PoolFees[]> {
    return this.indexer.topPoolsByFees(opts?.limit)
  }

  /** Platform-wide marketplace, organization and pilot aggregates. 50 CU. */
  stats(): Promise<PlatformStats> {
    return this.indexer.stats()
  }

  // ─── Characters & tribes ──────────────────────────────────────────────────

  /**
   * One character by object id (`enrich` adds owner-cap and assembly ids).
   * 20 CU.
   * @throws `CharacterNotFound`.
   */
  character(
    characterId: string,
    opts?: { enrich?: boolean },
  ): Promise<Character> {
    return this.indexer.character(characterId, opts)
  }

  /** Every character a wallet holds, newest first. 20 CU. */
  charactersByAddress(
    address: string,
    opts?: { enrich?: boolean },
  ): Promise<Character[]> {
    return this.indexer.charactersByAddress(address, opts)
  }

  /** Characters with exactly this name, newest first. 20 CU. */
  charactersByName(name: string): Promise<Character[]> {
    return this.indexer.charactersByName(name)
  }

  /**
   * Resolve up to 500 wallet addresses to characters (+ tribe names). 50 CU.
   * @throws `ValidationFailed` over 500.
   */
  charactersBatch(params: { addresses: string[] }): Promise<CharacterLookup[]> {
    return this.indexer.charactersBatch(params.addresses)
  }

  /**
   * Tribe metadata by numeric id. 20 CU.
   * @throws `TribeNotFound`.
   */
  tribe(tribeId: number): Promise<Tribe> {
    return this.indexer.tribe(tribeId)
  }

  // ─── World reference data ─────────────────────────────────────────────────

  /** The full curated world item list — static, cache it. 20 CU. */
  worldItems(): Promise<WorldItem[]> {
    return this.indexer.worldItems()
  }

  /**
   * Name and group for one item type id. 20 CU.
   * @throws `ItemNotFound`.
   */
  worldItem(assetId: string): Promise<ItemInfo> {
    return this.indexer.worldItem(assetId)
  }

  /** Every crafting recipe — static, cache it. 20 CU. */
  recipes(): Promise<Recipe[]> {
    return this.indexer.recipes()
  }

  /** Recipes producing one item; `[]` when it is not craftable. 20 CU. */
  recipesFor(productAssetId: string): Promise<Recipe[]> {
    return this.indexer.recipesFor(productAssetId)
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  /**
   * Route between two systems BY NAME (player-reported names only). 100 CU.
   * @throws `RouteNotFound`.
   */
  route(params: RouteParams): Promise<Route> {
    return this.indexer.route(params)
  }

  /**
   * Fuel-efficient, fastest and balanced routes in one call. 300 CU.
   * @throws `RouteNotFound`.
   */
  compareRoutes(params: RouteShipParams): Promise<RouteComparison> {
    return this.indexer.compareRoutes(params)
  }

  /** Routing-graph coverage and default jump range. 20 CU. */
  routingStats(): Promise<RoutingStats> {
    return this.indexer.routingStats()
  }
}

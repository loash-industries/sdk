import { DEFAULT_INDEXER_URL, resolvePackageIds } from './config'
import { TriexClientError, TriexError } from './errors'
import { IndexerClient } from './queries'
import type {
  AssemblyEnriched,
  AssemblyOwner,
  AutocompleteSystems,
  BalanceManagerOwner,
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
} from './types'

/**
 * Indexer-only client — no `executor`, no signing, no fullnode. For
 * dashboards, market scanners, and bots that only observe. Identity params
 * (address, balance manager id) are always explicit here since there is no
 * configured player. Currency (CRED) balances are fullnode reads and live on
 * `TriexClient.balances.currency()` only.
 *
 * ERRORS — every method throws `TriexClientError` with a stable `code`:
 * `Unauthorized` (bad/missing key), `RateLimited` (CU budget; carries
 * `retryAfterMs`), `IndexerError`, `UnexpectedResponse`, plus per-target
 * `HubNotFound` / `PoolNotFound` / `BalanceManagerNotFound` on unknown ids.
 */
export class ReadOnlyClient {
  readonly ids: PackageIds
  readonly indexer: IndexerClient

  constructor(config: ReadOnlyClientConfig) {
    this.ids = resolvePackageIds(config.network ?? 'testnet', config.packageIds)
    this.indexer = new IndexerClient(
      config.indexerUrl ?? DEFAULT_INDEXER_URL,
      config.apiKey,
    )
  }

  /** #6 — discover open orders across the universe (most recent first). */
  discover(filters?: DiscoveryFilters): Promise<DiscoveryResult> {
    return this.indexer.discovery(filters)
  }

  /** #7 — trade-hub detail: vault descriptor + location (null if unrevealed). */
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

  /** #8 — items with open orders at a trade hub. */
  itemsAtHub(hubId: string): Promise<HubItemsPage> {
    return this.indexer.hubItems(hubId)
  }

  /**
   * #8a — resolve an item name to its `assetId`: search item types by
   * partial, case-insensitive name (or exact numeric ID), with mass and
   * crafting recipes per match.
   */
  searchItems(
    query: string,
    opts?: { limit?: number },
  ): Promise<ItemSearchPage> {
    return this.indexer.searchItems(query, opts?.limit)
  }

  /** #9a — resolve the pool for an item at a trade hub. */
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
   * embedded.
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

  /** #10/#11 — pool metadata (decimals, fee rate, hub linkage). */
  poolMetadata(poolId: string): Promise<PoolMetadata> {
    return this.indexer.poolMetadata(poolId)
  }

  /**
   * Every indexed hub location, cursor-paged — the universe-wide counterpart
   * to `hub()`. Narrow with `solarSystemId`, `tenant`, or `hasVault`.
   */
  hubLocations(filters?: HubLocationFilters): Promise<HubLocationPage> {
    return this.indexer.hubLocations(filters)
  }

  /** Where an item is currently for sale, cursor-paged. */
  itemLocations(
    assetId: string,
    opts?: LocationPageParams,
  ): Promise<HubLocationPage> {
    return this.indexer.itemLocations(assetId, opts)
  }

  /**
   * Hubs within `rangeLy` light years of a hub (default and max 3500).
   * @throws `HubNotFound` when the origin hub publishes no location.
   */
  nearbyHubs(params: NearbyHubsParams): Promise<NearbyHub[]> {
    return this.indexer.nearbyHubs(params)
  }

  /** The same proximity search centred on a solar system id or name. */
  nearbyHubsBySystem(params: NearbyHubsBySystemParams): Promise<NearbyHub[]> {
    return this.indexer.nearbyHubsBySystem(params)
  }

  /** Batch hub detail — location, market count, last activity (max 200). */
  hubsEnriched(params: { hubIds: string[] }): Promise<HubEnriched[]> {
    return this.indexer.hubsEnriched(params.hubIds)
  }

  /** Owner wallet for up to 200 assembly (structure) object ids. */
  assemblyOwners(params: { assemblyIds: string[] }): Promise<AssemblyOwner[]> {
    return this.indexer.assemblyOwners(params.assemblyIds)
  }

  /** `assemblyOwners()` plus owner character and assembly name. */
  assembliesEnriched(params: {
    assemblyIds: string[]
  }): Promise<AssemblyEnriched[]> {
    return this.indexer.assembliesEnriched(params.assemblyIds)
  }

  /** Display names for up to 200 numeric solar system ids. */
  solarSystemNames(params: {
    solarSystemIds: number[]
  }): Promise<SolarSystemName[]> {
    return this.indexer.solarSystemNames(params.solarSystemIds)
  }

  /**
   * Who owns these trading accounts (max 200). `owner` is TAGGED —
   * `player:<wallet>` or `ou:<org_id>` — since an account may belong to an
   * organization rather than a character.
   */
  accountOwners(params: {
    balanceManagerIds: string[]
  }): Promise<BalanceManagerOwner[]> {
    return this.indexer.balanceManagerOwners(params.balanceManagerIds)
  }

  // ─── Spatial: the star map ────────────────────────────────────────────────

  /**
   * One solar system by name or numeric id.
   * @throws `SolarSystemNotFound` when nothing matches.
   */
  spatialSystem(solarSystem: string): Promise<SolarSystem> {
    return this.indexer.solarSystem(solarSystem)
  }

  /**
   * Up to 100 systems in one call, by id or by name (not both).
   * @throws `ValidationFailed` when neither or both selectors are given.
   */
  spatialSystems(params: BatchSystemsParams): Promise<BatchSystems> {
    return this.indexer.solarSystems(params)
  }

  /**
   * Systems within `radiusLy` of another system, nearest first (origin
   * excluded).
   * @throws `SolarSystemNotFound` for an unknown origin.
   */
  spatialNearbySystems(params: NearbySystemsParams): Promise<NearbySystems> {
    return this.indexer.nearbySystems(params)
  }

  /** The same radius search around an arbitrary point in space. */
  spatialSystemsNearCoordinates(
    params: CoordinateSearchParams,
  ): Promise<CoordinateSearch> {
    return this.indexer.systemsNearCoordinates(params)
  }

  /** Name-prefix autocomplete over solar system names, alphabetical. */
  spatialAutocompleteSystems(
    query: string,
    opts?: { limit?: number },
  ): Promise<AutocompleteSystems> {
    return this.indexer.autocompleteSystems(query, opts?.limit)
  }

  /** Coverage of the loaded star map. */
  spatialStats(): Promise<SpatialStats> {
    return this.indexer.spatialStats()
  }

  /** #2 — hub-scoped item balances for an explicit address / BM / hangar key. */
  balancesAtHub(
    params: BalancesAtHubParams & { balanceManagerId?: string },
  ): Promise<InventoryBalances> {
    return this.indexer.inventoryBalances(params)
  }

  /** #14 — open orders for an explicit balance manager. */
  openOrders(
    balanceManagerId: string,
    params?: HistoryPageParams,
  ): Promise<OpenOrdersPage> {
    return this.indexer.openOrders(balanceManagerId, params)
  }

  /** #14 — fills for an explicit balance manager. */
  fills(balanceManagerId: string, params?: FillsParams): Promise<FillsPage> {
    return this.indexer.fills(balanceManagerId, params)
  }

  /** #14 — trades for an explicit balance manager. */
  trades(balanceManagerId: string, params?: TradesParams): Promise<TradesPage> {
    return this.indexer.trades(balanceManagerId, params)
  }

  /** Claimable proceeds + idle BM items for an explicit balance manager. */
  sweepable(balanceManagerId: string): Promise<Sweepable> {
    return this.indexer.sweepable(balanceManagerId)
  }
}

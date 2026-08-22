import { DEFAULT_INDEXER_URL, resolvePackageIds } from './config'
import { TriexClientError, TriexError } from './errors'
import { IndexerClient } from './queries'
import type {
  BalancesAtHubParams,
  DiscoveryFilters,
  DiscoveryResult,
  FillsPage,
  FillsParams,
  HistoryPageParams,
  HubItemOrderbook,
  HubItemsPage,
  ItemSearchPage,
  InventoryBalances,
  OpenOrdersPage,
  PackageIds,
  PoolMetadata,
  ReadOnlyClientConfig,
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

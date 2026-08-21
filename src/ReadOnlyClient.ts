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
  HubItemsPage,
  InventoryBalances,
  OpenOrdersPage,
  Orderbook,
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

  /** #9 — order book for one item at a trade hub. */
  async orderbook(params: {
    storageUnitId: string
    assetId: string
  }): Promise<Orderbook> {
    const poolId = await this.resolvePool(params)
    return this.indexer.orderbook(poolId)
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

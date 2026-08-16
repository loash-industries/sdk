import { DEFAULT_INDEXER_URL, resolvePackageIds } from './config'
import { IndexerClient } from './queries'
import type {
  DiscoveryResult,
  HubItemListing,
  Orderbook,
  PackageIds,
  PoolMetadata,
  ReadOnlyClientConfig,
  TradeHubDetail,
} from './types'

/**
 * Indexer-only client — no `executor`, no signing. For dashboards, market
 * scanners, and bots that only observe. Exposes just the read surface.
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

  discover(filters?: {
    typeId?: string
    hubId?: string
    side?: 'buy' | 'sell'
    cursor?: string
    limit?: number
  }): Promise<DiscoveryResult> {
    return this.indexer.discovery(filters)
  }

  hub(hubId: string): Promise<TradeHubDetail> {
    return this.indexer.hub(hubId)
  }

  itemsAtHub(hubId: string): Promise<HubItemListing[]> {
    return this.indexer.itemsAtHub(hubId)
  }

  async orderbook(params: {
    storageUnitId: string
    typeId: string
  }): Promise<Orderbook> {
    const poolId = await this.indexer.resolvePool(
      params.storageUnitId,
      params.typeId,
    )
    return this.indexer.orderbook(poolId)
  }

  poolMetadata(poolId: string): Promise<PoolMetadata> {
    return this.indexer.poolMetadata(poolId)
  }
}

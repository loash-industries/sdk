import { TriexClientError, TriexError } from './errors'
import {
  DiscoveryResultSchema,
  OrderbookSchema,
  PoolMetadataSchema,
  parseWith,
} from './schemas'
import type {
  CharacterBalances,
  DiscoveryResult,
  HubItemListing,
  Orderbook,
  PoolMetadata,
  TradeHubDetail,
  OpenOrder,
  Fill,
  Trade,
} from './types'

/**
 * Thin HTTP client for the Trinary Exchange indexer (etl-api behind the sluice
 * gateway). All reads go through here; auth is the `x-api-key` header.
 *
 * NOTE: Most endpoints below are currently DISABLED on the gateway and will 404
 * until Phase 0 enables + publishes them (DESIGN.md §9 / Appendix). The wiring
 * is complete; response schemas are provisional (RQ-1).
 */
export class IndexerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  /** GET `path` (+ optional query) and return parsed JSON. */
  private async get<T = unknown>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    if (!this.apiKey) {
      throw new TriexClientError(
        TriexError.ApiKeyRequired,
        'An apiKey is required for indexer reads.',
      )
    }
    const url = new URL(path, this.baseUrl)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }
    const res = await fetch(url, {
      headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
    })
    if (!res.ok) {
      throw new TriexClientError(
        TriexError.IndexerError,
        `Indexer ${res.status} ${res.statusText} for GET ${url.pathname}`,
      )
    }
    return (await res.json()) as T
  }

  // ─── Discovery / market data ──────────────────────────────────────────────

  /** #6 — open orders across the universe, sorted by recency, with filters. */
  async discovery(filters?: {
    typeId?: string
    hubId?: string
    side?: 'buy' | 'sell'
    cursor?: string
    limit?: number
  }): Promise<DiscoveryResult> {
    const data = await this.get('/v1/discovery', {
      type_id: filters?.typeId,
      hub_id: filters?.hubId,
      side: filters?.side,
      cursor: filters?.cursor,
      limit: filters?.limit,
    })
    return parseWith(
      DiscoveryResultSchema,
      data,
      'discovery',
    ) as DiscoveryResult
  }

  /** #9a — resolve an item + storage unit to a pool id. */
  async resolvePool(storageUnitId: string, typeId: string): Promise<string> {
    const data = await this.get<{ pool_id?: string; poolId?: string }>(
      '/v1/pools/resolve',
      { storage_unit_id: storageUnitId, type_id: typeId },
    )
    const poolId = data.pool_id ?? data.poolId
    if (!poolId) {
      throw new TriexClientError(
        TriexError.PoolNotFound,
        `No pool for item ${typeId} at storage unit ${storageUnitId}.`,
      )
    }
    return poolId
  }

  /** #9b — order book for a pool. */
  async orderbook(poolId: string): Promise<Orderbook> {
    const data = await this.get(
      `/v1/pools/${encodeURIComponent(poolId)}/orderbook`,
    )
    return parseWith(OrderbookSchema, data, 'orderbook') as Orderbook
  }

  /** #10/#11 — pool metadata (feeBps etc). */
  async poolMetadata(poolId: string): Promise<PoolMetadata> {
    const data = await this.get(
      `/v1/pools/${encodeURIComponent(poolId)}/metadata`,
    )
    return parseWith(PoolMetadataSchema, data, 'poolMetadata') as PoolMetadata
  }

  // ─── Hubs ─────────────────────────────────────────────────────────────────

  /** #7 — trade-hub details. TODO(RQ-1): map real vault/location fields. */
  async hub(_hubId: string): Promise<TradeHubDetail> {
    throw new TriexClientError(
      TriexError.NotImplemented,
      'hub() response mapping pending RQ-1 (combine /v1/hubs/{id}/vault + /location).',
    )
  }

  /** #8 — items with live orders at a hub. */
  async itemsAtHub(_hubId: string): Promise<HubItemListing[]> {
    throw new TriexClientError(
      TriexError.NotImplemented,
      'itemsAtHub() response mapping pending RQ-1 (/v1/hubs/{id}/items).',
    )
  }

  /**
   * Vault descriptor for a storage unit — vaultConfigId + collectionId used by
   * the item deposit/withdraw PTBs (DESIGN.md §6.1).
   */
  async hubVault(
    _hubId: string,
  ): Promise<{ vaultConfigId: string; collectionId: string }> {
    throw new TriexClientError(
      TriexError.NotImplemented,
      'hubVault() mapping pending RQ-1 (/v1/hubs/{id}/vault).',
    )
  }

  // ─── Account / balances ───────────────────────────────────────────────────

  /** #1 — indexer view of the player's balance manager (on-chain is authoritative). */
  async balanceManagerId(_address: string): Promise<string | null> {
    throw new TriexClientError(
      TriexError.NotImplemented,
      'balanceManagerId() mapping pending RQ-1 (/v1/inventory/balance-manager).',
    )
  }

  /** #2/#3 — item + currency balances for a character. */
  async characterBalances(_characterId: string): Promise<CharacterBalances> {
    throw new TriexClientError(
      TriexError.NotImplemented,
      'characterBalances() mapping pending RQ-1/RQ-4 (/v1/inventory/balances).',
    )
  }

  // ─── Order status (#14, MVP) ──────────────────────────────────────────────

  async openOrders(_balanceManagerId: string): Promise<OpenOrder[]> {
    throw new TriexClientError(
      TriexError.NotImplemented,
      'openOrders() mapping pending RQ-1 (/v1/balance-managers/{bm}/open-orders).',
    )
  }

  async fills(_balanceManagerId: string): Promise<Fill[]> {
    throw new TriexClientError(
      TriexError.NotImplemented,
      'fills() mapping pending RQ-1 (/v1/balance-managers/{bm}/fills).',
    )
  }

  async trades(_balanceManagerId: string): Promise<Trade[]> {
    throw new TriexClientError(
      TriexError.NotImplemented,
      'trades() mapping pending RQ-1 (/v1/balance-managers/{bm}/trades).',
    )
  }
}

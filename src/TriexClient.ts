import { Transaction } from '@mysten/sui/transactions'
import type { ClientWithCoreApi } from '@mysten/sui/client'

import { DEFAULT_INDEXER_URL, resolvePackageIds } from './config'
import { TriexClientError, TriexError, notImplemented } from './errors'
import {
  getBalanceManagerCurrencyBalance,
  getWalletCurrencyBalance,
} from './onchain'
import { IndexerClient } from './queries'
import {
  generateProofAsOwner,
  newBalanceManager,
  withdrawAllCoin,
} from './transactions'
import type {
  BalancesAtHubParams,
  CurrencyBalances,
  DepositCurrencyParams,
  DepositItemsParams,
  DiscoveryFilters,
  DiscoveryResult,
  EnsureAccountResult,
  FillsPage,
  FillsParams,
  HistoryPageParams,
  HubItemsPage,
  InventoryBalances,
  LimitOrderParams,
  MarketOrderParams,
  OpenOrdersPage,
  Orderbook,
  PackageIds,
  PoolMetadata,
  TradeHubDetail,
  TradesPage,
  TradesParams,
  TradingAccount,
  TransactionExecutor,
  TriexClientConfig,
  TxResult,
  WithdrawCurrencyParams,
  WithdrawItemsParams,
} from './types'

/**
 * High-level, full-featured trading client for Trinary Exchange.
 *
 * Reads go through the indexer (`api.trinary.exchange`, `x-api-key`) except
 * currency balances, which are head-current fullnode reads; writes are built
 * as Sui PTBs and handed to the caller-supplied `executor` to sign. The API
 * surface is grouped: `account`, `balances`, `market`, `orders`.
 *
 * SCAFFOLD STATUS: the read surface (Phase 1) and `account.ensure` /
 * `withdrawCurrency` are implemented; deposits, item withdrawals, and order
 * placement land in Phases 2–3 (see DESIGN.md §9).
 */
export class TriexClient {
  readonly suiClient: ClientWithCoreApi
  readonly ids: PackageIds
  readonly indexer: IndexerClient
  private readonly executor?: TransactionExecutor
  private readonly address?: string
  /** Read-your-writes cache for the resolved balance manager id (see §12). */
  private cachedBalanceManagerId?: string

  readonly account: AccountApi
  readonly balances: BalancesApi
  readonly market: MarketApi
  readonly orders: OrdersApi

  constructor(config: TriexClientConfig) {
    this.suiClient = config.suiClient
    this.executor = config.executor
    this.address = config.address
    this.ids = resolvePackageIds(config.network ?? 'testnet', config.packageIds)
    this.indexer = new IndexerClient(
      config.indexerUrl ?? DEFAULT_INDEXER_URL,
      config.apiKey,
    )

    this.account = new AccountApi(this)
    this.balances = new BalancesApi(this)
    this.market = new MarketApi(this)
    this.orders = new OrdersApi(this)
  }

  /** @internal */
  requireExecutor(): TransactionExecutor {
    if (!this.executor) {
      throw new TriexClientError(
        TriexError.ExecutorRequired,
        'This operation writes on-chain and requires an `executor`.',
      )
    }
    return this.executor
  }

  /** @internal */
  requireAddress(override?: string): string {
    const addr = override ?? this.address
    if (!addr) {
      throw new TriexClientError(
        TriexError.ExecutorRequired,
        'This operation needs the player address — set `address` in config or pass it per-call.',
      )
    }
    return addr
  }

  /**
   * Resolve the player's balance manager id. On-chain first (authoritative,
   * head-current — avoids the indexer-lag double-create race, DESIGN.md §12),
   * with an in-client cache for read-your-writes.
   * @internal
   */
  async resolveBalanceManagerId(address: string): Promise<string | null> {
    if (this.cachedBalanceManagerId) return this.cachedBalanceManagerId
    const structType = `${this.ids.triexbook}::balance_manager::BalanceManager`
    // Defensive: SuiClient `.core` surface varies by version; treat as best-effort.
    const core = (this.suiClient as any).core
    const page = await core.listOwnedObjects({
      owner: address,
      type: structType,
      limit: 1,
    })
    const objectId: string | undefined = page?.objects?.[0]?.objectId
    if (objectId) this.cachedBalanceManagerId = objectId
    return objectId ?? null
  }

  /** @internal — pull the created BalanceManager id out of executor results. */
  rememberBalanceManagerId(id: string): void {
    this.cachedBalanceManagerId = id
  }
}

// ─── account ─────────────────────────────────────────────────────────────────

class AccountApi {
  constructor(private readonly c: TriexClient) {}

  /** #1 read — the player's trading account, or null if none exists. */
  async get(address?: string): Promise<TradingAccount | null> {
    const owner = this.c.requireAddress(address)
    const id = await this.c.resolveBalanceManagerId(owner)
    return id ? { balanceManagerId: id, owner } : null
  }

  /** #1 write — idempotently create the balance manager if missing. */
  async ensure(address?: string): Promise<EnsureAccountResult> {
    const owner = this.c.requireAddress(address)
    const existing = await this.c.resolveBalanceManagerId(owner)
    if (existing) return { balanceManagerId: existing, created: false }

    const executor = this.c.requireExecutor()
    const tx = new Transaction()
    const bm = newBalanceManager(tx, this.c.ids)
    tx.transferObjects([bm], owner)
    const res = await executor(tx)

    const created = (res.objectChanges ?? []).find(
      (ch) =>
        ch.type === 'created' &&
        typeof ch.objectType === 'string' &&
        ch.objectType.includes('::balance_manager::BalanceManager'),
    )
    const id = created?.objectId
    if (!id) {
      throw new TriexClientError(
        TriexError.UnexpectedResponse,
        'Balance manager created but no objectId found — ensure the executor sets showObjectChanges:true.',
      )
    }
    this.c.rememberBalanceManagerId(id)
    return { balanceManagerId: id, created: true }
  }

  /** #5 — deposit CRED currency from wallet into the balance manager. */
  async depositCurrency(_params: DepositCurrencyParams): Promise<TxResult> {
    // TODO(Phase 2): ensure BM → prepareWalletCoinInput (list/merge/split) →
    // balance_manager::deposit<CRED> → execute.
    return notImplemented('account.depositCurrency')
  }

  /** #4 — deposit items from hangar/SSU into the balance manager (§6.1). */
  async depositItems(_params: DepositItemsParams): Promise<TxResult> {
    // TODO(Phase 2): ensure BM → hubVault() → resolve character + owner caps →
    // sourceItemsFromHangar → execute.
    return notImplemented('account.depositItems')
  }

  /** #13 — withdraw all CRED from the balance manager back to the wallet. */
  async withdrawCurrency(params?: WithdrawCurrencyParams): Promise<TxResult> {
    const owner = this.c.requireAddress()
    const balanceManagerId = await this.c.resolveBalanceManagerId(owner)
    if (!balanceManagerId) {
      throw new TriexClientError(
        TriexError.BalanceManagerNotFound,
        'No balance manager to withdraw from.',
      )
    }
    if (params?.amount !== undefined) {
      // TODO(Phase 2): partial withdraw uses balance_manager::withdraw<T>(bm, amount).
      return notImplemented('account.withdrawCurrency(amount)')
    }
    const executor = this.c.requireExecutor()
    const tx = new Transaction()
    const bm = tx.object(balanceManagerId)
    const coin = withdrawAllCoin(tx, this.c.ids, bm)
    tx.transferObjects([coin], owner)
    const res = await executor(tx)
    return { digest: res.digest, objectChanges: res.objectChanges }
  }

  /** #12 — withdraw items from the balance manager back to a storage unit. */
  async withdrawItems(_params: WithdrawItemsParams): Promise<TxResult> {
    // TODO(Phase 2): withdraw_all_multicoin → receipt::redeem_receipt.
    return notImplemented('account.withdrawItems')
  }
}

// ─── balances ─────────────────────────────────────────────────────────────────

class BalancesApi {
  constructor(private readonly c: TriexClient) {}

  /**
   * #2 — hub-scoped ITEM balances (indexer). Defaults `address` to the client
   * address and auto-fills `balanceManagerId` when one resolves, so warehouse
   * + marketplace sections come back populated. Hangar contents additionally
   * need `inventoryKey` (an owner_cap_id; automatic resolution lands in
   * Phase 2).
   */
  async atHub(params: BalancesAtHubParams): Promise<InventoryBalances> {
    const address = params.address ?? this.c.requireAddress()
    const balanceManagerId =
      (await this.c.resolveBalanceManagerId(address)) ?? undefined
    return this.c.indexer.inventoryBalances({
      ...params,
      address,
      balanceManagerId,
    })
  }

  /**
   * #3 — CRED balances (wallet + balance manager), read from the FULLNODE:
   * the indexer's inventory endpoint serves items only, and currency values
   * feed write-flow deficit math, which must be head-current (§12).
   */
  async currency(address?: string): Promise<CurrencyBalances> {
    const owner = this.c.requireAddress(address)
    const [wallet, balanceManagerId] = await Promise.all([
      getWalletCurrencyBalance(this.c.suiClient, owner, this.c.ids.credCoinType),
      this.c.resolveBalanceManagerId(owner),
    ])
    const balanceManager = balanceManagerId
      ? await getBalanceManagerCurrencyBalance(
          this.c.suiClient,
          this.c.ids,
          balanceManagerId,
        )
      : 0n
    return { wallet, balanceManager, balanceManagerId }
  }
}

// ─── market ────────────────────────────────────────────────────────────────────

class MarketApi {
  constructor(private readonly c: TriexClient) {}

  /** #6 — discover open orders across the universe (most recent first). */
  discover(filters?: DiscoveryFilters): Promise<DiscoveryResult> {
    return this.c.indexer.discovery(filters)
  }

  /** #7 — trade-hub detail: vault descriptor + location (null if unrevealed). */
  async hub(hubId: string): Promise<TradeHubDetail> {
    const [vault, location] = await Promise.all([
      this.c.indexer.hubVault(hubId),
      this.c.indexer.hubLocation(hubId),
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
    return this.c.indexer.hubItems(hubId)
  }

  /**
   * #9a — resolve the pool for an item at a trade hub (hub → vault collection
   * → pool). Throws `PoolNotFound` when no market exists for the pair.
   */
  async resolvePool(params: {
    storageUnitId: string
    assetId: string
  }): Promise<string> {
    const vault = await this.c.indexer.hubVault(params.storageUnitId)
    const poolId = await this.c.indexer.resolvePool({
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
    return this.c.indexer.orderbook(poolId)
  }

  /** #10/#11 — pool metadata (decimals, fee rate, hub linkage). */
  poolMetadata(poolId: string): Promise<PoolMetadata> {
    return this.c.indexer.poolMetadata(poolId)
  }
}

// ─── orders ──────────────────────────────────────────────────────────────────

class OrdersApi {
  constructor(private readonly c: TriexClient) {}

  /** #10 — place a limit buy/sell order (auto-ensures BM + deposits deficit). */
  async limit(_params: LimitOrderParams): Promise<TxResult> {
    // TODO(Phase 3): ensure BM → resolvePool + poolMetadata → compute deposit
    // (money.ts) → deposit deficit (currency for buy / items for sell) →
    // generateProofAsOwner → placeLimitOrderItem → execute (atomic PTB).
    void generateProofAsOwner
    return notImplemented('orders.limit')
  }

  /** #11 — place a market buy/sell order. */
  async market(_params: MarketOrderParams): Promise<TxResult> {
    // TODO(Phase 3): as limit() but placeMarketOrderItem; buys require quoteBudget.
    return notImplemented('orders.market')
  }

  /** @internal */
  private async requireBm(): Promise<string | null> {
    return this.c.resolveBalanceManagerId(this.c.requireAddress())
  }

  /** #14 — the player's open orders (empty page when no BM exists yet). */
  async openOrders(params?: HistoryPageParams): Promise<OpenOrdersPage> {
    const bm = await this.requireBm()
    if (!bm) return { orders: [], nextCursor: null }
    return this.c.indexer.openOrders(bm, params)
  }

  /** #14 — the player's fills. */
  async fills(params?: FillsParams): Promise<FillsPage> {
    const bm = await this.requireBm()
    if (!bm) return { fills: [], nextCursor: null }
    return this.c.indexer.fills(bm, params)
  }

  /** #14 — the player's trades. */
  async trades(params?: TradesParams): Promise<TradesPage> {
    const bm = await this.requireBm()
    if (!bm) return { trades: [], nextCursor: null }
    return this.c.indexer.trades(bm, params)
  }
}

export type { AccountApi, BalancesApi, MarketApi, OrdersApi }

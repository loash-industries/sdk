import { Transaction } from '@mysten/sui/transactions'
import type {
  TransactionObjectArgument,
  TransactionResult,
} from '@mysten/sui/transactions'
import type { ClientWithCoreApi } from '@mysten/sui/client'

import { DEFAULT_INDEXER_URL, resolvePackageIds } from './config'
import { TriexClientError, TriexError } from './errors'
import { executeAndNormalize, findCreatedObject } from './execute'
import type { NormalizedExecution } from './execute'
import {
  prepareWalletCoinInput,
  sourceItemsIntoBalanceManager,
} from './funding'
import {
  GTC_EXPIRE,
  computeBidQuoteDeposit,
  marketBuyRoundingBuffer,
} from './money'
import {
  fetchCharacterInfo,
  fetchSsuOwnerInfo,
  getBalanceManagerCurrencyBalance,
  getWalletCurrencyBalance,
  toSsuObjectId,
} from './onchain'
import { IndexerClient } from './queries'
import {
  cancelAllOrdersItem,
  cancelOrderItem,
  depositCoin,
  generateProofAsOwner,
  modifyOrderItem,
  newBalanceManager,
  placeLimitOrderItem,
  placeMarketOrderItem,
  redeemReceipt,
  withdrawAllCoin,
  withdrawAllMulticoin,
  withdrawCoin,
  withdrawSettledAmounts,
} from './transactions'
import type {
  BalancesAtHubParams,
  CancelAllOrdersParams,
  CancelOrderParams,
  ClaimSettledParams,
  CurrencyBalances,
  DepositCurrencyParams,
  DepositItemsParams,
  DiscoveryFilters,
  DiscoveryResult,
  EnsureAccountResult,
  FillsPage,
  FillsParams,
  HistoryPageParams,
  HubItemOrderbook,
  HubItemsPage,
  ItemSearchPage,
  InventoryBalances,
  LimitOrderParams,
  MarketOrderParams,
  ModifyOrderParams,
  OpenOrdersPage,
  PackageIds,
  PoolMetadata,
  Sweepable,
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
 * Write flows mirror triex-app-api's production composition: the balance
 * manager is created on demand INSIDE the same PTB as the first operation,
 * deposits cover only the deficit (BM balance is consumed first), and every
 * order is atomic — deposit + proof + place in one transaction that rolls
 * back as a unit.
 *
 * ERRORS — every failure is a `TriexClientError` with a stable `code`. The
 * per-method `@throws` tags below list method-specific codes; in addition,
 * every indexer-backed method can throw `Unauthorized` (bad/missing key),
 * `RateLimited` (CU budget exhausted; carries `retryAfterMs`),
 * `IndexerError` (5xx/unexpected), and `UnexpectedResponse` (schema drift).
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
        TriexError.AddressRequired,
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
    const structType = `${this.ids.triex}::balance_manager::BalanceManager`
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

  /** @internal */
  rememberBalanceManagerId(id: string): void {
    this.cachedBalanceManagerId = id
  }

  /**
   * @internal — start a write PTB against the balance manager, creating it in
   * this same transaction when the player has none (the app's exact pattern).
   */
  async beginBmTx(owner: string): Promise<{
    tx: Transaction
    bm: TransactionObjectArgument
    existingBmId: string | null
  }> {
    const existingBmId = await this.resolveBalanceManagerId(owner)
    const tx = new Transaction()
    const bm = existingBmId
      ? tx.object(existingBmId)
      : newBalanceManager(tx, this.ids)[0]
    return { tx, bm, existingBmId }
  }

  /**
   * @internal — finish a BM write: transfer a freshly-created BM to the owner,
   * execute, capture the new BM id from objectChanges, and map to TxResult.
   */
  async finishBmTx(
    tx: Transaction,
    bm: TransactionObjectArgument,
    existingBmId: string | null,
    owner: string,
  ): Promise<TxResult> {
    if (!existingBmId) tx.transferObjects([bm as TransactionResult], owner)
    const res = await executeAndNormalize(this.requireExecutor(), tx)
    if (!existingBmId) {
      const created = findCreatedBalanceManagerId(res)
      if (created) this.rememberBalanceManagerId(created)
    }
    return toTxResult(res)
  }

  /** @internal — the player's BM id, or a typed error when none exists. */
  async requireBalanceManagerId(owner: string): Promise<string> {
    const id = await this.resolveBalanceManagerId(owner)
    if (!id) {
      throw new TriexClientError(
        TriexError.BalanceManagerNotFound,
        'No balance manager exists for this address yet.',
      )
    }
    return id
  }
}

/** @internal — pull the created BalanceManager id out of executor results. */
function findCreatedBalanceManagerId(res: NormalizedExecution): string | null {
  return (
    findCreatedObject(res, '::balance_manager::BalanceManager')?.objectId ??
    null
  )
}

/** @internal */
function toTxResult(res: NormalizedExecution): TxResult {
  return {
    digest: res.digest,
    createdObjects: res.createdObjects,
    raw: res.raw,
  }
}

// ─── account ─────────────────────────────────────────────────────────────────

class AccountApi {
  constructor(private readonly c: TriexClient) {}

  /**
   * #1 read — the player's trading account, or null if none exists.
   * @throws `AddressRequired` when no address is configured or passed.
   */
  async get(address?: string): Promise<TradingAccount | null> {
    const owner = this.c.requireAddress(address)
    const id = await this.c.resolveBalanceManagerId(owner)
    return id ? { balanceManagerId: id, owner } : null
  }

  /**
   * #1 write — idempotently create the balance manager if missing.
   * @throws `AddressRequired` | `ExecutorRequired` on missing config;
   *   `TransactionFailed` on an on-chain abort; `UnexpectedResponse` when the
   *   executor result carries no created-object info.
   */
  async ensure(address?: string): Promise<EnsureAccountResult> {
    const owner = this.c.requireAddress(address)
    const existing = await this.c.resolveBalanceManagerId(owner)
    if (existing) return { balanceManagerId: existing, created: false }

    const executor = this.c.requireExecutor()
    const tx = new Transaction()
    const bm = newBalanceManager(tx, this.c.ids)
    tx.transferObjects([bm], owner)
    const res = await executeAndNormalize(executor, tx)

    const id = findCreatedBalanceManagerId(res)
    if (!id) {
      throw new TriexClientError(
        TriexError.UnexpectedResponse,
        'Balance manager created but no created-object info found — have the executor include effects+objectTypes (v2) or objectChanges (legacy).',
      )
    }
    this.c.rememberBalanceManagerId(id)
    return { balanceManagerId: id, created: true }
  }

  /**
   * #5 — deposit CRED from the wallet into the balance manager.
   * @throws `ValidationFailed` (non-positive amount); `AddressRequired` |
   *   `ExecutorRequired`; `InsufficientBalance` when the wallet cannot cover
   *   the amount; `TransactionFailed` on an on-chain abort.
   */
  async depositCurrency(params: DepositCurrencyParams): Promise<TxResult> {
    if (params.amount <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Deposit amount must be positive.',
      )
    }
    const owner = this.c.requireAddress()
    this.c.requireExecutor()
    const { tx, bm, existingBmId } = await this.c.beginBmTx(owner)
    const coin = await prepareWalletCoinInput(
      this.c.suiClient,
      tx,
      owner,
      this.c.ids.credCoinType,
      params.amount,
      'Insufficient CRED in the wallet for this deposit.',
    )
    depositCoin(tx, this.c.ids, bm, coin)
    return this.c.finishBmTx(tx, bm, existingBmId, owner)
  }

  /**
   * #4 — deposit items (wallet receipts → hangar) into the balance manager.
   * @throws `AddressRequired` | `ExecutorRequired`; `HubNotFound` (unknown
   *   hub); `ValidationFailed` (non-positive amount); `InsufficientBalance`
   *   when receipts+hangar cannot cover; `CollectionMismatch` when receipts
   *   live in a foreign collection; `CharacterNotFound` when hangar sourcing
   *   is needed but no character resolves; `TransactionFailed` on-chain.
   */
  async depositItems(params: DepositItemsParams): Promise<TxResult> {
    const owner = this.c.requireAddress()
    this.c.requireExecutor()
    const vault = await this.c.indexer.hubVault(params.storageUnitId)
    const ssuObjectId = toSsuObjectId(params.storageUnitId)
    const { tx, bm, existingBmId } = await this.c.beginBmTx(owner)
    for (const item of params.items) {
      await sourceItemsIntoBalanceManager(
        this.c.suiClient,
        tx,
        this.c.ids,
        bm,
        {
          owner,
          ssuObjectId,
          vaultConfigId: vault.vaultConfigId,
          vaultCollectionId: vault.collectionId,
          assetId: BigInt(item.assetId),
          amount: item.amount,
          balanceManagerId: existingBmId,
          deficitMode: false,
        },
      )
    }
    return this.c.finishBmTx(tx, bm, existingBmId, owner)
  }

  /**
   * #13 — withdraw CRED from the balance manager to the wallet. Withdraw-all
   * on an empty balance manager is an on-chain no-op success.
   * @throws `AddressRequired` | `ExecutorRequired`; `BalanceManagerNotFound`
   *   when no trading account exists; `TransactionFailed` on-chain (e.g.
   *   partial amount exceeding the balance).
   */
  async withdrawCurrency(params?: WithdrawCurrencyParams): Promise<TxResult> {
    const owner = this.c.requireAddress()
    const balanceManagerId = await this.c.requireBalanceManagerId(owner)
    const executor = this.c.requireExecutor()
    const tx = new Transaction()
    const bm = tx.object(balanceManagerId)
    const coin =
      params?.amount !== undefined
        ? withdrawCoin(tx, this.c.ids, bm, params.amount)
        : withdrawAllCoin(tx, this.c.ids, bm)
    tx.transferObjects([coin], owner)
    return toTxResult(await executeAndNormalize(executor, tx))
  }

  /**
   * #12 — withdraw items (in full) from the BM into the hangar at a hub.
   * @throws `AddressRequired` | `ExecutorRequired`; `BalanceManagerNotFound`;
   *   `HubNotFound`; `CharacterNotFound` when no on-chain character resolves
   *   (pass `characterId` explicitly); `TransactionFailed` on-chain.
   */
  async withdrawItems(params: WithdrawItemsParams): Promise<TxResult> {
    const owner = this.c.requireAddress()
    const balanceManagerId = await this.c.requireBalanceManagerId(owner)
    const executor = this.c.requireExecutor()
    const vault = await this.c.indexer.hubVault(params.storageUnitId)
    const ssuObjectId = toSsuObjectId(params.storageUnitId)

    let characterId = params.characterId
    if (!characterId) {
      const info = await fetchCharacterInfo(this.c.suiClient, this.c.ids, owner)
      if (!info) {
        throw new TriexClientError(
          TriexError.CharacterNotFound,
          `No on-chain character resolved for ${owner} — pass characterId explicitly.`,
        )
      }
      characterId = info.characterId
    }
    // `is_owner` selects OwnerCap<StorageUnit> vs OwnerCap<Character> in the
    // redeem; true only when the player owns this hub.
    const ssuOwner = await fetchSsuOwnerInfo(
      this.c.suiClient,
      ssuObjectId,
      owner,
    )

    const tx = new Transaction()
    const bm = tx.object(balanceManagerId)
    for (const item of params.items) {
      const balance = withdrawAllMulticoin(
        tx,
        this.c.ids,
        bm,
        vault.collectionId,
        BigInt(item.assetId),
      )
      redeemReceipt(tx, this.c.ids, balance, {
        ssuObjectId,
        characterId,
        vaultConfigId: vault.vaultConfigId,
        collectionId: vault.collectionId,
        isOwner: ssuOwner !== null,
      })
    }
    return toTxResult(await executeAndNormalize(executor, tx))
  }

  /**
   * Claimable proceeds + idle BM items (indexer manifest, lags by seconds).
   * @throws `AddressRequired`; `BalanceManagerNotFound` when no trading
   *   account exists.
   */
  async sweepable(): Promise<Sweepable> {
    const owner = this.c.requireAddress()
    const balanceManagerId = await this.c.requireBalanceManagerId(owner)
    return this.c.indexer.sweepable(balanceManagerId)
  }

  /**
   * Claim settled (post-fill) proceeds from pools into the balance manager.
   * Defaults to every pool the sweepable manifest reports as claimable; the
   * proceeds then show up in `balances.currency()` / BM item balances and can
   * be withdrawn.
   */
  /**
   * @throws `AddressRequired` | `ExecutorRequired`; `BalanceManagerNotFound`;
   *   `ValidationFailed` when nothing is settled to claim;
   *   `TransactionFailed` on-chain.
   */
  async claimSettled(params?: ClaimSettledParams): Promise<TxResult> {
    const owner = this.c.requireAddress()
    const balanceManagerId = await this.c.requireBalanceManagerId(owner)
    const executor = this.c.requireExecutor()

    let pools: { poolId: string; quoteCoinType?: string }[]
    if (params?.poolIds?.length) {
      pools = params.poolIds.map((poolId) => ({ poolId }))
    } else {
      const manifest = await this.c.indexer.sweepable(balanceManagerId)
      pools = manifest.pools
        .filter(
          (p) =>
            p.settled.base > 0n || p.settled.quote > 0n || p.settled.cred > 0n,
        )
        .map((p) => ({
          poolId: p.poolId,
          quoteCoinType: p.quoteAssetId ?? undefined,
        }))
    }
    if (pools.length === 0) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Nothing settled to claim — no pools with claimable balances.',
      )
    }

    const tx = new Transaction()
    const bm = tx.object(balanceManagerId)
    const proof = generateProofAsOwner(tx, this.c.ids, bm)[0]
    for (const pool of pools) {
      withdrawSettledAmounts(tx, this.c.ids, {
        poolId: pool.poolId,
        bm,
        proof,
        quoteCoinType: pool.quoteCoinType,
      })
    }
    return toTxResult(await executeAndNormalize(executor, tx))
  }
}

// ─── balances ─────────────────────────────────────────────────────────────────

class BalancesApi {
  constructor(private readonly c: TriexClient) {}

  /**
   * #2 — hub-scoped ITEM balances (indexer). Defaults `address` to the client
   * address and auto-fills `balanceManagerId` when one resolves. Pass
   * `includeHangar: true` to also resolve the character's hangar slot
   * (`inventoryKey`) on-chain when not supplied explicitly.
   */
  /**
   * @throws `AddressRequired` when no address resolves; `HubNotFound` for an
   *   unknown storage unit.
   */
  async atHub(
    params: BalancesAtHubParams & { includeHangar?: boolean },
  ): Promise<InventoryBalances> {
    const address = params.address ?? this.c.requireAddress()
    const balanceManagerId =
      (await this.c.resolveBalanceManagerId(address)) ?? undefined
    let inventoryKey = params.inventoryKey
    if (!inventoryKey && params.includeHangar) {
      const info = await fetchCharacterInfo(
        this.c.suiClient,
        this.c.ids,
        address,
      )
      inventoryKey = info?.ownerCapId
    }
    return this.c.indexer.inventoryBalances({
      ...params,
      address,
      balanceManagerId,
      inventoryKey,
    })
  }

  /**
   * #3 — CRED balances (wallet + balance manager), read from the FULLNODE:
   * the indexer's inventory endpoint serves items only, and currency values
   * feed write-flow deficit math, which must be head-current (§12).
   */
  /** @throws `AddressRequired`; fullnode transport errors pass through raw. */
  async currency(address?: string): Promise<CurrencyBalances> {
    const owner = this.c.requireAddress(address)
    const [wallet, balanceManagerId] = await Promise.all([
      getWalletCurrencyBalance(
        this.c.suiClient,
        owner,
        this.c.ids.credCoinType,
      ),
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

  /**
   * #7 — trade-hub detail: vault descriptor + location (null if unrevealed).
   * @throws `HubNotFound` for an unknown hub id.
   */
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

  /**
   * #8 — items with open orders at a trade hub.
   * @throws `HubNotFound` for an unknown hub id.
   */
  itemsAtHub(hubId: string): Promise<HubItemsPage> {
    return this.c.indexer.hubItems(hubId)
  }

  /**
   * #8a — resolve an item name to its `assetId`: search item types by
   * partial, case-insensitive name (or exact numeric ID). Each match carries
   * display metadata, mass, and crafting recipes; best matches first.
   */
  searchItems(
    query: string,
    opts?: { limit?: number },
  ): Promise<ItemSearchPage> {
    return this.c.indexer.searchItems(query, opts?.limit)
  }

  /**
   * #9a — resolve the pool for an item at a trade hub (hub → vault collection
   * → pool).
   * @throws `HubNotFound` for an unknown hub; `PoolNotFound` when no market
   *   exists for the pair.
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

  /**
   * #9 — order book for one item at a trade hub. A single indexer call: the
   * gateway resolves the hub's pool and returns the book with pool metadata
   * embedded.
   * @throws `HubNotFound` for an unknown hub; `PoolNotFound` when no market
   *   exists for the pair.
   */
  async orderbook(params: {
    storageUnitId: string
    assetId: string
  }): Promise<HubItemOrderbook> {
    const book = await this.c.indexer.hubItemOrderbook({
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

  /**
   * #10/#11 — pool metadata (decimals, fee rate, hub linkage).
   * @throws `PoolNotFound` for an unknown pool id.
   */
  poolMetadata(poolId: string): Promise<PoolMetadata> {
    return this.c.indexer.poolMetadata(poolId)
  }
}

// ─── orders ──────────────────────────────────────────────────────────────────

class OrdersApi {
  constructor(private readonly c: TriexClient) {}

  /**
   * #10 — place a limit order, atomically: [create BM if missing] → deposit
   * only the deficit (items for sells, CRED+fee for bids; BM balance consumed
   * first) → owner proof → place. Defaults to good-til-cancelled.
   * @throws `ValidationFailed` (non-positive price/quantity);
   *   `AddressRequired` | `ExecutorRequired`; `HubNotFound` | `PoolNotFound`;
   *   `InsufficientBalance` when the wallet/hangar cannot fund the deficit;
   *   `CollectionMismatch` | `CharacterNotFound` (sell funding);
   *   `TransactionFailed` on an on-chain abort (message explains which —
   *   max open orders, expired timestamp, …).
   */
  async limit(params: LimitOrderParams): Promise<TxResult> {
    if (params.quantity <= 0n || params.price <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Limit orders need a positive price and quantity.',
      )
    }
    const owner = this.c.requireAddress()
    this.c.requireExecutor()
    const isBid = params.side === 'buy'

    const vault = await this.c.indexer.hubVault(params.storageUnitId)
    const poolId = await this.requirePool(vault.collectionId, params)
    const { tx, bm, existingBmId } = await this.c.beginBmTx(owner)

    if (!isBid) {
      await sourceItemsIntoBalanceManager(
        this.c.suiClient,
        tx,
        this.c.ids,
        bm,
        {
          owner,
          ssuObjectId: toSsuObjectId(params.storageUnitId),
          vaultConfigId: vault.vaultConfigId,
          vaultCollectionId: vault.collectionId,
          assetId: BigInt(params.assetId),
          amount: params.quantity,
          balanceManagerId: existingBmId,
          deficitMode: true,
        },
      )
    } else {
      let quoteAmount = params.quoteDeposit
      if (quoteAmount === undefined) {
        const meta = await this.c.indexer.poolMetadata(poolId)
        quoteAmount = computeBidQuoteDeposit(
          params.price,
          params.quantity,
          meta.feeRateScaled,
        )
      }
      if (quoteAmount <= 0n) {
        throw new TriexClientError(
          TriexError.ValidationFailed,
          'Invalid quote deposit amount.',
        )
      }
      await this.depositQuoteDeficit(tx, bm, existingBmId, owner, quoteAmount)
    }

    const proof = generateProofAsOwner(tx, this.c.ids, bm)[0]
    placeLimitOrderItem(tx, this.c.ids, {
      poolId,
      bm,
      proof,
      orderType: params.orderType ?? 0,
      selfMatchingOption: params.selfMatchingOption ?? 0,
      price: params.price,
      quantity: params.quantity,
      isBid,
      expireTimestamp: params.expireAt ?? GTC_EXPIRE,
    })
    return this.c.finishBmTx(tx, bm, existingBmId, owner)
  }

  /**
   * #11 — place a market order. Sells fund items like a limit sell; buys
   * REQUIRE `quoteBudget` (worst-case cost incl. fees — see
   * `estimateMarketBuyCost`), topped up with the app's per-fill rounding
   * buffer. Unspent quote stays in the balance manager.
   * @throws as `limit()`, plus `ValidationFailed` when a buy has no
   *   `quoteBudget`; on-chain `TransactionFailed` includes empty-book /
   *   slippage aborts.
   */
  async market(params: MarketOrderParams): Promise<TxResult> {
    if (params.quantity <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Market orders need a positive quantity.',
      )
    }
    const owner = this.c.requireAddress()
    this.c.requireExecutor()
    const isBid = params.side === 'buy'

    const vault = await this.c.indexer.hubVault(params.storageUnitId)
    const poolId = await this.requirePool(vault.collectionId, params)
    const { tx, bm, existingBmId } = await this.c.beginBmTx(owner)

    if (!isBid) {
      await sourceItemsIntoBalanceManager(
        this.c.suiClient,
        tx,
        this.c.ids,
        bm,
        {
          owner,
          ssuObjectId: toSsuObjectId(params.storageUnitId),
          vaultConfigId: vault.vaultConfigId,
          vaultCollectionId: vault.collectionId,
          assetId: BigInt(params.assetId),
          amount: params.quantity,
          balanceManagerId: existingBmId,
          deficitMode: true,
        },
      )
    } else {
      if (!params.quoteBudget || params.quoteBudget <= 0n) {
        throw new TriexClientError(
          TriexError.ValidationFailed,
          'Market buys require `quoteBudget` (see estimateMarketBuyCost).',
        )
      }
      const meta = await this.c.indexer.poolMetadata(poolId)
      const effectiveQuote =
        params.quoteBudget +
        marketBuyRoundingBuffer(params.quantity, meta.feeRateScaled)
      await this.depositQuoteDeficit(
        tx,
        bm,
        existingBmId,
        owner,
        effectiveQuote,
      )
    }

    const proof = generateProofAsOwner(tx, this.c.ids, bm)[0]
    placeMarketOrderItem(tx, this.c.ids, {
      poolId,
      bm,
      proof,
      quantity: params.quantity,
      isBid,
      selfMatchingOption: params.selfMatchingOption ?? 0,
    })
    return this.c.finishBmTx(tx, bm, existingBmId, owner)
  }

  /**
   * Cancel one resting order (order id from `openOrders()` / discovery).
   * @throws `AddressRequired` | `ExecutorRequired`; `BalanceManagerNotFound`;
   *   `HubNotFound` | `PoolNotFound`; `TransactionFailed` — e.g. "Order not
   *   found (EBookOrderNotFound)" when already filled/canceled.
   */
  async cancel(params: CancelOrderParams): Promise<TxResult> {
    const { tx, bm, poolId, execute } = await this.beginCancelTx(params)
    const proof = generateProofAsOwner(tx, this.c.ids, bm)[0]
    cancelOrderItem(tx, this.c.ids, {
      poolId,
      bm,
      proof,
      orderId: BigInt(params.orderId),
    })
    return execute()
  }

  /**
   * Cancel every resting order on one pool (no-op success when none rest).
   * @throws as `cancel()` minus the order-id abort.
   */
  async cancelAll(params: CancelAllOrdersParams): Promise<TxResult> {
    const { tx, bm, poolId, execute } = await this.beginCancelTx(params)
    const proof = generateProofAsOwner(tx, this.c.ids, bm)[0]
    cancelAllOrdersItem(tx, this.c.ids, { poolId, bm, proof })
    return execute()
  }

  /**
   * Reduce a resting order's quantity (must stay below the original).
   * @throws as `cancel()`, plus `ValidationFailed` (non-positive quantity)
   *   and on-chain aborts for invalid new quantities.
   */
  async modify(params: ModifyOrderParams): Promise<TxResult> {
    if (params.newQuantity <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Modified quantity must be positive.',
      )
    }
    const { tx, bm, poolId, execute } = await this.beginCancelTx(params)
    const proof = generateProofAsOwner(tx, this.c.ids, bm)[0]
    modifyOrderItem(tx, this.c.ids, {
      poolId,
      bm,
      proof,
      orderId: BigInt(params.orderId),
      newQuantity: params.newQuantity,
    })
    return execute()
  }

  /**
   * #14 — the player's open orders (empty page when no BM exists yet).
   * @throws `AddressRequired`.
   */
  async openOrders(params?: HistoryPageParams): Promise<OpenOrdersPage> {
    const bm = await this.ownBm()
    if (!bm) return { orders: [], nextCursor: null }
    return this.c.indexer.openOrders(bm, params)
  }

  /**
   * #14 — the player's fills.
   * @throws `AddressRequired`.
   */
  async fills(params?: FillsParams): Promise<FillsPage> {
    const bm = await this.ownBm()
    if (!bm) return { fills: [], nextCursor: null }
    return this.c.indexer.fills(bm, params)
  }

  /**
   * #14 — the player's trades.
   * @throws `AddressRequired`.
   */
  async trades(params?: TradesParams): Promise<TradesPage> {
    const bm = await this.ownBm()
    if (!bm) return { trades: [], nextCursor: null }
    return this.c.indexer.trades(bm, params)
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private ownBm(): Promise<string | null> {
    return this.c.resolveBalanceManagerId(this.c.requireAddress())
  }

  private async requirePool(
    collectionId: string,
    params: { storageUnitId: string; assetId: string },
  ): Promise<string> {
    const poolId = await this.c.indexer.resolvePool({
      collectionId,
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

  /** Deposit only the CRED the BM is short of `target` (BM balance first). */
  private async depositQuoteDeficit(
    tx: Transaction,
    bm: TransactionObjectArgument,
    existingBmId: string | null,
    owner: string,
    target: bigint,
  ): Promise<void> {
    const bmBalance = existingBmId
      ? await getBalanceManagerCurrencyBalance(
          this.c.suiClient,
          this.c.ids,
          existingBmId,
        )
      : 0n
    const deficit = target > bmBalance ? target - bmBalance : 0n
    if (deficit === 0n) return
    const coin = await prepareWalletCoinInput(
      this.c.suiClient,
      tx,
      owner,
      this.c.ids.credCoinType,
      deficit,
      'Insufficient CRED to fund the balance manager for this order.',
    )
    depositCoin(tx, this.c.ids, bm, coin)
  }

  /** Cancels/modifies need an EXISTING balance manager and a resolved pool. */
  private async beginCancelTx(params: {
    storageUnitId: string
    assetId: string
  }): Promise<{
    tx: Transaction
    bm: TransactionObjectArgument
    poolId: string
    execute: () => Promise<TxResult>
  }> {
    const owner = this.c.requireAddress()
    const balanceManagerId = await this.c.requireBalanceManagerId(owner)
    const executor = this.c.requireExecutor()
    const vault = await this.c.indexer.hubVault(params.storageUnitId)
    const poolId = await this.requirePool(vault.collectionId, params)
    const tx = new Transaction()
    const bm = tx.object(balanceManagerId)
    return {
      tx,
      bm,
      poolId,
      execute: async () => toTxResult(await executeAndNormalize(executor, tx)),
    }
  }
}

export type { AccountApi, BalancesApi, MarketApi, OrdersApi }

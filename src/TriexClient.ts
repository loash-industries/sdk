import { Transaction } from '@mysten/sui/transactions'
import type {
  TransactionObjectArgument,
  TransactionResult,
} from '@mysten/sui/transactions'
import type { ClientWithCoreApi } from '@mysten/sui/client'

import { OrgHandle } from './armature/OrgClient'
import { OrgsApi } from './armature/OrgsApi'
import { DEFAULT_INDEXER_URL, resolvePackageIds } from './config'
import { TriexClientError, TriexError } from './errors'
import { executeAndNormalize, findCreatedObject } from './execute'
import type { NormalizedExecution } from './execute'
import {
  prepareWalletCoinInput,
  sourceItemsIntoTradingAccount,
} from './funding'
import {
  GTC_EXPIRE,
  computeBidQuoteDeposit,
  marketBuyRoundingBuffer,
} from './money'
import {
  fetchCharacterInfo,
  fetchSsuOwnerInfo,
  getTradingAccountCurrencyBalance,
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
  newTradingAccount,
  placeLimitOrderItem,
  placeMarketOrderItem,
  redeemReceipt,
  withdrawAllCoin,
  withdrawAllMulticoin,
  withdrawCoin,
  withdrawSettledAmounts,
} from './transactions'
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
  HubEnriched,
  HubItemOrderbook,
  HubItemsPage,
  HubLocationFilters,
  HubLocationPage,
  ItemSearchPage,
  InventoryBalances,
  LimitOrderParams,
  LocationPageParams,
  MarketOrderParams,
  ModifyOrderParams,
  NearbyHub,
  NearbyHubsParams,
  NearbyHubsBySystemParams,
  NearbySystems,
  NearbySystemsParams,
  OpenOrdersPage,
  PackageIds,
  PoolMetadata,
  SolarSystem,
  SolarSystemName,
  SpatialStats,
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
 * High-level, full-featured trading client for Trinary Exchange.
 *
 * Reads go through the indexer (`api.trinary.exchange`, `x-api-key`) except
 * currency balances, which are head-current fullnode reads; writes are built
 * as Sui PTBs and handed to the caller-supplied `executor` to sign. The API
 * surface is grouped: `account`, `balances`, `market`, `orders`, `spatial`,
 * `routing`, `characters`, `world` (and `orgs`).
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
  /** Read-your-writes cache for the resolved trading account id (see §12). */
  private cachedTradingAccountId?: string

  readonly account: AccountApi
  readonly balances: BalancesApi
  readonly market: MarketApi
  readonly orders: OrdersApi
  readonly spatial: SpatialApi
  readonly routing: RoutingApi
  readonly characters: CharactersApi
  readonly world: WorldApi
  /**
   * Organization identity & discovery (Armature). Address-taking methods
   * default to the configured player. Acting AS an organization lives on the
   * handle from `client.org(id)` — see DESIGN-ARMATURE.md §5.1.
   */
  readonly orgs: OrgsApi

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
    this.spatial = new SpatialApi(this)
    this.routing = new RoutingApi(this)
    this.characters = new CharactersApi(this)
    this.world = new WorldApi(this)
    this.orgs = new OrgsApi(this.indexer, (addr) => this.requireAddress(addr))
  }

  /**
   * Open a handle bound to one organization and one seat within it — the entry
   * point for acting AS an organization.
   *
   * `orgIdOrUnitId` may be the top-level organization or any unit in its tree;
   * the whole tree is resolved either way. The seat defaults to the caller's
   * highest-authority board, because that is the one most likely to make an
   * action immediate rather than deferred; `seat` pins a specific unit, and
   * `handle.as(daoId)` switches later.
   *
   * The handle caches the tree and the governance state it reads, so it is
   * worth keeping across a batch of actions and re-opening when you want to
   * observe a config change.
   *
   * @throws `AddressRequired` when no address is configured or passed;
   *   `OrgNotFound` when the id resolves to no organization.
   */
  async org(
    orgIdOrUnitId: string,
    options?: { seat?: string; address?: string },
  ): Promise<OrgHandle> {
    const address = this.requireAddress(options?.address)
    const org = await this.indexer.orgs.get(orgIdOrUnitId)
    return new OrgHandle(
      {
        suiClient: this.suiClient,
        indexer: this.indexer,
        ids: this.ids,
        requireExecutor: () => this.requireExecutor(),
        address,
      },
      org,
      options?.seat,
    )
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
   * Resolve the player's trading account id. On-chain first (authoritative,
   * head-current — avoids the indexer-lag double-create race, DESIGN.md §12),
   * with an in-client cache for read-your-writes.
   * @internal
   */
  async resolveTradingAccountId(address: string): Promise<string | null> {
    if (this.cachedTradingAccountId) return this.cachedTradingAccountId
    const structType = `${this.ids.triex}::trading_account::TradingAccount`
    const core = (this.suiClient as any).core
    const page = await core.listOwnedObjects({
      owner: address,
      type: structType,
      limit: 1,
    })
    const objectId: string | undefined = page?.objects?.[0]?.objectId
    if (objectId) this.cachedTradingAccountId = objectId
    return objectId ?? null
  }

  /** @internal */
  rememberTradingAccountId(id: string): void {
    this.cachedTradingAccountId = id
  }

  /**
   * @internal — start a write PTB against the trading account, creating it in
   * this same transaction when the player has none (the app's exact pattern).
   */
  async beginBmTx(owner: string): Promise<{
    tx: Transaction
    bm: TransactionObjectArgument
    existingBmId: string | null
  }> {
    const existingBmId = await this.resolveTradingAccountId(owner)
    const tx = new Transaction()
    const bm = existingBmId
      ? tx.object(existingBmId)
      : newTradingAccount(tx, this.ids)[0]
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
      const created = findCreatedTradingAccountId(res)
      if (created) this.rememberTradingAccountId(created)
    }
    return toTxResult(res)
  }

  /** @internal — the player's BM id, or a typed error when none exists. */
  async requireTradingAccountId(owner: string): Promise<string> {
    const id = await this.resolveTradingAccountId(owner)
    if (!id) {
      throw new TriexClientError(
        TriexError.TradingAccountNotFound,
        'No trading account exists for this address yet.',
      )
    }
    return id
  }
}

/** @internal — pull the created TradingAccount id out of executor results. */
function findCreatedTradingAccountId(res: NormalizedExecution): string | null {
  return (
    findCreatedObject(res, '::trading_account::TradingAccount')?.objectId ??
    null
  )
}

const MAX_U128 = (1n << 128n) - 1n

/**
 * @internal — order ids are Move `u128` since cycle 7. Accept a bigint or a
 * decimal (or 0x-hex) string, and reject anything outside the u128 range
 * with a typed `ValidationFailed`.
 */
function parseOrderId(orderId: bigint | string): bigint {
  const text = typeof orderId === 'string' ? orderId.trim() : null
  const id =
    text === null
      ? (orderId as bigint)
      : /^(\d+|0x[0-9a-fA-F]+)$/.test(text)
        ? BigInt(text)
        : -1n
  if (id < 0n || id > MAX_U128) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      `Invalid order id ${String(orderId)}: expected a u128 integer.`,
    )
  }
  return id
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
    const id = await this.c.resolveTradingAccountId(owner)
    return id ? { tradingAccountId: id, owner } : null
  }

  /**
   * #1 write — idempotently create the trading account if missing.
   * @throws `AddressRequired` | `ExecutorRequired` on missing config;
   *   `TransactionFailed` on an on-chain abort; `UnexpectedResponse` when the
   *   executor result carries no created-object info.
   */
  async ensure(address?: string): Promise<EnsureAccountResult> {
    const owner = this.c.requireAddress(address)
    const existing = await this.c.resolveTradingAccountId(owner)
    if (existing) return { tradingAccountId: existing, created: false }

    const executor = this.c.requireExecutor()
    const tx = new Transaction()
    const bm = newTradingAccount(tx, this.c.ids)
    tx.transferObjects([bm], owner)
    const res = await executeAndNormalize(executor, tx)

    const id = findCreatedTradingAccountId(res)
    if (!id) {
      throw new TriexClientError(
        TriexError.UnexpectedResponse,
        'Trading account created but no created-object info found — have the executor include effects+objectTypes (v2) or objectChanges (legacy).',
      )
    }
    this.c.rememberTradingAccountId(id)
    return { tradingAccountId: id, created: true }
  }

  /**
   * #5 — deposit CRED from the wallet into the trading account.
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
   * #4 — deposit items (wallet receipts → hangar) into the trading account.
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
      await sourceItemsIntoTradingAccount(
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
          tradingAccountId: existingBmId,
          deficitMode: false,
        },
      )
    }
    return this.c.finishBmTx(tx, bm, existingBmId, owner)
  }

  /**
   * #13 — withdraw CRED from the trading account to the wallet. Withdraw-all
   * on an empty trading account is an on-chain no-op success.
   * @throws `AddressRequired` | `ExecutorRequired`; `TradingAccountNotFound`
   *   when no trading account exists; `TransactionFailed` on-chain (e.g.
   *   partial amount exceeding the balance).
   */
  async withdrawCurrency(params?: WithdrawCurrencyParams): Promise<TxResult> {
    const owner = this.c.requireAddress()
    const tradingAccountId = await this.c.requireTradingAccountId(owner)
    const executor = this.c.requireExecutor()
    const tx = new Transaction()
    const bm = tx.object(tradingAccountId)
    const coin =
      params?.amount !== undefined
        ? withdrawCoin(tx, this.c.ids, bm, params.amount)
        : withdrawAllCoin(tx, this.c.ids, bm)
    tx.transferObjects([coin], owner)
    return toTxResult(await executeAndNormalize(executor, tx))
  }

  /**
   * #12 — withdraw items (in full) from the BM into the hangar at a hub.
   * @throws `AddressRequired` | `ExecutorRequired`; `TradingAccountNotFound`;
   *   `HubNotFound`; `CharacterNotFound` when no on-chain character resolves
   *   (pass `characterId` explicitly); `TransactionFailed` on-chain.
   */
  async withdrawItems(params: WithdrawItemsParams): Promise<TxResult> {
    const owner = this.c.requireAddress()
    const tradingAccountId = await this.c.requireTradingAccountId(owner)
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
    const bm = tx.object(tradingAccountId)
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
   * @throws `AddressRequired`; `TradingAccountNotFound` when no trading
   *   account exists.
   */
  async sweepable(): Promise<Sweepable> {
    const owner = this.c.requireAddress()
    const tradingAccountId = await this.c.requireTradingAccountId(owner)
    return this.c.indexer.sweepable(tradingAccountId)
  }

  /**
   * Who owns these trading accounts — up to 200 trading account ids per call.
   *
   * `owner` comes back TAGGED (`player:<wallet>` or `ou:<org_id>`) rather than
   * as a bare address, because an account can belong to an organization as
   * easily as to a character. This is how a counterparty id from the order
   * book or a fill turns into a name. 50 CU.
   */
  owners(params: {
    tradingAccountIds: string[]
  }): Promise<TradingAccountOwner[]> {
    return this.c.indexer.tradingAccountOwners(params.tradingAccountIds)
  }

  /**
   * Claim settled (post-fill) proceeds from pools into the trading account.
   * Defaults to every pool the sweepable manifest reports as claimable; the
   * proceeds then show up in `balances.currency()` / BM item balances and can
   * be withdrawn.
   */
  /**
   * @throws `AddressRequired` | `ExecutorRequired`; `TradingAccountNotFound`;
   *   `ValidationFailed` when nothing is settled to claim;
   *   `TransactionFailed` on-chain.
   */
  async claimSettled(params?: ClaimSettledParams): Promise<TxResult> {
    const owner = this.c.requireAddress()
    const tradingAccountId = await this.c.requireTradingAccountId(owner)
    const executor = this.c.requireExecutor()

    let pools: { poolId: string; quoteCoinType?: string }[]
    if (params?.poolIds?.length) {
      pools = params.poolIds.map((poolId) => ({ poolId }))
    } else {
      const manifest = await this.c.indexer.sweepable(tradingAccountId)
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
    const bm = tx.object(tradingAccountId)
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
   * address and auto-fills `tradingAccountId` when one resolves. Pass
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
    const tradingAccountId =
      (await this.c.resolveTradingAccountId(address)) ?? undefined
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
      tradingAccountId,
      inventoryKey,
    })
  }

  /**
   * #3 — CRED balances (wallet + trading account), read from the FULLNODE:
   * the indexer's inventory endpoint serves items only, and currency values
   * feed write-flow deficit math, which must be head-current (§12).
   */
  /** @throws `AddressRequired`; fullnode transport errors pass through raw. */
  async currency(address?: string): Promise<CurrencyBalances> {
    const owner = this.c.requireAddress(address)
    const [wallet, tradingAccountId] = await Promise.all([
      getWalletCurrencyBalance(
        this.c.suiClient,
        owner,
        this.c.ids.credCoinType,
      ),
      this.c.resolveTradingAccountId(owner),
    ])
    const tradingAccount = tradingAccountId
      ? await getTradingAccountCurrencyBalance(
          this.c.suiClient,
          this.c.ids,
          tradingAccountId,
        )
      : 0n
    return { wallet, tradingAccount, tradingAccountId }
  }
}

// ─── market ────────────────────────────────────────────────────────────────────

class MarketApi {
  constructor(private readonly c: TriexClient) {}

  /** #6 — discover open orders across the universe (most recent first). 150 CU. */
  discover(filters?: DiscoveryFilters): Promise<DiscoveryResult> {
    return this.c.indexer.discovery(filters)
  }

  /**
   * #7 — trade-hub detail: vault descriptor + location (null if unrevealed).
   * Two reads, 40 CU.
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
   * #8 — items with open orders at a trade hub. 20 CU.
   * @throws `HubNotFound` for an unknown hub id.
   */
  itemsAtHub(hubId: string): Promise<HubItemsPage> {
    return this.c.indexer.hubItems(hubId)
  }

  /**
   * #8a — resolve an item name to its `assetId`: search item types by
   * partial, case-insensitive name (or exact numeric ID). Each match carries
   * display metadata, mass, and crafting recipes; best matches first. 50 CU.
   */
  searchItems(
    query: string,
    opts?: { limit?: number },
  ): Promise<ItemSearchPage> {
    return this.c.indexer.searchItems(query, opts?.limit)
  }

  /**
   * #9a — resolve the pool for an item at a trade hub (hub → vault collection
   * → pool). Two reads, 50 CU.
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
   * embedded. 50 CU.
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
   * #10/#11 — pool metadata (decimals, fee rate, hub linkage). The fee is
   * the pool's fee-class ENTRY tier — an upper bound on any taker's rate.
   * 20 CU.
   * @throws `PoolNotFound` for an unknown pool id.
   */
  poolMetadata(poolId: string): Promise<PoolMetadata> {
    return this.c.indexer.poolMetadata(poolId)
  }

  // ─── Locations ─────────────────────────────────────────────────────────────

  /**
   * Every indexed hub location, cursor-paged — the universe-wide counterpart
   * to `hub()`. Narrow with `solarSystemId`, `tenant`, or `hasVault` (only
   * hubs where trading is actually initialised). 50 CU per page;
   * `iterateHubLocations` walks every page.
   */
  hubLocations(filters?: HubLocationFilters): Promise<HubLocationPage> {
    return this.c.indexer.hubLocations(filters)
  }

  /**
   * Where an item is currently for sale, cursor-paged: the hub locations with
   * open sell orders for `assetId`. Pair with `orderbook()` to price one.
   * 50 CU per page; `iterateItemLocations` walks every page.
   */
  itemLocations(
    assetId: string,
    opts?: LocationPageParams,
  ): Promise<HubLocationPage> {
    return this.c.indexer.itemLocations(assetId, opts)
  }

  /**
   * Hubs within `rangeLy` light years of a hub (default and max 3500),
   * optionally only those with open orders for one item. 50 CU.
   * @throws `HubNotFound` when the origin hub publishes no location — use
   *   `nearbyHubsBySystem()` for a private origin.
   */
  nearbyHubs(params: NearbyHubsParams): Promise<NearbyHub[]> {
    return this.c.indexer.nearbyHubs(params)
  }

  /**
   * The same proximity search centred on a solar system id or name. Prefer a
   * numeric id — a name resolves only once a player has reported it
   * (cycle 7). 50 CU.
   * @throws `SolarSystemNotFound` when a name can't be resolved.
   */
  nearbyHubsBySystem(params: NearbyHubsBySystemParams): Promise<NearbyHub[]> {
    return this.c.indexer.nearbyHubsBySystem(params)
  }

  /**
   * Batch hub detail for a watchlist — location, market count, and last
   * storage activity for up to 200 hubs in one call. Cheaper than a `hub()`
   * per id, at the cost of the vault descriptor and the resolved system name
   * (feed the ids to `solarSystemNames()` for the latter). 50 CU.
   */
  hubsEnriched(params: { hubIds: string[] }): Promise<HubEnriched[]> {
    return this.c.indexer.hubsEnriched(params.hubIds)
  }

  /** Owner wallet for up to 200 assembly (structure) object ids. 50 CU. */
  assemblyOwners(params: { assemblyIds: string[] }): Promise<AssemblyOwner[]> {
    return this.c.indexer.assemblyOwners(params.assemblyIds)
  }

  /** `assemblyOwners()` plus owner character and assembly name. 50 CU. */
  assembliesEnriched(params: {
    assemblyIds: string[]
  }): Promise<AssemblyEnriched[]> {
    return this.c.indexer.assembliesEnriched(params.assemblyIds)
  }

  /**
   * Display names for up to 200 numeric solar system ids. A name is null
   * until a player has reported it (cycle 7) — display the id then. 50 CU.
   */
  solarSystemNames(params: {
    solarSystemIds: number[]
  }): Promise<SolarSystemName[]> {
    return this.c.indexer.solarSystemNames(params.solarSystemIds)
  }

  // ─── Market-wide feeds, prices & rankings ──────────────────────────────────

  /**
   * The latest trades across every item market, newest first — the public
   * tape. At most 50 per page; page with `nextCursor` as `before` (or
   * `iterateRecentTrades`), poll with `after`. Unlike `orders.trades()`,
   * `price` / `quantity` / `feeAmount` are HUMAN-READABLE decimal strings
   * already scaled by the quote decimals, and `feeRateBps` is the fill's own
   * effective taker rate. 50 CU.
   */
  recentTrades(params?: RecentTradesParams): Promise<RecentTradesPage> {
    return this.c.indexer.recentTrades(params)
  }

  /**
   * Display prices for up to 100 items — item-wide, or per hub when
   * `storageUnitIds` is given (one id for all, or one per item). This is the
   * PLAIN market price with no trading fee; `tier` says where it came from
   * (`traded` → `item` → `book` → `estimated` → `unknown`). 50 CU.
   * @throws `ValidationFailed` over 100 items or for a mismatched
   *   `storageUnitIds` length.
   */
  displayPrices(params: DisplayPricesParams): Promise<DisplayPrice[]> {
    return this.c.indexer.displayPrices(params)
  }

  /** Display price (no fee) for one item, optionally at one hub. 20 CU. */
  displayPrice(
    itemId: string,
    opts?: DisplayPriceParams,
  ): Promise<DisplayPrice> {
    return this.c.indexer.displayPrice(itemId, opts)
  }

  /**
   * Fee reserve and open-order liquidity depth for up to 200 hubs (raw
   * integers; vanished hubs omitted). 50 CU.
   */
  hubEconomics(params: { hubIds: string[] }): Promise<HubEconomics[]> {
    return this.c.indexer.hubEconomics(params.hubIds)
  }

  /** Pools ranked by unclaimed fee balance (default 20, max 100). 50 CU. */
  topPoolsByFees(opts?: { limit?: number }): Promise<PoolFees[]> {
    return this.c.indexer.topPoolsByFees(opts?.limit)
  }

  /**
   * Platform-wide statistics: trades and active traders by window, volume
   * per quote currency, top items, organization / shared-storage / pilot
   * totals and 30-day daily series. Cached upstream up to 60 s. 50 CU.
   */
  stats(): Promise<PlatformStats> {
    return this.c.indexer.stats()
  }
}

// ─── spatial ─────────────────────────────────────────────────────────────────

/**
 * The star map: where solar systems are, and what is near what.
 *
 * Separate from `market` on purpose — these reads describe the universe
 * itself, not anything traded in it, and they need no account, no hub, and no
 * signer. Coordinates are metres as decimal strings and distances are light
 * years, because the values run past 2^53 and a double would round them.
 */
class SpatialApi {
  constructor(private readonly c: TriexClient) {}

  /**
   * One solar system by name or numeric id — `"EHK-KH7"` and `"30000142"`
   * both resolve. Names are PLAYER-REPORTED in cycle 7: a name works only
   * once someone has reported it, and `solarSystemName` is null until then;
   * an id always works. 20 CU.
   * @throws `SolarSystemNotFound` when nothing matches.
   */
  system(solarSystem: string): Promise<SolarSystem> {
    return this.c.indexer.solarSystem(solarSystem)
  }

  /**
   * Up to 100 systems in one call, by id or by name (not both). Unmatched
   * identifiers (including unreported names) are omitted, so compare `count`
   * against what you asked for to detect misses. 50 CU.
   * @throws `ValidationFailed` when neither or both selectors are given.
   */
  systems(params: BatchSystemsParams): Promise<BatchSystems> {
    return this.c.indexer.solarSystems(params)
  }

  /**
   * Systems within `radiusLy` light years of another system, nearest first.
   * The origin is excluded. This is the "what is in jump range of here" read.
   * 50 CU.
   * @throws `SolarSystemNotFound` for an unknown origin.
   */
  nearbySystems(params: NearbySystemsParams): Promise<NearbySystems> {
    return this.c.indexer.nearbySystems(params)
  }

  /**
   * The same radius search around an arbitrary point, for an origin that is
   * not itself a system — a ship or structure position read from the chain.
   * 50 CU.
   */
  systemsNearCoordinates(
    params: CoordinateSearchParams,
  ): Promise<CoordinateSearch> {
    return this.c.indexer.systemsNearCoordinates(params)
  }

  /**
   * Name-prefix autocomplete, alphabetical. Returns identifiers only and is
   * served from an in-memory index, so it is much cheaper than `system()` —
   * resolve the chosen suggestion with that. Only player-reported names are
   * indexed, so this is also how to find names `routing` will accept. 20 CU.
   */
  autocompleteSystems(
    query: string,
    opts?: { limit?: number },
  ): Promise<AutocompleteSystems> {
    return this.c.indexer.autocompleteSystems(query, opts?.limit)
  }

  /**
   * How many systems the coordinate index holds, whether it is loaded, and
   * (`knownSolarSystemNames`) how many can currently be looked up by name.
   * 20 CU.
   */
  stats(): Promise<SpatialStats> {
    return this.c.indexer.spatialStats()
  }
}

// ─── routing ─────────────────────────────────────────────────────────────────

/**
 * Travel routes over the stargate network plus jump-drive hops. Origins and
 * destinations are solar system NAMES — and in cycle 7 names are
 * player-reported, so only systems someone has named can be routed between
 * (`spatial.autocompleteSystems()` lists the ones that can). Waypoints
 * through unnamed systems carry a null `solarSystemName`.
 */
class RoutingApi {
  constructor(private readonly c: TriexClient) {}

  /**
   * The optimal route for one mode — `time` (default), `fuel`, or `balanced`
   * (weighted by `gateWeight`). Ship `mass` and `maxJumpRangeLy` shape which
   * hops exist and what they cost. 100 CU.
   * @throws `RouteNotFound` when a name is unknown/unreported or the pair is
   *   unreachable under these parameters (a larger `maxJumpRangeLy` may help).
   */
  route(params: RouteParams): Promise<Route> {
    return this.c.indexer.route(params)
  }

  /**
   * All three modes in one consistent call, to show the jumps-vs-fuel
   * trade-off. Priced as three searches: 300 CU.
   * @throws `RouteNotFound` when no mode connects the pair.
   */
  compare(params: RouteShipParams): Promise<RouteComparison> {
    return this.c.indexer.compareRoutes(params)
  }

  /** Graph coverage and the default jump range the drive edges use. 20 CU. */
  stats(): Promise<RoutingStats> {
    return this.c.indexer.routingStats()
  }
}

// ─── characters ──────────────────────────────────────────────────────────────

/**
 * Player characters and their tribes — who is behind an address, an order or
 * an organization seat. Character names are not unique and a wallet can hold
 * several characters, so the by-name and by-address reads return lists.
 */
class CharactersApi {
  constructor(private readonly c: TriexClient) {}

  /**
   * One character by object id; `enrich` adds the on-chain `ownerCapId` and
   * `assemblyId`. 20 CU.
   * @throws `CharacterNotFound`.
   */
  get(characterId: string, opts?: { enrich?: boolean }): Promise<Character> {
    return this.c.indexer.character(characterId, opts)
  }

  /**
   * Every character a wallet holds, newest first — defaults to the
   * configured player's address. 20 CU.
   * @throws `AddressRequired` when no address is configured or passed.
   */
  async byAddress(
    address?: string,
    opts?: { enrich?: boolean },
  ): Promise<Character[]> {
    return this.c.indexer.charactersByAddress(
      this.c.requireAddress(address),
      opts,
    )
  }

  /** Characters whose name matches EXACTLY, newest first. 20 CU. */
  byName(name: string): Promise<Character[]> {
    return this.c.indexer.charactersByName(name)
  }

  /**
   * Resolve up to 500 wallet addresses to characters with tribe names in one
   * call; every address is echoed back, unresolved ones with null fields.
   * 50 CU.
   * @throws `ValidationFailed` over 500 addresses.
   */
  batch(params: { addresses: string[] }): Promise<CharacterLookup[]> {
    return this.c.indexer.charactersBatch(params.addresses)
  }

  /**
   * A tribe (game-world faction — not an on-chain organization) by id.
   * 20 CU.
   * @throws `TribeNotFound`.
   */
  tribe(tribeId: number): Promise<Tribe> {
    return this.c.indexer.tribe(tribeId)
  }
}

// ─── world ───────────────────────────────────────────────────────────────────

/**
 * Static game reference data: the item catalogue and crafting recipes. It
 * changes only when the game client data does, so fetch once and cache —
 * every call still costs CUs. Ids come back as `assetId` strings, joining
 * onto every market read. (Name search lives on `market.searchItems()`.)
 */
class WorldApi {
  constructor(private readonly c: TriexClient) {}

  /** The full curated item list. 20 CU. */
  items(): Promise<WorldItem[]> {
    return this.c.indexer.worldItems()
  }

  /**
   * Name and group for one item type id. 20 CU.
   * @throws `ItemNotFound`.
   */
  item(assetId: string): Promise<ItemInfo> {
    return this.c.indexer.worldItem(assetId)
  }

  /** Every crafting recipe. 20 CU. */
  recipes(): Promise<Recipe[]> {
    return this.c.indexer.recipes()
  }

  /** The recipes producing one item — `[]` when it is not craftable. 20 CU. */
  recipesFor(productAssetId: string): Promise<Recipe[]> {
    return this.c.indexer.recipesFor(productAssetId)
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
      await sourceItemsIntoTradingAccount(
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
          tradingAccountId: existingBmId,
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
   * buffer. Unspent quote stays in the trading account.
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
      await sourceItemsIntoTradingAccount(
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
          tradingAccountId: existingBmId,
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
   * @throws `AddressRequired` | `ExecutorRequired`; `TradingAccountNotFound`;
   *   `HubNotFound` | `PoolNotFound`; `TransactionFailed` — e.g. "Order not
   *   found (big_vector ENotFound)" when already filled/canceled.
   */
  async cancel(params: CancelOrderParams): Promise<TxResult> {
    const { tx, bm, poolId, execute } = await this.beginCancelTx(params)
    const proof = generateProofAsOwner(tx, this.c.ids, bm)[0]
    cancelOrderItem(tx, this.c.ids, {
      poolId,
      bm,
      proof,
      orderId: parseOrderId(params.orderId),
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
      orderId: parseOrderId(params.orderId),
      newQuantity: params.newQuantity,
    })
    return execute()
  }

  /**
   * #14 — the player's open orders (empty page when no BM exists yet). 30 CU.
   * @throws `AddressRequired`.
   */
  async openOrders(params?: HistoryPageParams): Promise<OpenOrdersPage> {
    const bm = await this.ownBm()
    if (!bm) return { orders: [], nextCursor: null }
    return this.c.indexer.openOrders(bm, params)
  }

  /**
   * #14 — the player's fills. 30 CU.
   * @throws `AddressRequired`.
   */
  async fills(params?: FillsParams): Promise<FillsPage> {
    const bm = await this.ownBm()
    if (!bm) return { fills: [], nextCursor: null }
    return this.c.indexer.fills(bm, params)
  }

  /**
   * #14 — the player's trades. 30 CU.
   * @throws `AddressRequired`.
   */
  async trades(params?: TradesParams): Promise<TradesPage> {
    const bm = await this.ownBm()
    if (!bm) return { trades: [], nextCursor: null }
    return this.c.indexer.trades(bm, params)
  }

  /**
   * Any order on any pool, by id — including orders that have left the
   * book: `status` says `open`, `filled` or `cancelled`, and `fills` is the
   * order's fill history. How a bot learns what became of an order it placed.
   * Not limited to the player's own orders. 30 CU.
   * @throws `OrderNotFound`; `ValidationFailed` for a non-u128 order id.
   */
  get(params: OrderLookupParams): Promise<OrderDetail> {
    return this.c.indexer.poolOrder(params)
  }

  /**
   * One fill by event digest (the `eventDigest` on fills and trades), with
   * BOTH sides' accounts and fees. 30 CU.
   * @throws `FillNotFound`.
   */
  fill(eventDigest: string): Promise<FillDetail> {
    return this.c.indexer.fill(eventDigest)
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private ownBm(): Promise<string | null> {
    return this.c.resolveTradingAccountId(this.c.requireAddress())
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
      ? await getTradingAccountCurrencyBalance(
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
      'Insufficient CRED to fund the trading account for this order.',
    )
    depositCoin(tx, this.c.ids, bm, coin)
  }

  /** Cancels/modifies need an EXISTING trading account and a resolved pool. */
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
    const tradingAccountId = await this.c.requireTradingAccountId(owner)
    const executor = this.c.requireExecutor()
    const vault = await this.c.indexer.hubVault(params.storageUnitId)
    const poolId = await this.requirePool(vault.collectionId, params)
    const tx = new Transaction()
    const bm = tx.object(tradingAccountId)
    return {
      tx,
      bm,
      poolId,
      execute: async () => toTxResult(await executeAndNormalize(executor, tx)),
    }
  }
}

export type {
  AccountApi,
  BalancesApi,
  CharactersApi,
  MarketApi,
  OrdersApi,
  RoutingApi,
  SpatialApi,
  WorldApi,
}
